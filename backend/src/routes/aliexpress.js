import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import express from 'express';
import {
  scrapeAliExpressProduct,
  calculateMlPricing,
  rewriteMercadoLivreTitle,
  computeMlQualityScore,
  findDuplicateInCatalog,
  fetchStoreCatalogLive,
  APPROVED_BRAZIL_STORES,
  getApprovedStoreById,
  buildCompleteCsv,
  buildMercadoLivreBulkCsv,
  DEFAULT_MULTIPLIER,
  MIN_ML_PRICE,
  ML_FEE_RATE,
  ML_TAX_RATE,
  ML_SHIPPING_COST,
  PREMIUM_LISTING_TYPE,
} from '../lib/aliexpress-scraper.js';
import { mlFetch } from '../lib/ml.js';
import { query } from '../lib/db.js';
import {
  applyCostBreakdownToProduct,
  buildCostBreakdown,
  getExactListingFee,
  priceProductWithExactMlFee,
} from '../lib/ml-fees.js';

const router = express.Router();

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const BACKEND_ROOT = path.resolve(__dirname, '../..');
const DATA_DIR = path.join(BACKEND_ROOT, 'data');
const REPO_ROOT = path.resolve(BACKEND_ROOT, '..');
const PRODUCTS_JSON_PATH = path.join(DATA_DIR, 'aliexpress_produtos.json');
const CSSV_CATALOG_PATH = path.join(DATA_DIR, 'cssv_store_catalog.json');
const DROPFACIL_CATALOG_PATH = path.join(DATA_DIR, 'dropfacil_store_catalog.json');
const AUDIT_LOTE2_PATH = path.join(DATA_DIR, 'auditoria_lote2_dropfacil.json');
const CATALOG_STATE_KEY = 'aliexpress_catalog';
const nodeRequire = createRequire(import.meta.url);

let catalogCache = null;
let catalogLoadPromise = null;
let catalogLoadedAt = 0;
let storeCatalogCache = null;
const CATALOG_REFRESH_TTL_MS = 5000;

function applyStoredMlFee(product, price, cost) {
  const percentage = Number(product.taxa_ml_pct ?? ML_FEE_RATE * 100);
  const fixedFee = Number(product.taxa_ml_fixa_brl || 0);
  const fee = {
    percentage: percentage / 100,
    fixed_fee: fixedFee,
    sale_fee_amount: Number(
      (Number(price) * (percentage / 100) + fixedFee).toFixed(2)
    ),
    listing_fee_amount: Number(product.custo_listagem_ml_brl || 0),
    listing_type_id: product.taxa_ml_listing_type_id || PREMIUM_LISTING_TYPE,
    listing_type_name: product.taxa_ml_listing_type_name || 'Premium',
    source: product.taxa_ml_fonte || 'stored',
    queried_at: product.taxa_ml_calculada_em || new Date().toISOString(),
  };
  const breakdown = buildCostBreakdown({
    price,
    cost,
    fee,
    shippingCost: ML_SHIPPING_COST,
    taxRate: ML_TAX_RATE,
  });
  return applyCostBreakdownToProduct(product, breakdown, ML_TAX_RATE);
}

function readBundledJson(kind) {
  try {
    if (kind === 'products') {
      return nodeRequire('../../data/aliexpress_produtos.json');
    }
    if (kind === 'cssv') {
      return nodeRequire('../../data/cssv_store_catalog.json');
    }
    if (kind === 'dropfacil') {
      return nodeRequire('../../data/dropfacil_store_catalog.json');
    }
    if (kind === 'auditoria') {
      return nodeRequire('../../data/auditoria_lote2_dropfacil.json');
    }
  } catch {}
  return null;
}

function readJsonFile(filePath, fallback) {
  try {
    if (fs.existsSync(filePath)) {
      return JSON.parse(fs.readFileSync(filePath, 'utf8'));
    }
  } catch (err) {
    console.error('[aliexpress] erro ao ler arquivo local:', err.message);
  }
  return fallback;
}

function loadStoreCatalogMap() {
  if (storeCatalogCache) return storeCatalogCache;
  storeCatalogCache = new Map();
  const sources = [
    [readBundledJson('cssv') || readJsonFile(CSSV_CATALOG_PATH, []), '1105400522'],
    [readBundledJson('dropfacil') || readJsonFile(DROPFACIL_CATALOG_PATH, []), '1104933528'],
  ];
  for (const [items, storeId] of sources) {
    try {
      for (const item of items) {
        if (item?.id) {
          storeCatalogCache.set(String(item.id), { item, storeId });
        }
      }
    } catch {}
  }
  return storeCatalogCache;
}

function readSeedCatalog() {
  const bundled = readBundledJson('products');
  if (Array.isArray(bundled)) return bundled;
  const fromFile = readJsonFile(PRODUCTS_JSON_PATH, []);
  return Array.isArray(fromFile) ? fromFile : [];
}

function readAuditLote2() {
  const bundled = readBundledJson('auditoria');
  if (bundled) return bundled;
  return readJsonFile(AUDIT_LOTE2_PATH, null);
}

async function saveCatalogToDb(products) {
  await query(
    `INSERT INTO app_state (key, value, updated_at)
     VALUES ($1, $2::jsonb, NOW())
     ON CONFLICT (key) DO UPDATE SET
       value = EXCLUDED.value,
       updated_at = NOW()`,
    [CATALOG_STATE_KEY, JSON.stringify(products)]
  );
}

async function readCatalogFromDb() {
  try {
    const { rows } = await query('SELECT value FROM app_state WHERE key = $1', [
      CATALOG_STATE_KEY,
    ]);
    const value = rows[0]?.value;
    if (!value) return { ok: true, products: null };
    const parsed = typeof value === 'string' ? JSON.parse(value) : value;
    return { ok: true, products: Array.isArray(parsed) ? parsed : null };
  } catch (err) {
    console.error('[aliexpress] falha ao ler catalogo do banco:', err.message);
    return { ok: false, products: null };
  }
}

export async function ensureAliExpressCatalog() {
  if (catalogCache) return catalogCache;
  if (!catalogLoadPromise) {
    catalogLoadPromise = (async () => {
      const fromDb = await readCatalogFromDb();
      let products = fromDb.products;
      if (!products) {
        products = readSeedCatalog();
        if (fromDb.ok && products.length > 0) {
          try {
            await saveCatalogToDb(products);
          } catch (err) {
            console.error('[aliexpress] falha ao semear catalogo no banco:', err.message);
          }
        }
      }
      catalogCache = products;
      catalogLoadedAt = Date.now();
      return catalogCache;
    })().catch((err) => {
      console.error('[aliexpress] falha ao carregar catalogo:', err.message);
      catalogCache = readSeedCatalog();
      catalogLoadedAt = Date.now();
      return catalogCache;
    });
  }
  return catalogLoadPromise;
}

export async function refreshAliExpressCatalog() {
  await ensureAliExpressCatalog();
  if (Date.now() - catalogLoadedAt < CATALOG_REFRESH_TTL_MS) return catalogCache;
  const fromDb = await readCatalogFromDb();
  if (fromDb.ok && fromDb.products) {
    catalogCache = fromDb.products;
  }
  catalogLoadedAt = Date.now();
  return catalogCache;
}

export function getAliExpressCatalog() {
  if (catalogCache) return catalogCache;
  catalogCache = readSeedCatalog();
  return catalogCache;
}

function nextInternalCode(products) {
  let maxNum = 0;
  for (const p of products) {
    const num = parseInt(String(p.codigo_interno || '').replace(/\D/g, ''), 10);
    if (Number.isFinite(num) && num > maxNum) maxNum = num;
  }
  return `AE-${String(maxNum + 1).padStart(4, '0')}`;
}

const ML_MIN_INTERNAL_SCORE = 85;
const ML_MIN_IMAGES = 4;
const ML_MIN_PRICE = 79.9;
const ML_REVIEW_CHECKS = ['categoria', 'fotos', 'titulo_fotos', 'preco_frete'];

export function getProductImages(product) {
  const fromArray = Array.isArray(product?.imagens) ? product.imagens : [];
  const fromFields = [
    product?.imagem_1,
    product?.imagem_2,
    product?.imagem_3,
    product?.imagem_4,
    product?.imagem_5,
    product?.imagem_6,
  ];
  return [...new Set([...fromArray, ...fromFields].map((u) => String(u || '').trim()).filter(Boolean))];
}

export function getInternalQualityScore(product) {
  return typeof product?.qualidade_score === 'number'
    ? product.qualidade_score
    : computeMlQualityScore(product || {}).score;
}

export function buildMlReviewFingerprint(product, categoryOverride = null) {
  const payload = {
    sku: product?.sku || null,
    titulo_ml: product?.titulo_ml || null,
    imagens: getProductImages(product),
    preco_venda_ml_sugerido: Number(product?.preco_venda_ml_sugerido) || 0,
    categoria_ml_id: categoryOverride || product?.categoria_ml_id || null,
    marca: product?.marca || null,
    modelo: product?.modelo || null,
    estoque_disponivel: Number(product?.estoque_disponivel) || 0,
  };
  return crypto.createHash('sha256').update(JSON.stringify(payload)).digest('hex');
}

export function getMlReviewGate(product) {
  const review = product?.ml_revisao || null;
  const preflight = product?.ml_preflight || null;
  const score = getInternalQualityScore(product);
  const images = getProductImages(product);
  const price = Number(product?.preco_venda_ml_sugerido) || 0;
  const missing = [];
  const categoryId = preflight?.categoria_ml_id || review?.categoria_ml_id || null;
  const currentFingerprint = buildMlReviewFingerprint(product, categoryId);

  if (!preflight?.ok) {
    missing.push('pré-publicação automática aprovada');
  } else if (preflight.fingerprint !== currentFingerprint) {
    missing.push('pré-publicação desatualizada após alteração do produto');
  }

  if (!review?.aprovado) {
    missing.push('revisão manual aprovada');
  } else {
    if (review.fingerprint !== currentFingerprint) {
      missing.push('revisão manual desatualizada após alteração do produto');
    }
    if (!/^MLB\d+$/i.test(String(categoryId || ''))) {
      missing.push('categoria folha MLB confirmada');
    }
    const pendingChecks = ML_REVIEW_CHECKS.filter((key) => review.checks?.[key] !== true);
    if (pendingChecks.length) {
      missing.push(`checklist obrigatório (${pendingChecks.join(', ')})`);
    }
  }

  if (score < ML_MIN_INTERNAL_SCORE) {
    missing.push(`score interno ≥${ML_MIN_INTERNAL_SCORE} (atual ${score})`);
  }
  if (images.length < ML_MIN_IMAGES) {
    missing.push(`mínimo de ${ML_MIN_IMAGES} imagens (atual ${images.length})`);
  }
  if (price < ML_MIN_PRICE) {
    missing.push(`preço ≥ R$ ${ML_MIN_PRICE.toFixed(2)}`);
  }

  return {
    ok: missing.length === 0,
    missing,
    score,
    imagens: images.length,
    preco: price,
    preflight_ok: Boolean(preflight?.ok),
    preflight_em: preflight?.checked_at || null,
    aprovado_em: review?.aprovado_em || null,
    categoria_ml_id: categoryId,
  };
}

function writeLocalSnapshot(products) {
  try {
    const dadosDir = path.join(REPO_ROOT, 'dados');
    const frontendPublicDir = path.join(REPO_ROOT, 'frontend/public');
    const rootPublicDir = path.join(REPO_ROOT, 'public');
    const dirs = [DATA_DIR, dadosDir, frontendPublicDir, rootPublicDir];
    for (const dir of dirs) {
      fs.mkdirSync(dir, { recursive: true });
    }

    const completeCsv = buildCompleteCsv(products);
    const bulkCsv = buildMercadoLivreBulkCsv(products);
    const dropfacilOnly = products.filter(
      (p) =>
        String(p.fornecedor_loja_id) === '1104933528' ||
        /DropFacil/i.test(String(p.fornecedor_nome || ''))
    );
    const dropCompleteCsv = buildCompleteCsv(dropfacilOnly);
    const dropBulkCsv = buildMercadoLivreBulkCsv(dropfacilOnly);

    for (const dir of [DATA_DIR, dadosDir]) {
      fs.writeFileSync(
        path.join(dir, 'aliexpress_produtos.json'),
        JSON.stringify(products, null, 2),
        'utf8'
      );
    }

    for (const dir of dirs) {
      fs.writeFileSync(path.join(dir, 'mercadolivre_aliexpress_completo.csv'), completeCsv, 'utf8');
      fs.writeFileSync(path.join(dir, 'mercadolivre_planilha_publicacao.csv'), bulkCsv, 'utf8');
      if (dropfacilOnly.length > 0) {
        fs.writeFileSync(
          path.join(dir, 'mercadolivre_lote2_dropfacil_completo.csv'),
          dropCompleteCsv,
          'utf8'
        );
        fs.writeFileSync(
          path.join(dir, 'mercadolivre_lote2_dropfacil_planilha.csv'),
          dropBulkCsv,
          'utf8'
        );
      }
    }
  } catch (err) {
    console.error('[aliexpress] falha ao persistir arquivos locais:', err.message);
  }
}

async function persistCatalog(products) {
  catalogCache = products;
  catalogLoadedAt = Date.now();
  let savedInDb = false;
  try {
    await saveCatalogToDb(products);
    savedInDb = true;
  } catch (err) {
    console.error('[aliexpress] falha ao persistir catalogo no banco:', err.message);
  }
  if (!process.env.VERCEL) {
    writeLocalSnapshot(products);
  }
  return savedInDb;
}

export function findAliExpressByIdentifier(identifier) {
  if (!identifier) return null;
  const needle = String(identifier).trim().toUpperCase();
  const products = getAliExpressCatalog();
  return (
    products.find(
      (p) =>
        String(p.sku || '').toUpperCase() === needle ||
        String(p.codigo_interno || '').toUpperCase() === needle ||
        String(p.aliexpress_item_id || '') === needle ||
        needle.includes(String(p.aliexpress_item_id || '___'))
    ) || null
  );
}

function summarizeCatalog(products) {
  const total = products.length;
  if (!total) {
    return {
      total: 0,
      com_4_imagens: 0,
      acima_85_qualidade: 0,
      qualidade_media_pct: 0,
      prontos_para_subir: 0,
      publicados_ml: 0,
      revisao_aprovada: 0,
      revisao_pendente: 0,
      piso_79_90_count: 0,
      custo_medio: 0,
      custo_produto_medio: 0,
      custo_total_medio: 0,
      comissao_media: 0,
      imposto_medio: 0,
      frete_medio: 0,
      venda_media: 0,
      lucro_liquido_medio: 0,
      margem_liquida_pct: 0,
      roi_medio_pct: 0,
      roi_medio_simples_pct: 0,
      venda_total: 0,
      custo_produto_total: 0,
      comissao_total: 0,
      imposto_total: 0,
      frete_total: 0,
      custo_total_operacao: 0,
      lucro_liquido_total: 0,
      categorias: [],
      fornecedores: [],
      lotes: [],
      fornecedores_unicos: 0,
    };
  }

  const com4 = products.filter((p) => (p.qtd_imagens || p.imagens?.length || 0) >= 4).length;
  const withScore = products.map((p) =>
    typeof p.qualidade_score === 'number' ? p.qualidade_score : computeMlQualityScore(p).score
  );
  const acima85 = withScore.filter((s) => s >= 85).length;
  const avgQual = Number((withScore.reduce((a, b) => a + b, 0) / total).toFixed(1));
  const prontosCount = products.filter(
    (p) => !p.ml_item_id && p.status_anuncio !== 'verificar_estoque_fornecedor'
  ).length;
  const publicadosCount = products.filter((p) => Boolean(p.ml_item_id)).length;
  const revisaoAprovada = products.filter((p) => getMlReviewGate(p).ok).length;
  const revisaoPendente = products.filter((p) => !p.ml_item_id && !getMlReviewGate(p).ok).length;
  const pisoCount = products.filter(
    (p) => p.piso_79_90_aplicado || Number(p.preco_venda_ml_sugerido) <= 79.91
  ).length;

  const productCostOf = (p) =>
    Number(p.custo_produto_brl ?? p.detalhamento_custos?.custo_produto_brl ?? p.preco_custo_aliexpress_brl) || 0;
  const sumCost = products.reduce((acc, p) => acc + productCostOf(p), 0);
  const sumPrice = products.reduce((acc, p) => acc + (Number(p.preco_venda_ml_sugerido) || 0), 0);
  const sumProfit = products.reduce((acc, p) => acc + (Number(p.lucro_liquido_estimado_brl) || 0), 0);
  const sumRoi = products.reduce((acc, p) => acc + (Number(p.roi_sobre_custo_pct) || 0), 0);
  const sumFees = products.reduce(
    (acc, p) =>
      acc + (Number(p.taxa_ml_estimada_brl) || 0) + (Number(p.custo_listagem_ml_brl) || 0),
    0
  );
  const sumTaxes = products.reduce((acc, p) => acc + (Number(p.imposto_estimado_brl) || 0), 0);
  const sumShipping = products.reduce((acc, p) => acc + (Number(p.custo_frete_vendedor_brl) || 0), 0);
  const sumTotalCost = products.reduce((acc, p) => {
    const fallback = productCostOf(p) + (Number(p.taxa_ml_estimada_brl) || 0) + (Number(p.imposto_estimado_brl) || 0) + (Number(p.custo_frete_vendedor_brl) || 0);
    return acc + (Number(p.custo_total_operacao_brl) || fallback);
  }, 0);
  const categorias = [...new Set(products.map((p) => p.categoria_ml).filter(Boolean))].sort();

  const supplierCounts = new Map();
  const loteCounts = new Map();
  for (const p of products) {
    const sName = p.fornecedor_nome || 'AliExpress Brasil';
    supplierCounts.set(sName, (supplierCounts.get(sName) || 0) + 1);
    const lName = p.lote_origem || `Lote - ${sName}`;
    loteCounts.set(lName, (loteCounts.get(lName) || 0) + 1);
  }

  return {
    total,
    com_4_imagens: com4,
    acima_85_qualidade: acima85,
    qualidade_media_pct: avgQual,
    prontos_para_subir: prontosCount,
    publicados_ml: publicadosCount,
    revisao_aprovada: revisaoAprovada,
    revisao_pendente: revisaoPendente,
    piso_79_90_count: pisoCount,
    custo_medio: Number((sumCost / total).toFixed(2)),
    custo_produto_medio: Number((sumCost / total).toFixed(2)),
    custo_total_medio: Number((sumTotalCost / total).toFixed(2)),
    comissao_media: Number((sumFees / total).toFixed(2)),
    imposto_medio: Number((sumTaxes / total).toFixed(2)),
    frete_medio: Number((sumShipping / total).toFixed(2)),
    venda_media: Number((sumPrice / total).toFixed(2)),
    lucro_liquido_medio: Number((sumProfit / total).toFixed(2)),
    margem_liquida_pct: Number((sumPrice > 0 ? (sumProfit / sumPrice) * 100 : 0).toFixed(1)),
    roi_medio_pct: Number((sumCost > 0 ? (sumProfit / sumCost) * 100 : 0).toFixed(1)),
    roi_medio_simples_pct: Number((sumRoi / total).toFixed(1)),
    venda_total: Number(sumPrice.toFixed(2)),
    custo_produto_total: Number(sumCost.toFixed(2)),
    comissao_total: Number(sumFees.toFixed(2)),
    imposto_total: Number(sumTaxes.toFixed(2)),
    frete_total: Number(sumShipping.toFixed(2)),
    custo_total_operacao: Number(sumTotalCost.toFixed(2)),
    lucro_liquido_total: Number(sumProfit.toFixed(2)),
    categorias,
    fornecedores: [...supplierCounts.entries()].map(([nome, qtd]) => ({ nome, qtd })),
    lotes: [...loteCounts.entries()].map(([nome, qtd]) => ({ nome, qtd })),
    fornecedores_unicos: supplierCounts.size,
  };
}

function filterProductsByQuery(all, queryParams) {
  const q = String(queryParams.q || '').trim().toLowerCase();
  const categoria = String(queryParams.categoria || '').trim();
  const fornecedor = String(queryParams.fornecedor || '').trim();
  const lote = String(queryParams.lote || '').trim();
  const filtroPiso = String(queryParams.piso || '').trim();
  const status = String(queryParams.status || '').trim();

  return all.filter((item) => {
    if (categoria && item.categoria_ml !== categoria) return false;
    if (
      fornecedor &&
      item.fornecedor_nome !== fornecedor &&
      String(item.fornecedor_loja_id) !== fornecedor
    ) {
      return false;
    }
    if (lote && (item.lote_origem || `Lote - ${item.fornecedor_nome}`) !== lote) return false;
    if (filtroPiso === 'piso_79' && Number(item.preco_venda_ml_sugerido) > 79.91) return false;
    if (filtroPiso === 'acima_79' && Number(item.preco_venda_ml_sugerido) <= 79.91) return false;
    if (status === 'prontos' && (item.ml_item_id || item.status_anuncio === 'verificar_estoque_fornecedor')) {
      return false;
    }
    if (status === 'publicados' && !item.ml_item_id) return false;
    if (q) {
      const hay = `${item.sku} ${item.codigo_interno} ${item.aliexpress_item_id} ${item.titulo_ml} ${item.titulo_aliexpress_original} ${item.fornecedor_nome} ${item.categoria_ml} ${item.lote_origem || ''}`.toLowerCase();
      if (!hay.includes(q)) return false;
    }
    return true;
  });
}

router.get('/produtos', (req, res) => {
  const all = getAliExpressCatalog();
  const filtered = filterProductsByQuery(all, req.query);
  const auditoriaLote2 = readAuditLote2();

  res.json({
    resumo: summarizeCatalog(all),
    auditoria_lote2: auditoriaLote2,
    configuracao_frete: {
      modalidade: 'Vou enviar por minha conta',
      cobertura: 'Todo o Brasil (Sudeste, Sul, Nordeste, Centro-Oeste e Norte)',
      custo_envio_brl: 0,
      prazo_entrega: '5 a 10 dias',
      etiquetas: false,
      comprador_cnpj: 'MeLi Max Shop (CNPJ)',
    },
    configuracao_custos: {
      tipo_anuncio: 'Premium (gold_pro)',
      listing_type_id: PREMIUM_LISTING_TYPE,
      taxa_ml_por_categoria: true,
      taxa_ml_fallback_pct: Number((ML_FEE_RATE * 100).toFixed(2)),
      imposto_pct: Number((ML_TAX_RATE * 100).toFixed(2)),
      frete_vendedor_brl: ML_SHIPPING_COST,
      piso_preco_brl: MIN_ML_PRICE,
      multiplicador_padrao: DEFAULT_MULTIPLIER,
    },
    total_filtrado: filtered.length,
    produtos: filtered,
  });
});

router.get('/taxa-ml', async (req, res, next) => {
  try {
    const categoryId = req.query.categoria_id || req.query.category_id;
    const price = Number(req.query.preco ?? req.query.price);
    const cost = Math.max(Number(req.query.custo ?? req.query.cost) || 0, 0);
    if (!categoryId || !(price > 0)) {
      return res.status(400).json({
        error: 'Informe categoria_id e preco para consultar a taxa real do Mercado Livre.',
      });
    }
    const fee = await getExactListingFee({ categoryId, price });
    const breakdown = buildCostBreakdown({
      price,
      cost,
      fee,
      shippingCost: ML_SHIPPING_COST,
      taxRate: ML_TAX_RATE,
    });
    res.json({ ok: true, fee, breakdown });
  } catch (err) {
    next(err);
  }
});

router.get('/fornecedores-homologados', (_req, res) => {
  const all = getAliExpressCatalog();
  const list = APPROVED_BRAZIL_STORES.map((store) => {
    const count = all.filter(
      (p) =>
        String(p.fornecedor_loja_id) === String(store.storeId) ||
        String(p.fornecedor_nome).toLowerCase() === String(store.storeName).toLowerCase()
    ).length;
    return {
      ...store,
      produtos_na_base: count,
    };
  });

  res.json({
    regra_ouro:
      'Somente entram produtos já no Brasil e com Frete Totalmente Grátis confirmado, bloqueando automaticamente produtos repetidos.',
    total_fornecedores: list.length,
    fornecedores: list,
  });
});

router.post('/importar-loja', async (req, res, next) => {
  try {
    const rawStore = String(req.body?.storeId || req.body?.url || '').trim();
    const storeIdMatch = rawStore.match(/\/store\/(\d{6,14})/) || rawStore.match(/^(\d{6,14})$/);
    const storeId = storeIdMatch ? storeIdMatch[1] : '';
    if (!storeId) {
      return res
        .status(400)
        .json({ error: 'Informe um ID ou link válido de loja AliExpress Brasil (ex: 1104933528).' });
    }

    const limite = Math.min(Math.max(Number(req.body?.limite) || 20, 1), 60);
    const multiplicador = Math.max(Number(req.body?.multiplicador) || DEFAULT_MULTIPLIER, 1.5);

    const { storeMeta, allItems, freeShippingItems, paidShippingItems } =
      await fetchStoreCatalogLive(storeId, { maxPages: 8 });

    const currentCatalog = getAliExpressCatalog();
    const workingCatalog = [...currentCatalog];
    const candidatesToScrape = [];
    let skippedDuplicates = 0;

    for (const entry of freeShippingItems) {
      if (candidatesToScrape.length >= limite) break;
      const previewTitle = rewriteMercadoLivreTitle(entry.subject || entry.seoTitle || '');
      const dup = findDuplicateInCatalog(previewTitle, entry.id, workingCatalog, 0.66);
      if (dup) {
        skippedDuplicates += 1;
        continue;
      }
      candidatesToScrape.push(entry);
      workingCatalog.push({
        sku: `TEMP-${entry.id}`,
        aliexpress_item_id: String(entry.id),
        titulo_ml: previewTitle,
      });
    }

    const addedProducts = [];
    let runningList = [...currentCatalog];

    // Scrape in small parallel chunks of 6 for speed and reliability
    for (let i = 0; i < candidatesToScrape.length; i += 6) {
      const slice = candidatesToScrape.slice(i, i + 6);
      const codes = slice.map((_, idx) => {
        const tempWithPlaceholders = [
          ...runningList,
          ...Array.from({ length: idx }, (__, k) => ({ codigo_interno: `AE-${9000 + k}` })),
        ];
        return idx === 0
          ? nextInternalCode(runningList)
          : `AE-${String(
              parseInt(nextInternalCode(runningList).replace(/\D/g, ''), 10) + idx
            ).padStart(4, '0')}`;
      });

      const scrapedChunk = await Promise.all(
        slice.map((entry, idx) =>
          scrapeAliExpressProduct({
            urlOrId: `https://pt.aliexpress.com/item/${entry.id}.html`,
            internalCode: codes[idx],
            knownCostBrl: entry.promotionPiecePriceMoney?.amount || null,
            knownOrigPriceBrl: entry.piecePriceMoney?.amount || null,
            multiplier: multiplicador,
            minPrice: MIN_ML_PRICE,
            storeEntry: entry,
            storeMeta,
            loteOrigem: `Mineração - ${storeMeta.storeName}`,
            skipLivePdp: true,
          })
        )
      );

      const pricedChunk = await Promise.all(
        scrapedChunk.map((product) =>
          priceProductWithExactMlFee({
            product,
            price: product.preco_venda_ml_sugerido,
            cost: product.preco_custo_aliexpress_brl,
          }).then((result) => result.product)
        )
      );

      runningList = [...runningList, ...pricedChunk];
      addedProducts.push(...pricedChunk);
    }

    if (addedProducts.length > 0) {
      await persistCatalog(runningList);
    }

    res.json({
      ok: true,
      loja: storeMeta.storeName,
      storeId: storeMeta.storeId,
      encontrados_na_loja: allItems.length,
      com_frete_gratis_brasil: freeShippingItems.length,
      descartados_frete_pago: paidShippingItems.length,
      descartados_duplicados: skippedDuplicates,
      adicionados: addedProducts.length,
      total_catalogo: runningList.length,
      novos_produtos: addedProducts,
    });
  } catch (err) {
    next(err);
  }
});

router.get('/produtos/:sku', (req, res) => {
  const found = findAliExpressByIdentifier(req.params.sku);
  if (!found) {
    return res.status(404).json({ error: 'Produto AliExpress não encontrado pelo SKU/ID informado.' });
  }
  res.json(found);
});

router.patch('/produtos/:sku', async (req, res, next) => {
  try {
  const products = getAliExpressCatalog();
  const needle = String(req.params.sku || '').trim().toUpperCase();
  const idx = products.findIndex(
    (p) =>
      String(p.sku || '').toUpperCase() === needle ||
      String(p.codigo_interno || '').toUpperCase() === needle ||
      String(p.aliexpress_item_id || '') === needle
  );

  if (idx === -1) {
    return res.status(404).json({ error: 'Produto não encontrado para edição.' });
  }

  const current = { ...products[idx] };
  const body = req.body || {};
  const reviewCategoryId = current.ml_preflight?.categoria_ml_id || null;
  const beforeFingerprint = buildMlReviewFingerprint(current, reviewCategoryId);

  if (typeof body.titulo_ml === 'string' && body.titulo_ml.trim()) {
    current.titulo_ml = body.titulo_ml.trim().slice(0, 60);
  }
  if (typeof body.descricao_ml_otimizada === 'string' && body.descricao_ml_otimizada.trim()) {
    current.descricao_ml_otimizada = body.descricao_ml_otimizada.trim();
  }
  if (typeof body.marca === 'string') current.marca = body.marca.trim() || 'Genérica';
  if (typeof body.modelo === 'string') current.modelo = body.modelo.trim() || 'Padrão';
  if (typeof body.categoria_ml === 'string' && body.categoria_ml.trim()) {
    current.categoria_ml = body.categoria_ml.trim();
  }
  if (body.estoque_disponivel != null) {
    current.estoque_disponivel = Math.max(Number(body.estoque_disponivel) || 0, 0);
  }
  if (typeof body.status_anuncio === 'string') {
    current.status_anuncio = body.status_anuncio.trim();
  }
  if (Array.isArray(body.imagens) && body.imagens.filter(Boolean).length >= 1) {
    const imgs = body.imagens.map((u) => String(u).trim()).filter(Boolean);
    current.imagens = imgs;
    current.imagem_1 = imgs[0] || '';
    current.imagem_2 = imgs[1] || '';
    current.imagem_3 = imgs[2] || '';
    current.imagem_4 = imgs[3] || '';
    current.imagem_5 = imgs[4] || '';
    current.imagem_6 = imgs[5] || '';
    current.urls_imagens = imgs.join(' | ');
    current.qtd_imagens = imgs.length;
  }

  const nextCost =
    body.preco_custo_aliexpress_brl != null
      ? Number(body.preco_custo_aliexpress_brl)
      : Number(current.preco_custo_aliexpress_brl);
  const nextMult =
    body.multiplicador_venda != null
      ? Number(body.multiplicador_venda)
      : Number(current.multiplicador_venda) || DEFAULT_MULTIPLIER;
  const pricing = calculateMlPricing(nextCost, nextMult, MIN_ML_PRICE);

  current.preco_custo_aliexpress_brl = pricing.cost;
  current.multiplicador_venda = pricing.multiplier;
  current.preco_calculado_2_8x_brl = pricing.calculated;

  const manualPrice =
    body.preco_venda_manual_brl != null &&
    Number(body.preco_venda_manual_brl) >= MIN_ML_PRICE
      ? Number(Number(body.preco_venda_manual_brl).toFixed(2))
      : null;
  const salePrice = manualPrice ?? pricing.finalPrice;
  const priced = await priceProductWithExactMlFee({
    product: current,
    price: salePrice,
    cost: pricing.cost,
    shippingCost: ML_SHIPPING_COST,
    taxRate: ML_TAX_RATE,
  });
  Object.assign(current, priced.product);
  current.preco_venda_ml_sugerido = salePrice;
  current.piso_79_90_aplicado =
    manualPrice != null ? salePrice > pricing.calculated : pricing.pisoAplicado;

  const q = computeMlQualityScore(current);
  current.qualidade_score = q.score;
  current.qualidade_pronto_85 = q.ready;
  current.qualidade_anuncio_meta = `${q.score}% (score interno; não é nota do ML)`;
  current.atualizado_em = new Date().toISOString();

  if (buildMlReviewFingerprint(current, reviewCategoryId) !== beforeFingerprint) {
    current.ml_preflight = null;
    current.ml_revisao = null;
  }

  products[idx] = current;
  await persistCatalog(products);

  res.json({ ok: true, produto: current });
  } catch (err) {
    next(err);
  }
});

router.post('/scrape', async (req, res, next) => {
  try {
    const url = String(req.body?.url || '').trim();
    if (!url) {
      return res.status(400).json({ error: 'Informe o link ou ID do produto no AliExpress.' });
    }
    const custoManual = req.body?.custo_brl ? Number(req.body.custo_brl) : null;
    const multiplicador = req.body?.multiplicador ? Number(req.body.multiplicador) : DEFAULT_MULTIPLIER;
    const salvarNoCatalogo = req.body?.salvar !== false;
    const permitirAtualizarExistente = Boolean(req.body?.forcar_atualizacao);

    const products = getAliExpressCatalog();
    const idMatch = url.match(/\b(1005\d{12})\b/);
    if (idMatch && !permitirAtualizarExistente) {
      const exactExisting = products.find((p) => String(p.aliexpress_item_id) === idMatch[1]);
      if (exactExisting) {
        return res.status(409).json({
          error: `Este produto já está na sua base pronta (${exactExisting.sku}: ${exactExisting.titulo_ml}). Repetição bloqueada automaticamente.`,
          produto_existente: exactExisting,
        });
      }
    }

    const internalCode = req.body?.codigo_interno || nextInternalCode(products);
    const storeMap = loadStoreCatalogMap();
    const cachedHit = idMatch ? storeMap.get(idMatch[1]) || null : null;
    const storeEntry = cachedHit?.item || null;
    const storeMeta = cachedHit?.storeId ? getApprovedStoreById(cachedHit.storeId) : null;

    const scraped = await scrapeAliExpressProduct({
      urlOrId: url,
      internalCode,
      knownCostBrl: custoManual,
      multiplier: multiplicador,
      minPrice: MIN_ML_PRICE,
      storeEntry,
      storeMeta,
      loteOrigem: 'Importação Individual',
      skipLivePdp: Boolean(storeEntry),
    });

    if (salvarNoCatalogo && !permitirAtualizarExistente) {
      const similar = findDuplicateInCatalog(
        scraped.titulo_ml,
        scraped.aliexpress_item_id,
        products,
        0.7
      );
      if (similar) {
        return res.status(409).json({
          error: `Produto muito similar já cadastrado (${similar.match.sku}: "${similar.match.titulo_ml}"). Evitamos repetição no catálogo.`,
          produto_existente: similar.match,
        });
      }
    }

    const pricedScraped = (
      await priceProductWithExactMlFee({
        product: scraped,
        price: scraped.preco_venda_ml_sugerido,
        cost: scraped.preco_custo_aliexpress_brl,
      })
    ).product;

    if (salvarNoCatalogo) {
      const existingIdx = products.findIndex(
        (p) => String(p.aliexpress_item_id) === String(pricedScraped.aliexpress_item_id)
      );
      if (existingIdx >= 0) {
        pricedScraped.codigo_interno = products[existingIdx].codigo_interno;
        pricedScraped.sku = `${pricedScraped.codigo_interno}-${pricedScraped.aliexpress_item_id}`;
        products[existingIdx] = pricedScraped;
      } else {
        products.push(pricedScraped);
      }
      await persistCatalog(products);
    }

    res.json({
      ok: true,
      salvo: salvarNoCatalogo,
      produto: pricedScraped,
      total_catalogo: products.length,
    });
  } catch (err) {
    next(err);
  }
});

router.post('/recalcular-lote', async (req, res, next) => {
  try {
  const multiplicador = Math.max(Number(req.body?.multiplicador) || DEFAULT_MULTIPLIER, 1.5);
  const precoMinimo = Math.max(Number(req.body?.preco_minimo) || MIN_ML_PRICE, 0);
  const reescreverTitulos = Boolean(req.body?.reescrever_titulos);

  const products = getAliExpressCatalog().map((item) => {
    const pricing = calculateMlPricing(item.preco_custo_aliexpress_brl, multiplicador, precoMinimo);
    const nextTitle = reescreverTitulos
      ? rewriteMercadoLivreTitle(
          item.titulo_aliexpress_original || item.titulo_ml,
          item.atributos_lista || [],
          item.variacao_modelo || ''
        )
      : item.titulo_ml;

    const updated = {
      ...applyStoredMlFee(item, pricing.finalPrice, pricing.cost),
      titulo_ml: nextTitle,
      multiplicador_venda: pricing.multiplier,
      preco_calculado_2_8x_brl: pricing.calculated,
      preco_minimo_79_90: pricing.floor,
      preco_venda_ml_sugerido: pricing.finalPrice,
      piso_79_90_aplicado: pricing.pisoAplicado,
      atualizado_em: new Date().toISOString(),
    };
    const q = computeMlQualityScore(updated);
    return {
      ...updated,
      qualidade_score: q.score,
      qualidade_pronto_85: q.ready,
      qualidade_anuncio_meta: `${q.score}% (Meta 85%+)`,
    };
  });

  await persistCatalog(products);
  res.json({
    ok: true,
    total_atualizados: products.length,
    resumo: summarizeCatalog(products),
  });
  } catch (err) {
    next(err);
  }
});

router.get('/export-csv', (req, res) => {
  const formato = String(req.query.formato || 'completo').toLowerCase();
  const all = getAliExpressCatalog();
  const products = filterProductsByQuery(all, req.query);

  const suffixRaw = req.query.fornecedor || req.query.lote || '';
  const slug = suffixRaw
    ? `_${String(suffixRaw)
        .toLowerCase()
        .normalize('NFD')
        .replace(/[\u0300-\u036f]/g, '')
        .replace(/[^a-z0-9]+/g, '_')
        .replace(/^_|_$/g, '')}`
    : '';

  if (formato === 'planilha_ml' || formato === 'ml') {
    const csv = buildMercadoLivreBulkCsv(products);
    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader(
      'Content-Disposition',
      `attachment; filename="mercadolivre_planilha_publicacao${slug}.csv"`
    );
    return res.send(csv);
  }

  const csv = buildCompleteCsv(products);
  res.setHeader('Content-Type', 'text/csv; charset=utf-8');
  res.setHeader(
    'Content-Disposition',
    `attachment; filename="mercadolivre_aliexpress_completo${slug}.csv"`
  );
  return res.send(csv);
});

export function sanitizeMlTitle(value) {
  let title = String(value || '')
    .replace(/[\u{1F300}-\u{1FAFF}\u{2600}-\u{27BF}]/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  const prohibited = [
    /\bfrete\s+gr[áa]tis\b/gi,
    /\benvio\s+(?:imediato|r[áa]pido)\b/gi,
    /\bmelhor\s+pre[çc]o\b/gi,
    /\bpromo[çc][ãa]o\b/gi,
    /\bwhatsapp\b/gi,
    /\baliexpress\b/gi,
    /\bmercadolivre\b/gi,
  ];
  for (const pattern of prohibited) title = title.replace(pattern, ' ');
  return title.replace(/\s+/g, ' ').trim().slice(0, 60);
}

export function sanitizeMlDescription(value) {
  return String(value || '')
    .replace(/https?:\/\/\S+/gi, ' ')
    .replace(/\bwww\.\S+/gi, ' ')
    .replace(/[\w.+-]+@[\w.-]+\.\w+/g, ' ')
    .replace(/(?:\+?55\s*)?(?:\(?\d{2}\)?\s*)?\d{4,5}[-\s]?\d{4}/g, ' ')
    .replace(/\bwhatsapp\b/gi, ' ')
    .replace(/\baliexpress\b/gi, ' ')
    .replace(/[ \t]+\n/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .replace(/[ \t]{2,}/g, ' ')
    .trim()
    .slice(0, 5000);
}

function extractDetectionNames(diagnostic) {
  const raw =
    diagnostic?.detections ||
    diagnostic?.result?.detections ||
    diagnostic?.results ||
    diagnostic?.data?.detections ||
    [];
  const list = Array.isArray(raw) ? raw : [];
  return [
    ...new Set(
      list
        .map((item) =>
          String(item?.name || item?.id || item?.label || item?.type || item || '').toLowerCase()
        )
        .filter(Boolean)
    ),
  ];
}

async function inspectImageUrl(url) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 12000);
  try {
    const response = await fetch(url, {
      signal: controller.signal,
      headers: { 'User-Agent': 'Mozilla/5.0 (compatible; MelimaxPreflight/1.0)' },
    });
    if (!response.ok) return { ok: false, error: `HTTP ${response.status}` };
    const buffer = Buffer.from(await response.arrayBuffer());
    if (buffer.length < 12 * 1024) return { ok: false, error: 'arquivo pequeno demais' };
    const sharpModule = await import('sharp');
    const sharp = sharpModule.default || sharpModule;
    const meta = await sharp(buffer).metadata();
    if (!meta.width || !meta.height) return { ok: false, error: 'dimensões inválidas' };
    if (Math.min(meta.width, meta.height) < 500) {
      return { ok: false, error: `resolução baixa (${meta.width}x${meta.height})` };
    }
    return { ok: true, width: meta.width, height: meta.height, bytes: buffer.length };
  } catch (err) {
    return { ok: false, error: String(err?.message || 'falha ao baixar/inspecionar') };
  } finally {
    clearTimeout(timer);
  }
}

export async function runMlPreflight(product, options = {}) {
  const prepared = {
    ...product,
    imagens: getProductImages(product).slice(0, 8),
    titulo_ml: product?.titulo_ml || '',
    descricao_ml_otimizada: product?.descricao_ml_otimizada || '',
    preco_venda_ml_sugerido: Number(product?.preco_venda_ml_sugerido) || 0,
    estoque_disponivel: Math.min(Math.max(Number(product?.estoque_disponivel) || 3, 1), 3),
  };
  const blockers = [];
  const warnings = [];
  const adjustments = [];
  const checks = {};

  let actualItem = null;
  let actualDescription = null;
  if (product?.ml_item_id) {
    try {
      actualItem = await mlFetch(`/items/${encodeURIComponent(product.ml_item_id)}`);
      checks.anuncio_existente = true;
      if (actualItem.status === 'active') {
        blockers.push('Anúncio existente está ATIVO. Mantenha pausado antes de revisar ou reativar.');
      }
      checks.status_pausado = actualItem.status === 'paused';
      if (actualItem.status !== 'paused') {
        warnings.push(`Status atual do anúncio: ${actualItem.status} (${(actualItem.sub_status || []).join(', ') || 'sem substatus'}).`);
      }
      const sh = actualItem.shipping || {};
      const shTags = Array.isArray(sh.tags) ? sh.tags : [];
      const modeOk = sh.mode === 'not_specified';
      const noPickup = sh.local_pick_up === false && sh.store_pick_up === false;
      const noLabel =
        modeOk &&
        sh.logistic_type === 'not_specified' &&
        !shTags.includes('mandatory_free_shipping') &&
        !shTags.includes('me2_available') &&
        !shTags.includes('self_service_in');
      checks.frete_item_real = modeOk && noPickup && noLabel && sh.free_shipping === true;
      if (!modeOk) {
        blockers.push(
          `Frete atual do anúncio é "${sh.mode || 'ausente'}". Precisa ser "Vou enviar por minha conta" (not_specified), sem etiqueta.`
        );
      }
      if (sh.local_pick_up) blockers.push('Anúncio permite retirada no local. Desative essa opção.');
      if (sh.store_pick_up) blockers.push('Anúncio permite retirada na loja/agência. Desative essa opção.');
      if (shTags.includes('mandatory_free_shipping')) {
        blockers.push('Anúncio está em ME2 com frete obrigatório e geração de etiqueta pelo Mercado Livre.');
      }
      if (sh.free_shipping !== true) blockers.push('Anúncio não está com frete grátis.');
      if (sh.logistic_type && sh.logistic_type !== 'not_specified') {
        blockers.push(`Logística atual "${sh.logistic_type}" gera etiqueta/agência. Use "not_specified".`);
      }
      if (actualItem.title && actualItem.title !== prepared.titulo_ml) {
        warnings.push('Título atual difere do título otimizado; será corrigido antes de ativar.');
      }
      const intendedCategoryId = String(options.category_id || product?.categoria_ml_id || '').trim();
      if (actualItem.category_id && intendedCategoryId && actualItem.category_id !== intendedCategoryId) {
        warnings.push(`Categoria atual ${actualItem.category_id} difere da categoria informada ${intendedCategoryId}.`);
      }
      if ((actualItem.pictures || []).length < ML_MIN_IMAGES) {
        warnings.push(`Anúncio atual tem ${(actualItem.pictures || []).length} foto(s); mínimo ${ML_MIN_IMAGES}.`);
      }
      try {
        actualDescription = await mlFetch(`/items/${encodeURIComponent(product.ml_item_id)}/description`);
        const plain = String(actualDescription?.plain_text || '').trim();
        checks.descricao_item_real = plain.length >= 100;
        if (!checks.descricao_item_real) {
          blockers.push('Descrição atual do anúncio está vazia ou com menos de 100 caracteres úteis.');
        }
      } catch (err) {
        checks.descricao_item_real = false;
        blockers.push(`Não foi possível ler a descrição atual do anúncio: ${err.message}`);
      }
    } catch (err) {
      blockers.push(`Não foi possível ler o anúncio existente ${product.ml_item_id}: ${err.message}`);
      checks.anuncio_existente = false;
    }
  }

  const cleanTitle = sanitizeMlTitle(prepared.titulo_ml);
  if (!cleanTitle || cleanTitle.length < 10) {
    blockers.push('Título inválido: menos de 10 caracteres úteis após a limpeza.');
    checks.titulo = false;
  } else {
    if (cleanTitle !== prepared.titulo_ml) {
      adjustments.push('Título limpo: emojis/termos proibidos removidos e limite de 60 caracteres aplicado.');
      prepared.titulo_ml = cleanTitle;
    }
    checks.titulo = true;
  }

  const cleanDescription = sanitizeMlDescription(prepared.descricao_ml_otimizada);
  if (cleanDescription.length < 100) {
    blockers.push('Descrição inválida: mínimo de 100 caracteres úteis.');
    checks.descricao = false;
  } else {
    if (cleanDescription !== prepared.descricao_ml_otimizada) {
      adjustments.push('Descrição limpa: links, e-mail, telefone e termos externos removidos.');
      prepared.descricao_ml_otimizada = cleanDescription;
    }
    checks.descricao = true;
  }

  const nextPrice = Math.max(Number(prepared.preco_venda_ml_sugerido) || 0, ML_MIN_PRICE);
  if (nextPrice !== Number(prepared.preco_venda_ml_sugerido)) {
    adjustments.push(`Preço ajustado para o piso de R$ ${ML_MIN_PRICE.toFixed(2)}.`);
    prepared.preco_venda_ml_sugerido = Number(nextPrice.toFixed(2));
  }
  checks.preco = prepared.preco_venda_ml_sugerido >= ML_MIN_PRICE;
  if (!checks.preco) blockers.push(`Preço abaixo do piso de R$ ${ML_MIN_PRICE.toFixed(2)}.`);

  if (prepared.imagens.length < ML_MIN_IMAGES) {
    blockers.push(`Imagens insuficientes: ${prepared.imagens.length}/${ML_MIN_IMAGES} mínimas.`);
    checks.imagens = false;
  } else {
    checks.imagens = true;
  }

  const imageReports = [];
  for (let index = 0; index < prepared.imagens.length; index += 1) {
    const url = prepared.imagens[index];
    if (!/^https:\/\//i.test(url)) {
      blockers.push(`Imagem ${index + 1}: URL não HTTPS.`);
      imageReports.push({ index: index + 1, url, ok: false, error: 'URL não HTTPS' });
      continue;
    }
    const meta = await inspectImageUrl(url);
    if (!meta.ok) {
      blockers.push(`Imagem ${index + 1}: ${meta.error}.`);
      imageReports.push({ index: index + 1, url, ...meta });
    } else {
      imageReports.push({ index: index + 1, url, ...meta });
    }
  }

  let categoryId = String(options.category_id || product?.ml_revisao?.categoria_ml_id || '').trim();
  let categoryCandidates = [];
  if (categoryId && !/^MLB\d+$/i.test(categoryId)) {
    blockers.push(`Categoria inválida: "${categoryId}". Use o ID folha MLB.`);
    categoryId = '';
  }
  if (!categoryId) {
    try {
      const discovery = await mlFetch(
        `/sites/MLB/domain_discovery/search?limit=10&q=${encodeURIComponent(prepared.titulo_ml)}`
      );
      const seen = new Set();
      categoryCandidates = (Array.isArray(discovery) ? discovery : [])
        .filter((candidate) => candidate?.category_id && !seen.has(candidate.category_id))
        .map((candidate) => {
          seen.add(candidate.category_id);
          return {
            category_id: candidate.category_id,
            category_name: candidate.category_name || candidate.domain_name || candidate.category_id,
            domain_name: candidate.domain_name || null,
          };
        });
      if (categoryCandidates.length === 1) {
        categoryId = categoryCandidates[0].category_id;
        warnings.push(
          `Categoria resolvida automaticamente: ${categoryCandidates[0].category_id} (${categoryCandidates[0].category_name}).`
        );
      } else if (categoryCandidates.length > 1) {
        blockers.push(
          `Categoria ambígua (${categoryCandidates.length} candidatas). Selecione a categoria folha correta antes de publicar.`
        );
      } else {
        blockers.push('Categoria não encontrada no Mercado Livre.');
      }
    } catch (err) {
      blockers.push(`Falha ao resolver categoria: ${err.message}`);
    }
  }
  checks.categoria = Boolean(categoryId) && !blockers.some((item) => item.startsWith('Categoria'));

  if (categoryId) {
    try {
      const category = await mlFetch(`/categories/${encodeURIComponent(categoryId)}`);
      if (Array.isArray(category?.children_categories) && category.children_categories.length > 0) {
        blockers.push(`Categoria ${categoryId} não é folha (possui subcategorias).`);
        checks.categoria = false;
      }
    } catch (err) {
      blockers.push(`Falha ao validar categoria ${categoryId}: ${err.message}`);
      checks.categoria = false;
    }
  }

  let attributes = [];
  if (categoryId) {
    try {
      attributes = await buildHighScoreMlAttributes(prepared, categoryId);
    } catch (err) {
      blockers.push(`Falha ao montar atributos obrigatórios: ${err.message}`);
    }
  }

  const shipping = {
    mode: 'not_specified',
    local_pick_up: false,
    free_shipping: true,
    costs: [{ description: 'Todo o Brasil — Entrega de 5 a 10 dias', cost: 0 }],
  };
  const shippingOk =
    shipping.free_shipping === true &&
    shipping.mode === 'not_specified' &&
    shipping.costs.every((cost) => Number(cost.cost) === 0);
  checks.frete = shippingOk;
  if (!shippingOk) blockers.push('Frete inválido: deve ser grátis, sem etiqueta e com custo zero.');

  const payload = {
    family_name: prepared.titulo_ml.slice(0, 60),
    category_id: categoryId || null,
    price: Number(prepared.preco_venda_ml_sugerido),
    currency_id: 'BRL',
    available_quantity: prepared.estoque_disponivel,
    buying_mode: 'buy_it_now',
    condition: 'new',
    listing_type_id: PREMIUM_LISTING_TYPE,
    status: 'paused',
    pictures: prepared.imagens.map((source) => ({ source })),
    shipping,
    sale_terms: [
      { id: 'WARRANTY_TYPE', value_name: 'Garantia do vendedor' },
      { id: 'WARRANTY_TIME', value_name: '30 dias' },
      { id: 'MANUFACTURING_TIME', value_name: '1 dias' },
    ],
    attributes,
  };

  let validation = null;
  if (categoryId) {
    try {
      validation = await mlFetch('/items/validate', { method: 'POST', body: payload });
      const causes = Array.isArray(validation?.cause) ? validation.cause : [];
      for (const cause of causes) {
        const message = `${cause.code || 'VALIDACAO'}: ${cause.message || 'erro de validação'}`;
        if (String(cause.type || '').toLowerCase() === 'error') {
          blockers.push(`Validação ML: ${message}`);
        } else {
          warnings.push(`Aviso ML: ${message}`);
        }
      }
    } catch (err) {
      blockers.push(`Falha na validação oficial do ML: ${err.message}`);
    }
  }

  const anchorItemId = String(
    options.anchor_item_id || product?.ml_item_id || process.env.ML_DIAGNOSTIC_ANCHOR_ITEM_ID || ''
  ).trim();
  const diagnosticReports = [];
  if (prepared.imagens.length > 0) {
    if (!anchorItemId) {
      blockers.push(
        'Diagnóstico de imagens não configurado: defina ML_DIAGNOSTIC_ANCHOR_ITEM_ID com um anúncio válido da conta.'
      );
      checks.fotos = false;
    } else {
      checks.fotos = true;
      for (let index = 0; index < prepared.imagens.length; index += 1) {
        const pictureUrl = prepared.imagens[index];
        try {
          const diagnostic = await mlFetch('/moderations/pictures/diagnostic', {
            method: 'POST',
            body: {
              element_id: anchorItemId,
              picture_url: pictureUrl,
              context: {
                category_id: categoryId,
                title: prepared.titulo_ml,
                picture_type: 'thumbnail',
                language: 'pt',
              },
            },
          });
          const detectionNames = extractDetectionNames(diagnostic);
          const imageBlockers = detectionNames.filter((name) =>
            ['text_logo', 'watermark', 'logo', 'text'].includes(name)
          );
          if (imageBlockers.length > 0) {
            blockers.push(
              `Imagem ${index + 1}: conteúdo bloqueante detectado (${imageBlockers.join(', ')}).`
            );
            checks.fotos = false;
          }
          if (detectionNames.includes('white_background')) {
            warnings.push(`Imagem ${index + 1}: fundo branco detectado (alerta de qualidade).`);
          }
          diagnosticReports.push({ index: index + 1, url: pictureUrl, detections: detectionNames });
        } catch (err) {
          blockers.push(`Imagem ${index + 1}: falha no diagnóstico ML (${err.message}).`);
          checks.fotos = false;
          diagnosticReports.push({ index: index + 1, url: pictureUrl, error: err.message });
        }
      }
    }
  }

  const ok = blockers.length === 0;
  const fingerprint = buildMlReviewFingerprint(prepared, categoryId);
  return {
    prepared,
    report: {
      ok,
      checked_at: new Date().toISOString(),
      blockers,
      warnings,
      adjustments,
      checks,
      categoria_ml_id: categoryId || null,
      categoria_candidatas: categoryCandidates,
      imagens: imageReports,
      diagnosticos_imagem: diagnosticReports,
      validacao_ml: validation,
      payload,
      fingerprint,
    },
  };
}

async function buildHighScoreMlAttributes(product, leafCategoryId) {
  const gtin = String(product.gtin || product.ean || product.upc || '')
    .replace(/\D/g, '')
    .slice(0, 14);

  const attrMap = new Map([
    ['BRAND', { id: 'BRAND', value_name: product.marca || 'Genérica' }],
    ['MODEL', { id: 'MODEL', value_name: product.modelo || 'Padrão' }],
    ['SELLER_SKU', { id: 'SELLER_SKU', value_name: product.sku }],
    ['SALE_FORMAT', { id: 'SALE_FORMAT', value_name: 'Unidade' }],
    ['UNITS_PER_PACK', { id: 'UNITS_PER_PACK', value_name: '1' }],
  ]);

  try {
    const catAttrs = await mlFetch(`/categories/${encodeURIComponent(leafCategoryId)}/attributes`);
    if (Array.isArray(catAttrs)) {
      const byId = new Map(catAttrs.map((def) => [def.id, def]));
      const colorDef = byId.get('COLOR') || byId.get('MAIN_COLOR');
      if (colorDef) {
        attrMap.set(colorDef.id, {
          id: colorDef.id,
          value_name: product.cor || product.color || 'Preto',
        });
      }

      if (gtin) {
        attrMap.set('GTIN', { id: 'GTIN', value_name: gtin });
      } else if (byId.has('EMPTY_GTIN_REASON')) {
        attrMap.set('EMPTY_GTIN_REASON', { id: 'EMPTY_GTIN_REASON', value_id: '17055160' });
      }

      for (const def of catAttrs) {
        if (!def?.id || attrMap.has(def.id)) continue;
        if (def.id === 'GTIN' || def.id === 'EMPTY_GTIN_REASON') continue;
        if (def.id === 'COLOR' || def.id === 'MAIN_COLOR') continue;

        const isReq = Boolean(def.tags?.required || def.tags?.catalog_required || def.tags?.new_required);
        if (!isReq) continue;

        if (def.id === 'VOLTAGE') {
          attrMap.set(def.id, {
            id: def.id,
            value_name: /110|220|bivolt/i.test(product.titulo_ml) ? '110V/220V (Bivolt)' : 'Não aplica',
          });
        } else if (Array.isArray(def.values) && def.values.length > 0) {
          attrMap.set(def.id, { id: def.id, value_id: def.values[0].id });
        } else if (def.value_type === 'number_unit') {
          const unit = def.allowed_units?.[0]?.id || 'cm';
          attrMap.set(def.id, { id: def.id, value_name: `1 ${unit}` });
        } else if (def.value_type === 'number') {
          attrMap.set(def.id, { id: def.id, value_name: '1' });
        } else {
          attrMap.set(def.id, { id: def.id, value_name: product.modelo || 'Padrão' });
        }
      }
    }
  } catch {}

  return [...attrMap.values()];
}

async function publishSingleProductToMl(product) {
  const gate = getMlReviewGate(product);
  if (!gate.ok) {
    const err = new Error(
      `Publicação bloqueada: ${gate.missing.join('; ')}. Nada foi enviado ao Mercado Livre.`
    );
    err.status = 409;
    err.code = 'ML_PREFLIGHT_REQUIRED';
    err.missing = gate.missing;
    throw err;
  }

  const preflight = product?.ml_preflight;
  if (!preflight?.payload || !preflight?.categoria_ml_id) {
    const err = new Error('Pré-publicação ausente ou incompleta. Rode a verificação novamente.');
    err.status = 409;
    err.code = 'ML_PREFLIGHT_REQUIRED';
    throw err;
  }

  const payload = {
    ...preflight.payload,
    status: 'paused',
  };

  const created = await mlFetch('/items', { method: 'POST', body: payload });

  if (created?.id && product.descricao_ml_otimizada) {
    await mlFetch(`/items/${encodeURIComponent(created.id)}/description`, {
      method: 'POST',
      body: { plain_text: product.descricao_ml_otimizada },
    }).catch(() => null);
  }

  await query(
    `INSERT INTO listings
      (ml_item_id, title, price, supplier, status, score, source_item_id, source_price, supplier_id, permalink, margin, thumbnail, listing_type_id, cost, sale_fee, taxes, shipping_cost, net_profit)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18)
     ON CONFLICT (ml_item_id) DO UPDATE SET
       price = EXCLUDED.price,
       status = EXCLUDED.status`,
    [
      created.id,
      created.title || product.titulo_ml,
      created.price || product.preco_venda_ml_sugerido,
      product.fornecedor_nome || 'AliExpress Brasil',
      created.status || 'paused',
      getInternalQualityScore(product),
      product.aliexpress_item_id,
      product.preco_custo_aliexpress_brl,
      product.fornecedor_loja_id || 'aliexpress-brasil',
      created.permalink || null,
      (product.margem_liquida_pct || 0) / 100,
      getProductImages(product)[0] || null,
      PREMIUM_LISTING_TYPE,
      product.preco_custo_aliexpress_brl,
      product.taxa_ml_estimada_brl,
      product.imposto_estimado_brl,
      0,
      product.lucro_liquido_estimado_brl,
    ]
  ).catch(() => null);

  return created;
}

router.post('/preflight/:sku', async (req, res, next) => {
  try {
    const products = getAliExpressCatalog();
    const idx = products.findIndex(
      (p) => String(p.sku || '').toUpperCase() === String(req.params.sku || '').toUpperCase()
    );
    if (idx < 0) {
      return res.status(404).json({ error: 'Produto não encontrado no catálogo.' });
    }

    const { prepared, report } = await runMlPreflight(products[idx], {
      category_id: req.body?.category_id,
      anchor_item_id: req.body?.anchor_item_id,
    });

    const next = {
      ...products[idx],
      titulo_ml: prepared.titulo_ml,
      descricao_ml_otimizada: prepared.descricao_ml_otimizada,
      preco_venda_ml_sugerido: prepared.preco_venda_ml_sugerido,
      imagens: prepared.imagens,
      qtd_imagens: prepared.imagens.length,
      imagem_1: prepared.imagens[0] || '',
      imagem_2: prepared.imagens[1] || '',
      imagem_3: prepared.imagens[2] || '',
      imagem_4: prepared.imagens[3] || '',
      imagem_5: prepared.imagens[4] || '',
      imagem_6: prepared.imagens[5] || '',
      urls_imagens: prepared.imagens.join(' | '),
      ml_preflight: report,
      ml_revisao: null,
      atualizado_em: new Date().toISOString(),
    };
    const quality = computeMlQualityScore(next);
    next.qualidade_score = quality.score;
    next.qualidade_pronto_85 = quality.ready;
    next.qualidade_anuncio_meta = `${quality.score}% (score interno; não é nota do ML)`;

    products[idx] = next;
    await persistCatalog(products);

    res.status(report.ok ? 200 : 422).json({
      ok: report.ok,
      produto: next,
      preflight: report,
      gate: getMlReviewGate(next),
    });
  } catch (err) {
    next(err);
  }
});

router.post('/revisao-ml/:sku', async (req, res, next) => {
  try {
    const products = getAliExpressCatalog();
    const idx = products.findIndex(
      (p) => String(p.sku || '').toUpperCase() === String(req.params.sku || '').toUpperCase()
    );
    if (idx < 0) {
      return res.status(404).json({ error: 'Produto não encontrado no catálogo.' });
    }

    const product = products[idx];
    if (req.body?.aprovado === false) {
      product.ml_revisao = null;
      products[idx] = product;
      await persistCatalog(products);
      return res.json({ ok: true, produto: product, gate: getMlReviewGate(product) });
    }

    const preflight = product.ml_preflight;
    if (!preflight?.ok) {
      return res.status(409).json({
        error: 'Rode a pré-publicação automática e resolva todos os bloqueios antes de aprovar.',
        preflight,
      });
    }
    const expectedFingerprint = buildMlReviewFingerprint(product, preflight.categoria_ml_id);
    if (preflight.fingerprint !== expectedFingerprint) {
      return res.status(409).json({
        error: 'A pré-publicação está desatualizada. Rode a verificação novamente.',
      });
    }

    const checks = req.body?.checks || {};
    const pendingChecks = ML_REVIEW_CHECKS.filter((key) => checks[key] !== true);
    if (pendingChecks.length) {
      return res.status(400).json({
        error: `Confirme todos os itens da revisão: ${pendingChecks.join(', ')}.`,
        faltando: pendingChecks,
      });
    }
    if (!/^MLB\d+$/i.test(String(preflight.categoria_ml_id || ''))) {
      return res.status(400).json({ error: 'Categoria folha MLB ausente na pré-publicação.' });
    }

    product.ml_revisao = {
      aprovado: true,
      aprovado_em: new Date().toISOString(),
      aprovado_por: 'painel',
      categoria_ml_id: preflight.categoria_ml_id,
      checks: Object.fromEntries(ML_REVIEW_CHECKS.map((key) => [key, true])),
      observacoes: String(req.body?.observacoes || '').trim().slice(0, 500),
      fingerprint: expectedFingerprint,
    };
    products[idx] = product;
    await persistCatalog(products);

    res.json({ ok: true, produto: product, gate: getMlReviewGate(product) });
  } catch (err) {
    next(err);
  }
});

router.post('/publicar-ml', async (req, res, next) => {
  try {
    const sku = req.body?.sku;
    const product = findAliExpressByIdentifier(sku);
    if (!product) {
      return res.status(404).json({ error: 'Produto AliExpress não encontrado no catálogo.' });
    }

    const gate = getMlReviewGate(product);
    if (!gate.ok) {
      return res.status(409).json({
        error: `Publicação bloqueada: ${gate.missing.join('; ')}. Nada foi enviado ao Mercado Livre.`,
        missing: gate.missing,
      });
    }

    const created = await publishSingleProductToMl(product);

    const products = getAliExpressCatalog();
    const idx = products.findIndex((p) => p.sku === product.sku);
    if (idx >= 0) {
      products[idx] = {
        ...products[idx],
        status_anuncio: created.status || 'paused',
        ml_item_id: created.id,
        ml_permalink: created.permalink || null,
        tipo_anuncio: 'Premium (gold_pro)',
        tipo_anuncio_ml: 'premium',
      };
      await persistCatalog(products);
    }

    res.json({
      ok: true,
      ml_item_id: created.id,
      permalink: created.permalink,
      status: created.status,
    });
  } catch (err) {
    next(err);
  }
});

router.post('/publicar-lote', async (req, res, next) => {
  try {
    const requestedSkus = Array.isArray(req.body?.skus) ? req.body.skus : [];
    const limite = Math.min(Math.max(Number(req.body?.limite) || 15, 1), 50);
    const fornecedor = String(req.body?.fornecedor || '').trim();

    const products = getAliExpressCatalog();
    let targets = [];
    const bloqueados = [];

    if (requestedSkus.length > 0) {
      const skuSet = new Set(requestedSkus.map((s) => String(s).trim().toUpperCase()));
      const requestedProducts = products
        .filter((p) => skuSet.has(String(p.sku || '').toUpperCase()))
        .slice(0, limite);
      for (const product of requestedProducts) {
        const gate = getMlReviewGate(product);
        if (gate.ok) {
          targets.push(product);
        } else {
          bloqueados.push({ sku: product.sku, missing: gate.missing });
        }
      }
    } else {
      targets = products
        .filter((p) => {
          if (p.ml_item_id) return false;
          if (p.status_anuncio === 'verificar_estoque_fornecedor') return false;
          if (fornecedor && p.fornecedor_nome !== fornecedor && String(p.fornecedor_loja_id) !== fornecedor) {
            return false;
          }
          return getMlReviewGate(p).ok;
        })
        .slice(0, limite);
    }

    if (!targets.length) {
      return res.status(409).json({
        error:
          'Nenhum produto com pré-publicação automática e revisão manual aprovadas. Nada foi enviado ao Mercado Livre.',
        bloqueados,
      });
    }

    const resultados = [];
    let enviados = 0;
    let falhas = 0;

    for (const item of targets) {
      try {
        const created = await publishSingleProductToMl(item);
        enviados += 1;
        const idx = products.findIndex((p) => p.sku === item.sku);
        if (idx >= 0) {
          products[idx] = {
            ...products[idx],
            status_anuncio: created.status || 'paused',
            ml_item_id: created.id,
            ml_permalink: created.permalink || null,
            tipo_anuncio: 'Premium (gold_pro)',
            tipo_anuncio_ml: 'premium',
          };
        }
        resultados.push({
          sku: item.sku,
          ok: true,
          ml_item_id: created.id,
          permalink: created.permalink,
          status: created.status || 'paused',
        });
      } catch (err) {
        falhas += 1;
        resultados.push({
          sku: item.sku,
          ok: false,
          error: err.message,
        });
        // Stop early if ML account is not connected at all
        if (/Conecte a conta Mercado Livre|Nenhuma conta do Mercado Livre conectada/i.test(err.message)) {
          break;
        }
      }
    }

    if (enviados > 0) {
      await persistCatalog(products);
    }

    res.json({
      ok: enviados > 0,
      enviados,
      falhas,
      bloqueados,
      status_inicial: 'paused',
      resultados,
    });
  } catch (err) {
    next(err);
  }
});


function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function loadListingsForMl(ids = [], limite = 200) {
  const params = [];
  let where = 'ml_item_id IS NOT NULL';
  if (Array.isArray(ids) && ids.length) {
    params.push(ids.map(String));
    where += ` AND (ml_item_id = ANY($${params.length}) OR id::text = ANY($${params.length}))`;
  }
  params.push(limite);
  const { rows } = await query(
    `SELECT id, ml_item_id, title, status FROM listings
     WHERE ${where}
     ORDER BY created_at ASC
     LIMIT $${params.length}`,
    params
  );
  return rows;
}

function catalogIndexByMlItem(products) {
  const map = new Map();
  for (const product of products) {
    if (product?.ml_item_id) map.set(String(product.ml_item_id), product);
  }
  return map;
}

function applyMlStatusToProduct(product, item) {
  if (!product) return;
  product.status_anuncio = item.status;
  product.ml_sub_status = Array.isArray(item.sub_status) ? item.sub_status : [];
  product.ml_status_sincronizado_em = new Date().toISOString();
  product.ml_shipping = item.shipping || product.ml_shipping || null;
}

router.post('/sincronizar-status', async (req, res, next) => {
  try {
    const ids = Array.isArray(req.body?.ids) ? req.body.ids : [];
    const limite = Math.min(Math.max(Number(req.body?.limite) || 200, 1), 200);
    const rows = await loadListingsForMl(ids, limite);
    const products = getAliExpressCatalog();
    const byMl = catalogIndexByMlItem(products);
    const resultados = [];
    const resumo = {};
    let atualizados = 0;
    let falhas = 0;

    for (const row of rows) {
      try {
        const item = await mlFetch(`/items/${encodeURIComponent(row.ml_item_id)}`);
        await query(
          "UPDATE listings SET status=$1, payload = COALESCE(payload, '{}'::jsonb) || jsonb_build_object('status',$1::text,'sub_status',$2::jsonb) WHERE id=$3",
          [item.status, JSON.stringify(item.sub_status || []), row.id]
        );
        applyMlStatusToProduct(byMl.get(String(row.ml_item_id)), item);
        atualizados += 1;
        resumo[item.status] = (resumo[item.status] || 0) + 1;
        resultados.push({
          ml_item_id: row.ml_item_id,
          status_banco_antes: row.status,
          status_ml: item.status,
          sub_status: item.sub_status || [],
          ok: true,
        });
      } catch (err) {
        falhas += 1;
        resultados.push({ ml_item_id: row.ml_item_id, ok: false, error: err.message });
      }
      await sleep(250);
    }

    if (atualizados > 0) await persistCatalog(products);
    res.json({ ok: falhas === 0, total: rows.length, atualizados, falhas, resumo, resultados });
  } catch (err) {
    next(err);
  }
});

router.post('/status-lote', async (req, res, next) => {
  try {
    const acao = String(req.body?.acao || '').toLowerCase() === 'ativar' ? 'ativar' : 'pausar';
    const ids = Array.isArray(req.body?.ids) ? req.body.ids : [];
    const limite = Math.min(Math.max(Number(req.body?.limite) || 50, 1), 100);
    const rows = await loadListingsForMl(ids, limite);
    const products = getAliExpressCatalog();
    const byMl = catalogIndexByMlItem(products);
    const resultados = [];
    const bloqueados = [];
    let atualizados = 0;
    let falhas = 0;

    for (const row of rows) {
      const product = byMl.get(String(row.ml_item_id));
      try {
        if (acao === 'ativar') {
          if (!product) {
            bloqueados.push({ ml_item_id: row.ml_item_id, missing: ['produto não encontrado no catálogo'] });
            continue;
          }
          const gate = getMlReviewGate(product);
          if (!gate.ok) {
            bloqueados.push({ ml_item_id: row.ml_item_id, sku: product.sku, missing: gate.missing });
            continue;
          }
          const before = await mlFetch(`/items/${encodeURIComponent(row.ml_item_id)}`);
          if (before.status === 'active') {
            atualizados += 1;
            resultados.push({ ml_item_id: row.ml_item_id, ok: true, status: 'active', acao: 'já_estava_ativo' });
            continue;
          }
          if (!['paused', 'under_review'].includes(before.status)) {
            bloqueados.push({ ml_item_id: row.ml_item_id, sku: product.sku, missing: [`status ${before.status} não permite ativação`] });
            continue;
          }
          await mlFetch(`/items/${encodeURIComponent(row.ml_item_id)}`, {
            method: 'PUT',
            body: { status: 'active' },
          });
          const after = await mlFetch(`/items/${encodeURIComponent(row.ml_item_id)}`);
          if (after.status !== 'active') {
            bloqueados.push({ ml_item_id: row.ml_item_id, sku: product.sku, missing: [`ML não ativou (status ${after.status})`] });
            continue;
          }
          await query("UPDATE listings SET status='active' WHERE id=$1", [row.id]);
          applyMlStatusToProduct(product, after);
          atualizados += 1;
          resultados.push({ ml_item_id: row.ml_item_id, sku: product.sku, ok: true, status: after.status, acao: 'ativado' });
        } else {
          const before = await mlFetch(`/items/${encodeURIComponent(row.ml_item_id)}`);
          if (before.status !== 'paused') {
            await mlFetch(`/items/${encodeURIComponent(row.ml_item_id)}`, {
              method: 'PUT',
              body: { status: 'paused' },
            });
          }
          const after = await mlFetch(`/items/${encodeURIComponent(row.ml_item_id)}`);
          const hidden =
            after.status === 'paused' ||
            after.status === 'under_review' ||
            (after.sub_status || []).includes('paused_by_seller') ||
            (after.sub_status || []).includes('forbidden');
          await query('UPDATE listings SET status=$1 WHERE id=$2', [after.status, row.id]);
          applyMlStatusToProduct(product, after);
          if (hidden) {
            atualizados += 1;
            resultados.push({
              ml_item_id: row.ml_item_id,
              sku: product?.sku || null,
              ok: true,
              status: after.status,
              sub_status: after.sub_status || [],
              acao: after.status === 'paused' ? 'pausado' : 'oculto_sem_ativacao',
            });
          } else {
            falhas += 1;
            resultados.push({
              ml_item_id: row.ml_item_id,
              sku: product?.sku || null,
              ok: false,
              status: after.status,
              error: 'ML não confirmou a pausa',
            });
          }
        }
      } catch (err) {
        falhas += 1;
        resultados.push({ ml_item_id: row.ml_item_id, sku: product?.sku || null, ok: false, error: err.message });
      }
      await sleep(350);
    }

    if (atualizados > 0) await persistCatalog(products);
    res.json({
      ok: falhas === 0 && bloqueados.length === 0,
      acao,
      total: rows.length,
      atualizados,
      bloqueados,
      falhas,
      resultados,
    });
  } catch (err) {
    next(err);
  }
});

export default router;
