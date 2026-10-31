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
  resolveNonMe2DepartmentCategory,
  OUTROS_OUTROS_LEAF_ID,
  OUTROS_OUTROS_LEAF_NAME,
  VERIFIED_NON_ME2_CATEGORY_IDS,
  NON_ME2_DEPARTMENTAL_LEAVES,
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

function hydrateProductAntiMe2(product) {
  if (!product || typeof product !== 'object') return product;
  const dept = resolveNonMe2DepartmentCategory(product);
  const currentStock = Number(product.estoque_disponivel);
  const clampedStock =
    Number.isFinite(currentStock) && currentStock >= 1 && currentStock <= 3 ? currentStock : 3;

  return {
    ...product,
    estoque_disponivel: clampedStock,
    categoria_sem_me2_id: product.categoria_sem_me2_id || dept.id,
    categoria_sem_me2_nome: product.categoria_sem_me2_nome || dept.name,
    categoria_outros_outros_id: OUTROS_OUTROS_LEAF_ID,
    categoria_outros_outros_nome: OUTROS_OUTROS_LEAF_NAME,
    estrategia_envio_anti_me2:
      product.estrategia_envio_anti_me2 || 'cascata_me1_outros_mlb3530',
  };
}

async function mergeDbCatalogWithSeedAndListings(dbProducts) {
  const seedProducts = readSeedCatalog();
  let changed = false;
  let baseList = Array.isArray(dbProducts) && dbProducts.length > 0 ? [...dbProducts] : [];

  if (baseList.length === 0) {
    baseList = seedProducts.map(hydrateProductAntiMe2);
    changed = baseList.length > 0;
  } else {
    const seenItemIds = new Set();
    const seenSkus = new Set();
    baseList = baseList.map((item) => {
      if (item?.aliexpress_item_id) seenItemIds.add(String(item.aliexpress_item_id));
      if (item?.sku) seenSkus.add(String(item.sku).toUpperCase());
      const hydrated = hydrateProductAntiMe2(item);
      if (
        hydrated.categoria_sem_me2_id !== item.categoria_sem_me2_id ||
        hydrated.estoque_disponivel !== item.estoque_disponivel
      ) {
        changed = true;
      }
      return hydrated;
    });

    for (const seedItem of seedProducts) {
      const itemId = String(seedItem?.aliexpress_item_id || '').trim();
      const skuUpper = String(seedItem?.sku || '').toUpperCase();
      if ((itemId && seenItemIds.has(itemId)) || (skuUpper && seenSkus.has(skuUpper))) {
        continue;
      }
      const hydratedSeed = hydrateProductAntiMe2(seedItem);
      if (seenSkus.has(String(hydratedSeed.sku || '').toUpperCase())) {
        const nextCode = nextInternalCode(baseList);
        hydratedSeed.codigo_interno = nextCode;
        hydratedSeed.sku = `${nextCode}-${hydratedSeed.aliexpress_item_id}`;
      }
      baseList.push(hydratedSeed);
      if (itemId) seenItemIds.add(itemId);
      seenSkus.add(String(hydratedSeed.sku || '').toUpperCase());
      changed = true;
    }
  }

  try {
    const { rows: listingRows } = await query(
      `SELECT ml_item_id, source_item_id, status, permalink
       FROM listings
       WHERE ml_item_id IS NOT NULL AND COALESCE(status, '') != 'closed'
       ORDER BY created_at DESC`
    );
    if (Array.isArray(listingRows) && listingRows.length > 0) {
      const bySourceId = new Map();
      for (const row of listingRows) {
        if (row.source_item_id && !bySourceId.has(String(row.source_item_id))) {
          bySourceId.set(String(row.source_item_id), row);
        }
      }
      for (let i = 0; i < baseList.length; i += 1) {
        const p = baseList[i];
        if (!p.ml_item_id && p.aliexpress_item_id && bySourceId.has(String(p.aliexpress_item_id))) {
          const hit = bySourceId.get(String(p.aliexpress_item_id));
          baseList[i] = {
            ...p,
            ml_item_id: hit.ml_item_id,
            ml_permalink: hit.permalink || p.ml_permalink || null,
            status_anuncio: hit.status || p.status_anuncio || 'paused',
          };
          changed = true;
        }
      }
    }
  } catch {
    // Listings table may not exist or DB offline in local preview
  }

  return { products: baseList, changed };
}

export async function ensureAliExpressCatalog() {
  if (catalogCache) return catalogCache;
  if (!catalogLoadPromise) {
    catalogLoadPromise = (async () => {
      const fromDb = await readCatalogFromDb();
      const { products, changed } = await mergeDbCatalogWithSeedAndListings(fromDb.products);
      if (fromDb.ok && changed && products.length > 0) {
        try {
          await saveCatalogToDb(products);
        } catch (err) {
          console.error('[aliexpress] falha ao atualizar catalogo mesclado no banco:', err.message);
        }
      }
      catalogCache = products;
      catalogLoadedAt = Date.now();
      return catalogCache;
    })().catch((err) => {
      console.error('[aliexpress] falha ao carregar catalogo:', err.message);
      catalogCache = readSeedCatalog().map(hydrateProductAntiMe2);
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
    const { products, changed } = await mergeDbCatalogWithSeedAndListings(fromDb.products);
    catalogCache = products;
    if (changed && products.length > 0) {
      await saveCatalogToDb(products).catch(() => null);
    }
  }
  catalogLoadedAt = Date.now();
  return catalogCache;
}

export function getAliExpressCatalog() {
  if (catalogCache) return catalogCache;
  catalogCache = readSeedCatalog().map(hydrateProductAntiMe2);
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
  const revisaoAprovada = products.filter((p) => !p.ml_item_id && getMlReviewGate(p).ok).length;
  const revisaoAprovadaTotal = products.filter((p) => getMlReviewGate(p).ok).length;
  const antiMe2Prontos = products.filter(
    (p) => !p.ml_item_id && getMlReviewGate(p).ok && p.ml_preflight?.anti_me2_verified
  ).length;
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
    revisao_aprovada_total: revisaoAprovadaTotal,
    anti_me2_prontos: antiMe2Prontos,
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

function toCatalogListItem(item) {
  if (!item || typeof item !== 'object') return item;
  const {
    descricao_ml_otimizada: _descOpt,
    descricao_aliexpress_original: _descOrig,
    urls_imagens: _urlsStr,
    titulo_aliexpress_original: _titleOrig,
    itens_inclusos: _included,
    cobertura_frete: _coverage,
    ...rest
  } = item;
  return {
    ...rest,
    imagens: Array.isArray(item.imagens) ? item.imagens.slice(0, 6) : undefined,
    detalhamento_custos: Boolean(item.detalhamento_custos),
  };
}

router.get('/produtos', (req, res) => {
  const all = getAliExpressCatalog();
  const filtered = filterProductsByQuery(all, req.query);
  const auditoriaLote2 = readAuditLote2();
  const fullPayload = req.query.completo === '1' || req.query.completo === 'true';

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
    produtos: fullPayload ? filtered : filtered.map(toCatalogListItem),
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

const mlCategoryCache = new Map();
const mlCategoryAttrsCache = new Map();
const inspectedImageCache = new Map();
let mlAccountShippingCache = { expiresAt: 0, profile: null };
let cachedDbAnchorItemId = { expiresAt: 0, itemId: '' };

async function getCachedCategory(categoryId) {
  const key = String(categoryId || '').trim().toUpperCase();
  if (!key) return null;
  const hit = mlCategoryCache.get(key);
  if (hit && Date.now() < hit.expiresAt) return hit.data;
  const data = await mlFetch(`/categories/${encodeURIComponent(key)}`);
  mlCategoryCache.set(key, { data, expiresAt: Date.now() + 30 * 60 * 1000 });
  return data;
}

async function getCachedCategoryAttributes(categoryId) {
  const key = String(categoryId || '').trim().toUpperCase();
  if (!key) return [];
  const hit = mlCategoryAttrsCache.get(key);
  if (hit && Date.now() < hit.expiresAt) return hit.data;
  const data = await mlFetch(`/categories/${encodeURIComponent(key)}/attributes`);
  const arr = Array.isArray(data) ? data : [];
  mlCategoryAttrsCache.set(key, { data: arr, expiresAt: Date.now() + 30 * 60 * 1000 });
  return arr;
}

export async function getMlAccountShippingProfile(forceRefresh = false) {
  if (!forceRefresh && mlAccountShippingCache.profile && Date.now() < mlAccountShippingCache.expiresAt) {
    return mlAccountShippingCache.profile;
  }
  try {
    const me = await mlFetch('/users/me');
    let prefs = null;
    try {
      prefs = await mlFetch(`/users/${encodeURIComponent(me.id)}/shipping_preferences`);
    } catch {}
    const modesFromMe = Array.isArray(me?.shipping_modes) ? me.shipping_modes : [];
    const modesFromPrefs = Array.isArray(prefs?.modes) ? prefs.modes : [];
    const allModes = [...new Set([...modesFromMe, ...modesFromPrefs].map((m) => String(m).toLowerCase()))];
    const profile = {
      connected: true,
      user_id: me.id,
      nickname: me.nickname || '',
      shipping_modes: allModes,
      me1_enabled: allModes.includes('me1'),
      me2_enabled: allModes.includes('me2'),
      custom_enabled: allModes.includes('custom') || allModes.includes('not_specified'),
      logistics: prefs?.logistics || null,
    };
    mlAccountShippingCache = { profile, expiresAt: Date.now() + 5 * 60 * 1000 };
    return profile;
  } catch (err) {
    return {
      connected: false,
      error: err.message,
      shipping_modes: [],
      me1_enabled: false,
      me2_enabled: false,
      custom_enabled: false,
    };
  }
}

async function resolveDefaultAnchorItemId() {
  if (process.env.ML_DIAGNOSTIC_ANCHOR_ITEM_ID) {
    return String(process.env.ML_DIAGNOSTIC_ANCHOR_ITEM_ID).trim();
  }
  if (cachedDbAnchorItemId.itemId && Date.now() < cachedDbAnchorItemId.expiresAt) {
    return cachedDbAnchorItemId.itemId;
  }
  try {
    const { rows } = await query(
      `SELECT ml_item_id FROM listings
       WHERE ml_item_id IS NOT NULL AND COALESCE(status, '') != 'closed'
       ORDER BY created_at DESC
       LIMIT 1`
    );
    const id = String(rows[0]?.ml_item_id || '').trim();
    cachedDbAnchorItemId = { itemId: id, expiresAt: Date.now() + 5 * 60 * 1000 };
    return id;
  } catch {
    return '';
  }
}

export function ensureFreeShippingNoticeInDescription(rawDesc) {
  const clean = sanitizeMlDescription(rawDesc);
  const headerNotice =
    'FRETE GRÁTIS PARA TODO O BRASIL — ENTREGA EM 5 A 10 DIAS CORRIDOS (CÓDIGO DE RASTREIO INFORMADO NO PEDIDO).';
  if (/frete\s+gr[aá]tis\s+para\s+todo\s+o\s+brasil/i.test(clean)) {
    return clean;
  }
  return sanitizeMlDescription(`${headerNotice}\n\n${clean}`);
}

export function isItemShippingFreeOfMe2(sh = {}) {
  const mode = String(sh?.mode || '').toLowerCase();
  const logistic = String(sh?.logistic_type || '').toLowerCase();
  const tags = Array.isArray(sh?.tags) ? sh.tags : [];
  if (!mode || mode === 'me2') return false;
  if (!['me1', 'custom', 'not_specified'].includes(mode)) return false;
  if (['drop_off', 'xd_drop_off', 'cross_docking', 'fulfillment'].includes(logistic)) return false;
  if (tags.includes('mandatory_free_shipping') || tags.includes('self_service_in')) return false;
  if (sh.local_pick_up === true || sh.store_pick_up === true) return false;
  return true;
}

function buildMlItemBody({ prepared, categoryId, shipping, attributes, useTitleInsteadOfFamily = false }) {
  const cleanTitle = prepared.titulo_ml.slice(0, 60);
  const base = {
    ...(useTitleInsteadOfFamily ? { title: cleanTitle } : { family_name: cleanTitle }),
    category_id: categoryId,
    price: Number(prepared.preco_venda_ml_sugerido),
    currency_id: 'BRL',
    available_quantity: Math.min(Math.max(Number(prepared.estoque_disponivel) || 3, 1), 3),
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
  return base;
}

function parseMlValidationOutcome(validationOrErr) {
  const data = validationOrErr?.data || validationOrErr || {};
  const causes = Array.isArray(data?.cause) ? data.cause : [];
  const errors = causes.filter((c) => String(c?.type || 'error').toLowerCase() === 'error');
  const warnings = causes.filter((c) => String(c?.type || '').toLowerCase() !== 'error');
  const msg = String(data?.message || validationOrErr?.message || '');
  const hasTopError = Boolean(validationOrErr instanceof Error) && errors.length === 0;
  return {
    ok: !hasTopError && errors.length === 0,
    errors: hasTopError ? [{ code: 'ML_VALIDATE_ERROR', message: msg }] : errors,
    warnings,
    raw: data,
    fullText: `${msg} ${JSON.stringify(causes)}`,
  };
}

async function tryValidateBodyWithTitleFallback({ prepared, categoryId, shipping, attributes }) {
  const bodyFamily = buildMlItemBody({
    prepared,
    categoryId,
    shipping,
    attributes,
    useTitleInsteadOfFamily: false,
  });

  let firstOutcome;
  try {
    const res = await mlFetch('/items/validate', { method: 'POST', body: bodyFamily });
    firstOutcome = parseMlValidationOutcome(res);
    if (firstOutcome.ok) {
      return { ok: true, payload: bodyFamily, outcome: firstOutcome, namingMode: 'family_name' };
    }
  } catch (err) {
    firstOutcome = parseMlValidationOutcome(err);
  }

  if (/family_name|item\.title|title\.missing|title\.invalid|body\.invalid_fields/i.test(firstOutcome.fullText)) {
    const bodyTitle = buildMlItemBody({
      prepared,
      categoryId,
      shipping,
      attributes,
      useTitleInsteadOfFamily: true,
    });
    try {
      const res2 = await mlFetch('/items/validate', { method: 'POST', body: bodyTitle });
      const secondOutcome = parseMlValidationOutcome(res2);
      if (secondOutcome.ok) {
        return { ok: true, payload: bodyTitle, outcome: secondOutcome, namingMode: 'title' };
      }
      return { ok: false, payload: bodyTitle, outcome: secondOutcome, namingMode: 'title' };
    } catch (err2) {
      return {
        ok: false,
        payload: bodyTitle,
        outcome: parseMlValidationOutcome(err2),
        namingMode: 'title',
      };
    }
  }

  return { ok: false, payload: bodyFamily, outcome: firstOutcome, namingMode: 'family_name' };
}

async function tryValidateSellerFulfilledCategory(categoryId, prepared) {
  const attributes = await buildHighScoreMlAttributes(prepared, categoryId);
  const shippingCandidates = [
    {
      label: 'custom_gratis_tabela_0',
      shipping: {
        mode: 'custom',
        local_pick_up: false,
        free_shipping: true,
        costs: [{ description: 'Todo o Brasil — Frete Grátis (5 a 10 dias)', cost: 0 }],
      },
    },
    {
      label: 'custom_tabela_0',
      shipping: {
        mode: 'custom',
        local_pick_up: false,
        free_shipping: false,
        costs: [{ description: 'Todo o Brasil — Frete Grátis (5 a 10 dias)', cost: 0 }],
      },
    },
    {
      label: 'not_specified_gratis_tabela_0',
      shipping: {
        mode: 'not_specified',
        local_pick_up: false,
        free_shipping: true,
        costs: [{ description: 'Todo o Brasil — Frete Grátis (5 a 10 dias)', cost: 0 }],
      },
    },
    {
      label: 'not_specified_combinar_gratis',
      shipping: {
        mode: 'not_specified',
        local_pick_up: false,
        free_shipping: false,
      },
    },
  ];

  let lastAttempt = null;
  for (const cand of shippingCandidates) {
    const attempt = await tryValidateBodyWithTitleFallback({
      prepared,
      categoryId,
      shipping: cand.shipping,
      attributes,
    });
    lastAttempt = { ...attempt, shippingLabel: cand.label };
    if (attempt.ok) {
      return lastAttempt;
    }
  }
  return lastAttempt;
}

export async function resolveAntiMe2Payload(prepared, options = {}) {
  const estrategia = String(options.estrategia || 'cascata').toLowerCase();
  const shippingProfile = await getMlAccountShippingProfile();
  const deptCat = resolveNonMe2DepartmentCategory(prepared);
  const manualCatId = String(options.category_id || '').trim().toUpperCase();
  const trail = [];

  // If user explicitly picked a valid leaf category in modal
  if (manualCatId && /^MLB\d+$/.test(manualCatId)) {
    try {
      const catInfo = await getCachedCategory(manualCatId);
      const isLeaf = !Array.isArray(catInfo?.children_categories) || catInfo.children_categories.length === 0;
      const shipOpts = Array.isArray(catInfo?.settings?.shipping_options)
        ? catInfo.settings.shipping_options
        : [];
      const forcesMe2 = shipOpts.includes('carrier') && !shippingProfile.me1_enabled;

      if (isLeaf && !forcesMe2) {
        const resManual = await tryValidateSellerFulfilledCategory(manualCatId, prepared);
        if (resManual?.ok) {
          return {
            ok: true,
            tier: manualCatId === OUTROS_OUTROS_LEAF_ID ? 'outros_mlb3530' : 'categoria_manual_sem_me2',
            categoryId: manualCatId,
            categoryName: catInfo?.name || manualCatId,
            payload: resManual.payload,
            validation: resManual.outcome.raw,
            warnings: resManual.outcome.warnings,
            trail: [`Categoria informada ${manualCatId} validada sem ME2 (${resManual.shippingLabel}).`],
          };
        }
      } else if (forcesMe2) {
        trail.push(
          `Categoria ${manualCatId} exige transportadora ME2 e a conta não possui ME1 ativo; aplicando cascata Anti-ME2.`
        );
      }
    } catch {}
  }

  // TIER 1: Try ME1 in real SEO category if account has ME1 enabled (or forced test)
  if (
    estrategia !== 'forcar_mlb3530' &&
    estrategia !== 'forcar_departamental' &&
    (shippingProfile.me1_enabled || estrategia === 'forcar_me1')
  ) {
    try {
      const discovery = await mlFetch(
        `/sites/MLB/domain_discovery/search?limit=5&q=${encodeURIComponent(prepared.titulo_ml)}`
      );
      const topSeo = Array.isArray(discovery) && discovery[0]?.category_id ? discovery[0] : null;
      if (topSeo?.category_id) {
        const catInfo = await getCachedCategory(topSeo.category_id);
        const shipOpts = Array.isArray(catInfo?.settings?.shipping_options)
          ? catInfo.settings.shipping_options
          : [];
        if (shipOpts.includes('me1') || shippingProfile.me1_enabled) {
          const attrsMe1 = await buildHighScoreMlAttributes(prepared, topSeo.category_id);
          const attemptMe1 = await tryValidateBodyWithTitleFallback({
            prepared,
            categoryId: topSeo.category_id,
            shipping: {
              mode: 'me1',
              local_pick_up: false,
              free_shipping: true,
            },
            attributes: attrsMe1,
          });
          if (attemptMe1.ok) {
            return {
              ok: true,
              tier: 'me1_categoria_seo',
              categoryId: topSeo.category_id,
              categoryName: topSeo.category_name || catInfo?.name || topSeo.category_id,
              payload: attemptMe1.payload,
              validation: attemptMe1.outcome.raw,
              warnings: attemptMe1.outcome.warnings,
              trail: [
                ...trail,
                `1ª camada aprovada: ME1 mantido na categoria SEO ${topSeo.category_id} (${topSeo.category_name || ''}).`,
              ],
            };
          }
          trail.push(`Tentativa ME1 em ${topSeo.category_id} recusada pela API ML; avançando para Outros sem ME2.`);
        }
      }
    } catch (err) {
      trail.push(`Tentativa ME1 indisponível (${err.message}); avançando para Outros sem ME2.`);
    }
  }

  // TIER 2: Departmental Non-ME2 "Outros" Leaf Category (MLB1902, MLB1275, MLB5236, MLB1912, etc.)
  if (estrategia !== 'forcar_mlb3530' && deptCat?.id && deptCat.id !== OUTROS_OUTROS_LEAF_ID) {
    try {
      const attemptDept = await tryValidateSellerFulfilledCategory(deptCat.id, prepared);
      if (attemptDept?.ok) {
        return {
          ok: true,
          tier: 'outros_departamental_sem_me2',
          categoryId: deptCat.id,
          categoryName: deptCat.name,
          payload: attemptDept.payload,
          validation: attemptDept.outcome.raw,
          warnings: attemptDept.outcome.warnings,
          trail: [
            ...trail,
            `Categoria Departamental sem ME2 aprovada: ${deptCat.id} (${deptCat.name}) via ${attemptDept.shippingLabel}.`,
          ],
        };
      }
      trail.push(
        `Categoria ${deptCat.id} (${deptCat.name}) retornou pendência na validação; aplicando fallback final MLB3530.`
      );
    } catch (err) {
      trail.push(`Falha ao validar ${deptCat.id} (${err.message}); aplicando fallback final MLB3530.`);
    }
  }

  // TIER 3 (GUARANTEED FALLBACK): Mais Categorias > Outros > Outros (MLB3530)
  const attempt3530 = await tryValidateSellerFulfilledCategory(OUTROS_OUTROS_LEAF_ID, prepared);
  if (attempt3530?.ok) {
    return {
      ok: true,
      tier: 'outros_outros_mlb3530',
      categoryId: OUTROS_OUTROS_LEAF_ID,
      categoryName: OUTROS_OUTROS_LEAF_NAME,
      payload: attempt3530.payload,
      validation: attempt3530.outcome.raw,
      warnings: attempt3530.outcome.warnings,
      trail: [
        ...trail,
        `Fallback garantido aplicado: ${OUTROS_OUTROS_LEAF_ID} (${OUTROS_OUTROS_LEAF_NAME}) via ${attempt3530.shippingLabel}.`,
      ],
    };
  }

  return {
    ok: false,
    tier: 'falha_validacao_ml',
    categoryId: OUTROS_OUTROS_LEAF_ID,
    categoryName: OUTROS_OUTROS_LEAF_NAME,
    payload: attempt3530?.payload || null,
    validation: attempt3530?.outcome?.raw || null,
    errors: attempt3530?.outcome?.errors || [{ code: 'ML_OFFLINE', message: 'Falha ao validar no Mercado Livre.' }],
    warnings: attempt3530?.outcome?.warnings || [],
    trail,
  };
}

export async function runMlPreflight(product, options = {}) {
  const hydrated = hydrateProductAntiMe2(product);
  const prepared = {
    ...hydrated,
    imagens: getProductImages(hydrated).slice(0, 8),
    titulo_ml: hydrated?.titulo_ml || '',
    descricao_ml_otimizada: ensureFreeShippingNoticeInDescription(hydrated?.descricao_ml_otimizada || ''),
    preco_venda_ml_sugerido: Number(hydrated?.preco_venda_ml_sugerido) || 0,
    estoque_disponivel: Math.min(Math.max(Number(hydrated?.estoque_disponivel) || 3, 1), 3),
  };
  const blockers = [];
  const warnings = [];
  const adjustments = [];
  const checks = {};

  if (hydrated?.ml_item_id && !options.ignore_existing_ml_item) {
    try {
      const actualItem = await mlFetch(`/items/${encodeURIComponent(hydrated.ml_item_id)}`);
      checks.anuncio_existente = true;
      if (actualItem.status === 'active') {
        blockers.push('Anúncio existente está ATIVO. Mantenha pausado antes de revisar ou reativar.');
      }
      checks.status_pausado = actualItem.status === 'paused';
      if (actualItem.status !== 'paused') {
        warnings.push(
          `Status atual do anúncio: ${actualItem.status} (${(actualItem.sub_status || []).join(', ') || 'sem substatus'}).`
        );
      }
      const sh = actualItem.shipping || {};
      const freeOfMe2 = isItemShippingFreeOfMe2(sh);
      checks.frete_item_real = freeOfMe2;
      if (!freeOfMe2) {
        blockers.push(
          `Anúncio existente ${hydrated.ml_item_id} está em modo "${sh.mode || 'me2'}" (${sh.logistic_type || 'carrier'}). Use o botão "Migrar Já Subidos de ME2 → Envio Próprio" na aba Subir em Lote.`
        );
      }
      try {
        const actualDescription = await mlFetch(
          `/items/${encodeURIComponent(hydrated.ml_item_id)}/description`
        );
        const plain = String(actualDescription?.plain_text || '').trim();
        checks.descricao_item_real = plain.length >= 100;
        if (!checks.descricao_item_real) {
          warnings.push('Descrição atual do anúncio no ML tem menos de 100 caracteres; será atualizada.');
        }
      } catch {}
    } catch (err) {
      warnings.push(`Aviso ao consultar anúncio existente ${hydrated.ml_item_id}: ${err.message}`);
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

  if (prepared.descricao_ml_otimizada.length < 100) {
    blockers.push('Descrição inválida: mínimo de 100 caracteres úteis.');
    checks.descricao = false;
  } else {
    if (prepared.descricao_ml_otimizada !== hydrated.descricao_ml_otimizada) {
      adjustments.push('Aviso de Frete Grátis Todo o Brasil (5 a 10 dias) garantido no topo da descrição.');
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
  const imagesToInspectCount = options.fast_batch ? Math.min(prepared.imagens.length, 1) : prepared.imagens.length;
  for (let index = 0; index < prepared.imagens.length; index += 1) {
    const url = prepared.imagens[index];
    if (!/^https:\/\//i.test(url)) {
      blockers.push(`Imagem ${index + 1}: URL não HTTPS.`);
      imageReports.push({ index: index + 1, url, ok: false, error: 'URL não HTTPS' });
      continue;
    }
    if (index >= imagesToInspectCount) {
      imageReports.push({ index: index + 1, url, ok: true, skipped_in_fast_batch: true });
      continue;
    }
    let meta = inspectedImageCache.get(url);
    if (!meta) {
      meta = await inspectImageUrl(url);
      if (meta.ok) inspectedImageCache.set(url, meta);
    }
    if (!meta.ok) {
      blockers.push(`Imagem ${index + 1}: ${meta.error}.`);
      imageReports.push({ index: index + 1, url, ...meta });
    } else {
      imageReports.push({ index: index + 1, url, ...meta });
    }
  }

  const deptSuggestion = resolveNonMe2DepartmentCategory(prepared);
  const categoryCandidates = [
    {
      category_id: deptSuggestion.id,
      category_name: `${deptSuggestion.name} (Sem ME2 · Recomendada)`,
      domain_name: 'Anti-ME2 Departamental',
    },
    {
      category_id: OUTROS_OUTROS_LEAF_ID,
      category_name: `${OUTROS_OUTROS_LEAF_NAME} (Fallback Universal Sem ME2)`,
      domain_name: 'Mais Categorias > Outros',
    },
  ];

  const cascade = await resolveAntiMe2Payload(prepared, {
    category_id: options.category_id,
    estrategia: options.estrategia || 'cascata',
  });

  for (const stepMsg of cascade.trail || []) {
    adjustments.push(stepMsg);
  }
  for (const w of cascade.warnings || []) {
    warnings.push(`Aviso ML: ${w.code || 'INFO'} — ${w.message || ''}`);
  }

  if (!cascade.ok) {
    checks.categoria = false;
    checks.frete = false;
    for (const errItem of cascade.errors || []) {
      blockers.push(`Validação ML: ${errItem.code || 'ERRO'}: ${errItem.message || 'falha na validação'}`);
    }
  } else {
    checks.categoria = true;
    checks.frete = true;
  }

  const categoryId = cascade.categoryId || deptSuggestion.id;
  const payload = cascade.payload;

  const diagnosticReports = [];
  if (options.fast_batch) {
    checks.fotos = checks.imagens && !imageReports.some((r) => !r.ok);
  } else if (prepared.imagens.length > 0) {
    const anchorItemId = String(
      options.anchor_item_id || hydrated?.ml_item_id || (await resolveDefaultAnchorItemId()) || ''
    ).trim();

    if (!anchorItemId) {
      checks.fotos = checks.imagens && !imageReports.some((r) => !r.ok);
      warnings.push(
        'Sem anúncio âncora prévio para moderação remota; fotos validadas por resolução HD (>=500x500 via Sharp).'
      );
    } else {
      checks.fotos = true;
      for (let index = 0; index < Math.min(prepared.imagens.length, 4); index += 1) {
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
                picture_type: index === 0 ? 'thumbnail' : 'other',
                language: 'pt',
              },
            },
          });
          const detectionNames = extractDetectionNames(diagnostic);
          const imageBlockers = detectionNames.filter((name) =>
            ['text_logo', 'watermark'].includes(name)
          );
          if (imageBlockers.length > 0) {
            warnings.push(
              `Imagem ${index + 1}: alerta visual detectado (${imageBlockers.join(', ')}) — revise antes de ativar.`
            );
          }
          diagnosticReports.push({ index: index + 1, url: pictureUrl, detections: detectionNames });
        } catch (err) {
          warnings.push(`Diagnóstico remoto de foto ${index + 1} indisponível (${err.message}); validada via Sharp.`);
          diagnosticReports.push({ index: index + 1, url: pictureUrl, warning: err.message });
        }
      }
    }
  }

  const ok = blockers.length === 0 && Boolean(payload);
  const fingerprint = buildMlReviewFingerprint(prepared, categoryId);
  return {
    prepared,
    report: {
      ok,
      anti_me2_verified: ok,
      estrategia_aplicada: cascade.tier,
      checked_at: new Date().toISOString(),
      blockers,
      warnings,
      adjustments,
      checks,
      categoria_ml_id: categoryId || null,
      categoria_ml_nome: cascade.categoryName || deptSuggestion.name,
      categoria_candidatas: categoryCandidates,
      imagens: imageReports,
      diagnosticos_imagem: diagnosticReports,
      validacao_ml: cascade.validation,
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
    const catAttrs = await getCachedCategoryAttributes(leafCategoryId);
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

async function postItemWithTitleFallback(payload) {
  try {
    return await mlFetch('/items', { method: 'POST', body: payload });
  } catch (err) {
    const errText = `${err.message || ''} ${JSON.stringify(err.data || {})}`;
    if (/family_name|item\.title|title\.missing|title\.invalid|body\.invalid_fields/i.test(errText)) {
      const alt = { ...payload };
      if (alt.family_name && !alt.title) {
        alt.title = alt.family_name;
        delete alt.family_name;
      } else if (alt.title && !alt.family_name) {
        alt.family_name = alt.title;
        delete alt.title;
      }
      return await mlFetch('/items', { method: 'POST', body: alt });
    }
    throw err;
  }
}

async function closeMe2ItemSafely(mlItemId) {
  try {
    await mlFetch(`/items/${encodeURIComponent(mlItemId)}`, {
      method: 'PUT',
      body: { status: 'paused' },
    }).catch(() => null);
    const closed = await mlFetch(`/items/${encodeURIComponent(mlItemId)}`, {
      method: 'PUT',
      body: { status: 'closed' },
    });
    return closed?.status === 'closed';
  } catch {
    return false;
  }
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
    available_quantity: Math.min(Math.max(Number(product.estoque_disponivel) || 3, 1), 3),
    status: 'paused',
  };

  let created = await postItemWithTitleFallback(payload);

  // Post-creation Anti-ME2 safety net: never leave a newly created item in ME2!
  if (created?.id && !isItemShippingFreeOfMe2(created.shipping || {})) {
    await closeMe2ItemSafely(created.id);
    const fallback3530 = await resolveAntiMe2Payload(
      {
        ...product,
        imagens: getProductImages(product).slice(0, 8),
        estoque_disponivel: Math.min(Math.max(Number(product.estoque_disponivel) || 3, 1), 3),
      },
      { estrategia: 'forcar_mlb3530' }
    );
    if (!fallback3530.ok || !fallback3530.payload) {
      throw new Error(
        'O Mercado Livre forçou ME2 na categoria inicial e o fallback MLB3530 não pôde ser validado.'
      );
    }
    created = await postItemWithTitleFallback({
      ...fallback3530.payload,
      status: 'paused',
    });
  }

  const descPlain = ensureFreeShippingNoticeInDescription(product.descricao_ml_otimizada || '');
  if (created?.id && descPlain) {
    await mlFetch(`/items/${encodeURIComponent(created.id)}/description`, {
      method: 'POST',
      body: { plain_text: descPlain },
    }).catch(() => null);
  }

  await query(
    `INSERT INTO listings
      (ml_item_id, title, price, supplier, status, score, source_item_id, source_price, supplier_id, permalink, margin, thumbnail, listing_type_id, cost, sale_fee, taxes, shipping_cost, net_profit)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18)
     ON CONFLICT (ml_item_id) DO UPDATE SET
       price = EXCLUDED.price,
       status = EXCLUDED.status,
       permalink = COALESCE(EXCLUDED.permalink, listings.permalink)`,
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
      estrategia: req.body?.estrategia || 'cascata',
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

async function collectAllAccountListingIds(userId) {
  const idSet = new Set();
  const dbRowsByMlId = new Map();
  try {
    const { rows } = await query(
      `SELECT id, ml_item_id, title, price, status, source_item_id, permalink
       FROM listings
       WHERE ml_item_id IS NOT NULL AND COALESCE(status, '') != 'closed'
       ORDER BY created_at ASC`
    );
    for (const r of rows) {
      if (r.ml_item_id) {
        idSet.add(String(r.ml_item_id));
        dbRowsByMlId.set(String(r.ml_item_id), r);
      }
    }
  } catch {}

  if (userId) {
    for (const st of ['paused', 'active', 'under_review']) {
      try {
        const searchRes = await mlFetch(
          `/users/${encodeURIComponent(userId)}/items/search?status=${st}&limit=100`
        );
        for (const itemId of searchRes?.results || []) {
          if (itemId) idSet.add(String(itemId));
        }
      } catch {}
    }
  }
  return { allIds: [...idSet], dbRowsByMlId };
}

async function fetchMultiItemsFast(ids) {
  const out = [];
  for (let i = 0; i < ids.length; i += 20) {
    const chunk = ids.slice(i, i + 20);
    if (!chunk.length) continue;
    try {
      const multi = await mlFetch(`/items?ids=${chunk.map(encodeURIComponent).join(',')}`);
      if (Array.isArray(multi)) {
        for (const entry of multi) {
          if (entry?.code === 200 && entry?.body?.id) {
            out.push(entry.body);
          }
        }
      }
    } catch {
      for (const singleId of chunk) {
        try {
          const single = await mlFetch(`/items/${encodeURIComponent(singleId)}`);
          if (single?.id) out.push(single);
        } catch {}
      }
    }
  }
  return out;
}

router.get('/diagnostico-geral-envio', async (_req, res, next) => {
  try {
    await refreshAliExpressCatalog();
    const products = getAliExpressCatalog();
    const profile = await getMlAccountShippingProfile(true);

    let subidosMl = {
      total_encontrados: 0,
      em_me2: 0,
      sem_me2_ok: 0,
      em_me1: 0,
      em_custom: 0,
      em_not_specified: 0,
      fechados: 0,
      amostra_me2: [],
    };

    if (profile.connected) {
      const { allIds } = await collectAllAccountListingIds(profile.user_id);
      const liveItems = await fetchMultiItemsFast(allIds);
      const openItems = liveItems.filter((it) => it.status !== 'closed');
      const me2Items = openItems.filter((it) => !isItemShippingFreeOfMe2(it.shipping || {}));
      const cleanItems = openItems.filter((it) => isItemShippingFreeOfMe2(it.shipping || {}));

      subidosMl = {
        total_encontrados: openItems.length,
        em_me2: me2Items.length,
        sem_me2_ok: cleanItems.length,
        em_me1: cleanItems.filter((it) => it.shipping?.mode === 'me1').length,
        em_custom: cleanItems.filter((it) => it.shipping?.mode === 'custom').length,
        em_not_specified: cleanItems.filter((it) => it.shipping?.mode === 'not_specified').length,
        fechados: liveItems.filter((it) => it.status === 'closed').length,
        amostra_me2: me2Items.slice(0, 6).map((it) => ({
          id: it.id,
          title: it.title,
          status: it.status,
          category_id: it.category_id,
          shipping_mode: it.shipping?.mode || 'me2',
        })),
      };
    }

    const unuploaded = products.filter((p) => !p.ml_item_id);
    const gateOkAntiMe2 = unuploaded.filter(
      (p) => getMlReviewGate(p).ok && p.ml_preflight?.anti_me2_verified
    );
    const pendentesPreparo = unuploaded.filter(
      (p) => !getMlReviewGate(p).ok || !p.ml_preflight?.anti_me2_verified
    );

    res.json({
      ok: true,
      conta_ml: profile,
      subidos_ml: subidosMl,
      catalogo_1000: {
        total: products.length,
        ja_publicados: products.length - unuploaded.length,
        nao_publicados: unuploaded.length,
        prontos_anti_me2_gate_ok: gateOkAntiMe2.length,
        pendentes_preparacao_anti_me2: pendentesPreparo.length,
      },
      categorias_sem_me2_homologadas: [
        ...NON_ME2_DEPARTMENTAL_LEAVES.map((c) => ({ id: c.id, nome: c.name })),
        { id: OUTROS_OUTROS_LEAF_ID, nome: `${OUTROS_OUTROS_LEAF_NAME} (Fallback Universal)` },
      ],
    });
  } catch (err) {
    next(err);
  }
});

router.post('/migrar-subidos-me2', async (req, res, next) => {
  try {
    await refreshAliExpressCatalog();
    const limite = Math.min(Math.max(Number(req.body?.limite) || 5, 1), 12);
    const estrategia = String(req.body?.estrategia || 'cascata').toLowerCase();
    const dryRun = Boolean(req.body?.dry_run);

    const profile = await getMlAccountShippingProfile();
    if (!profile.connected) {
      return res.status(409).json({
        error: 'Conta do Mercado Livre desconectada no backend. Conecte via OAuth primeiro.',
      });
    }

    const { allIds, dbRowsByMlId } = await collectAllAccountListingIds(profile.user_id);
    const liveItems = await fetchMultiItemsFast(allIds);
    const me2Queue = liveItems.filter(
      (it) => it.status !== 'closed' && !isItemShippingFreeOfMe2(it.shipping || {})
    );

    const slice = me2Queue.slice(0, limite);
    const products = getAliExpressCatalog();
    const byMlId = catalogIndexByMlItem(products);
    const byAliId = new Map();
    const bySku = new Map();
    for (let i = 0; i < products.length; i += 1) {
      const p = products[i];
      if (p.aliexpress_item_id) byAliId.set(String(p.aliexpress_item_id), i);
      if (p.sku) bySku.set(String(p.sku).toUpperCase(), i);
    }

    let convertidosInPlace = 0;
    let recriadosSemMe2 = 0;
    let falhas = 0;
    let catalogChanged = false;
    const resultados = [];

    for (const liveItem of slice) {
      const oldId = String(liveItem.id);
      const dbRow = dbRowsByMlId.get(oldId) || null;
      const sellerSkuAttr = (liveItem.attributes || []).find((a) => a.id === 'SELLER_SKU')?.value_name;

      let prodIdx = -1;
      const directProd = byMlId.get(oldId);
      if (directProd) {
        prodIdx = products.findIndex((p) => p.sku === directProd.sku);
      } else if (sellerSkuAttr && bySku.has(String(sellerSkuAttr).toUpperCase())) {
        prodIdx = bySku.get(String(sellerSkuAttr).toUpperCase());
      } else if (dbRow?.source_item_id && byAliId.has(String(dbRow.source_item_id))) {
        prodIdx = byAliId.get(String(dbRow.source_item_id));
      }

      const matchedProduct = prodIdx >= 0 ? products[prodIdx] : null;
      const deptTarget = resolveNonMe2DepartmentCategory(
        matchedProduct || { titulo_ml: liveItem.title || liveItem.family_name || '' }
      );
      const targetCatId =
        estrategia === 'forcar_mlb3530' ? OUTROS_OUTROS_LEAF_ID : deptTarget.id;

      if (dryRun) {
        resultados.push({
          ml_item_id_antigo: oldId,
          sku: matchedProduct?.sku || sellerSkuAttr || null,
          titulo: liveItem.title || matchedProduct?.titulo_ml || '',
          acao: 'simulacao_dry_run',
          categoria_destino: targetCatId,
          ok: true,
        });
        continue;
      }

      try {
        if (liveItem.status === 'active') {
          await mlFetch(`/items/${encodeURIComponent(oldId)}`, {
            method: 'PUT',
            body: { status: 'paused' },
          }).catch(() => null);
        }

        let convertedItem = null;

        // 1. Try in-place ME1 if enabled on seller account
        if (profile.me1_enabled && estrategia !== 'forcar_mlb3530') {
          try {
            await mlFetch(`/items/${encodeURIComponent(oldId)}`, {
              method: 'PUT',
              body: {
                shipping: { mode: 'me1', local_pick_up: false, free_shipping: true },
              },
            });
            const checkMe1 = await mlFetch(`/items/${encodeURIComponent(oldId)}`);
            if (isItemShippingFreeOfMe2(checkMe1.shipping || {})) {
              convertedItem = checkMe1;
            }
          } catch {}
        }

        // 2. Try in-place category change (Departmental Outros -> MLB3530) if 0 sales
        if (!convertedItem && Number(liveItem.sold_quantity || 0) === 0) {
          const catTries =
            targetCatId === OUTROS_OUTROS_LEAF_ID
              ? [OUTROS_OUTROS_LEAF_ID]
              : [targetCatId, OUTROS_OUTROS_LEAF_ID];

          for (const tryCat of catTries) {
            try {
              await mlFetch(`/items/${encodeURIComponent(oldId)}`, {
                method: 'PUT',
                body: {
                  category_id: tryCat,
                  shipping: {
                    mode: 'not_specified',
                    local_pick_up: false,
                  },
                },
              });
              const checkAfter = await mlFetch(`/items/${encodeURIComponent(oldId)}`);
              if (isItemShippingFreeOfMe2(checkAfter.shipping || {})) {
                convertedItem = checkAfter;
                break;
              }
            } catch {}
          }
        }

        if (convertedItem) {
          convertidosInPlace += 1;
          if (prodIdx >= 0) {
            const p = products[prodIdx];
            const { prepared, report } = await runMlPreflight(
              { ...p, ml_item_id: convertedItem.id },
              { category_id: convertedItem.category_id, fast_batch: true, estrategia }
            );
            const fp = buildMlReviewFingerprint(prepared, report.categoria_ml_id);
            products[prodIdx] = {
              ...p,
              ...prepared,
              ml_item_id: convertedItem.id,
              status_anuncio: 'paused',
              ml_shipping: convertedItem.shipping,
              ml_preflight: { ...report, fingerprint: fp },
              ml_revisao: {
                aprovado: true,
                aprovado_em: new Date().toISOString(),
                aprovado_por: 'migracao_anti_me2',
                categoria_ml_id: report.categoria_ml_id,
                checks: Object.fromEntries(ML_REVIEW_CHECKS.map((k) => [k, true])),
                observacoes: `Convertido in-place para ${convertedItem.shipping?.mode} (${convertedItem.category_id})`,
                fingerprint: fp,
              },
            };
            catalogChanged = true;
          }
          await query('UPDATE listings SET status=$1 WHERE ml_item_id=$2', [
            convertedItem.status || 'paused',
            oldId,
          ]).catch(() => null);

          resultados.push({
            ok: true,
            acao: 'convertido_in_place',
            ml_item_id_antigo: oldId,
            ml_item_id_novo: convertedItem.id,
            categoria_aplicada: convertedItem.category_id,
            modo_envio: convertedItem.shipping?.mode,
          });
          continue;
        }

        // 3. ML locked shipping.mode='me2' on oldId -> Close old ME2 item & recreate clean non-ME2 paused listing!
        let fallbackDesc = matchedProduct?.descricao_ml_otimizada || '';
        if (!fallbackDesc) {
          try {
            const d = await mlFetch(`/items/${encodeURIComponent(oldId)}/description`);
            fallbackDesc = d?.plain_text || '';
          } catch {}
        }
        const livePics = (liveItem.pictures || [])
          .map((pic) => pic.secure_url || pic.url)
          .filter(Boolean);

        const synthProduct = matchedProduct
          ? { ...matchedProduct }
          : hydrateProductAntiMe2({
              sku: sellerSkuAttr || `MLMIG-${oldId}`,
              codigo_interno: sellerSkuAttr || oldId,
              aliexpress_item_id: dbRow?.source_item_id || oldId,
              titulo_ml: liveItem.title || liveItem.family_name || 'Produto Pronta Entrega',
              descricao_ml_otimizada:
                fallbackDesc ||
                `${liveItem.title || 'Produto'}. Estoque no Brasil com frete grátis e prazo de 5 a 10 dias corridos.`,
              preco_venda_ml_sugerido: Math.max(Number(liveItem.price) || ML_MIN_PRICE, ML_MIN_PRICE),
              preco_custo_aliexpress_brl: Number(dbRow?.source_price) || 29.9,
              imagens: livePics,
              qtd_imagens: livePics.length,
              marca:
                (liveItem.attributes || []).find((a) => a.id === 'BRAND')?.value_name || 'Genérica',
              modelo:
                (liveItem.attributes || []).find((a) => a.id === 'MODEL')?.value_name || 'Padrão',
              estoque_disponivel: Math.min(Math.max(Number(liveItem.available_quantity) || 3, 1), 3),
            });

        const { prepared, report } = await runMlPreflight(synthProduct, {
          ignore_existing_ml_item: true,
          fast_batch: true,
          estrategia,
        });

        if (!report.ok || !report.payload) {
          throw new Error(
            `Falha ao validar substituto sem ME2: ${(report.blockers || []).join('; ')}`
          );
        }

        // Close the old ME2 item before creating the clean replacement
        await closeMe2ItemSafely(oldId);

        let created = await postItemWithTitleFallback({
          ...report.payload,
          status: 'paused',
        });

        if (created?.id && !isItemShippingFreeOfMe2(created.shipping || {})) {
          await closeMe2ItemSafely(created.id);
          const forced3530 = await resolveAntiMe2Payload(prepared, {
            estrategia: 'forcar_mlb3530',
          });
          if (!forced3530.ok || !forced3530.payload) {
            throw new Error('Mercado Livre recusou criação sem ME2 mesmo em MLB3530.');
          }
          created = await postItemWithTitleFallback({
            ...forced3530.payload,
            status: 'paused',
          });
        }

        if (created?.id && prepared.descricao_ml_otimizada) {
          await mlFetch(`/items/${encodeURIComponent(created.id)}/description`, {
            method: 'POST',
            body: { plain_text: prepared.descricao_ml_otimizada },
          }).catch(() => null);
        }

        if (dbRow?.id) {
          await query(
            `UPDATE listings
             SET ml_item_id = $1, status = $2, permalink = $3
             WHERE id = $4`,
            [created.id, created.status || 'paused', created.permalink || null, dbRow.id]
          ).catch(() => null);
        } else {
          await query(
            `INSERT INTO listings (ml_item_id, title, price, supplier, status, source_item_id, permalink, listing_type_id)
             VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
             ON CONFLICT (ml_item_id) DO UPDATE SET status = EXCLUDED.status`,
            [
              created.id,
              created.title || prepared.titulo_ml,
              created.price || prepared.preco_venda_ml_sugerido,
              synthProduct.fornecedor_nome || 'AliExpress Brasil',
              created.status || 'paused',
              synthProduct.aliexpress_item_id || null,
              created.permalink || null,
              PREMIUM_LISTING_TYPE,
            ]
          ).catch(() => null);
        }

        if (prodIdx >= 0) {
          const finalCatId = created.category_id || report.categoria_ml_id;
          const fp = buildMlReviewFingerprint(prepared, finalCatId);
          products[prodIdx] = {
            ...products[prodIdx],
            ...prepared,
            ml_item_id: created.id,
            ml_item_id_me2_fechado: oldId,
            ml_permalink: created.permalink || null,
            status_anuncio: created.status || 'paused',
            ml_shipping: created.shipping || null,
            ml_preflight: {
              ...report,
              categoria_ml_id: finalCatId,
              fingerprint: fp,
            },
            ml_revisao: {
              aprovado: true,
              aprovado_em: new Date().toISOString(),
              aprovado_por: 'migracao_anti_me2',
              categoria_ml_id: finalCatId,
              checks: Object.fromEntries(ML_REVIEW_CHECKS.map((k) => [k, true])),
              observacoes: `Substituído ${oldId} (ME2 fechado) -> ${created.id} (${created.shipping?.mode} em ${finalCatId})`,
              fingerprint: fp,
            },
          };
          catalogChanged = true;
        }

        recriadosSemMe2 += 1;
        resultados.push({
          ok: true,
          acao: 'fechado_me2_e_recriado_sem_me2',
          ml_item_id_antigo: oldId,
          ml_item_id_novo: created.id,
          categoria_aplicada: created.category_id,
          modo_envio: created.shipping?.mode || 'not_specified',
          permalink: created.permalink || null,
        });
      } catch (err) {
        falhas += 1;
        resultados.push({
          ok: false,
          ml_item_id_antigo: oldId,
          sku: matchedProduct?.sku || sellerSkuAttr || null,
          error: err.message,
        });
      }
      await sleep(220);
    }

    if (catalogChanged) {
      await persistCatalog(products);
    }

    const restantesEmMe2 = Math.max(0, me2Queue.length - (convertidosInPlace + recriadosSemMe2));
    res.json({
      ok: falhas === 0,
      dry_run: dryRun,
      total_em_me2_antes: me2Queue.length,
      processados: slice.length,
      convertidos_in_place: convertidosInPlace,
      recriados_sem_me2: recriadosSemMe2,
      falhas,
      restantes_em_me2: restantesEmMe2,
      resultados,
    });
  } catch (err) {
    next(err);
  }
});

router.post('/preparar-lote-catalogo', async (req, res, next) => {
  try {
    await refreshAliExpressCatalog();
    const limite = Math.min(Math.max(Number(req.body?.limite) || 15, 1), 40);
    const estrategia = String(req.body?.estrategia || 'cascata').toLowerCase();
    const aprovarRevisao = req.body?.aprovar_revisao !== false;
    const fornecedor = String(req.body?.fornecedor || '').trim();
    const revalidarTodos = Boolean(req.body?.revalidar_todos);

    const profile = await getMlAccountShippingProfile();
    if (!profile.connected) {
      return res.status(409).json({
        error: 'Conecte a conta do Mercado Livre primeiro para validar payloads oficiais em lote.',
      });
    }

    const products = getAliExpressCatalog();
    const pendingIndices = [];
    for (let i = 0; i < products.length; i += 1) {
      const p = products[i];
      if (p.ml_item_id) continue;
      if (p.status_anuncio === 'verificar_estoque_fornecedor') continue;
      if (
        fornecedor &&
        p.fornecedor_nome !== fornecedor &&
        String(p.fornecedor_loja_id) !== fornecedor
      ) {
        continue;
      }
      const alreadyAntiMe2Ok = getMlReviewGate(p).ok && p.ml_preflight?.anti_me2_verified;
      if (!revalidarTodos && alreadyAntiMe2Ok) continue;
      pendingIndices.push(i);
    }

    const sliceIndices = pendingIndices.slice(0, limite);
    let preparadosOk = 0;
    let comBloqueio = 0;
    const resultados = [];

    // Process in controlled parallel micro-chunks of 4 to stay fast (< 6s) on Vercel Serverless
    for (let c = 0; c < sliceIndices.length; c += 4) {
      const group = sliceIndices.slice(c, c + 4);
      const chunkResults = await Promise.all(
        group.map(async (idx) => {
          const item = products[idx];
          try {
            const { prepared, report } = await runMlPreflight(item, {
              fast_batch: true,
              estrategia,
            });
            const quality = computeMlQualityScore(prepared);
            const next = {
              ...item,
              titulo_ml: prepared.titulo_ml,
              descricao_ml_otimizada: prepared.descricao_ml_otimizada,
              preco_venda_ml_sugerido: prepared.preco_venda_ml_sugerido,
              estoque_disponivel: prepared.estoque_disponivel,
              imagens: prepared.imagens,
              qtd_imagens: prepared.imagens.length,
              imagem_1: prepared.imagens[0] || '',
              imagem_2: prepared.imagens[1] || '',
              imagem_3: prepared.imagens[2] || '',
              imagem_4: prepared.imagens[3] || '',
              imagem_5: prepared.imagens[4] || '',
              imagem_6: prepared.imagens[5] || '',
              urls_imagens: prepared.imagens.join(' | '),
              qualidade_score: quality.score,
              qualidade_pronto_85: quality.ready,
              ml_preflight: report,
              atualizado_em: new Date().toISOString(),
            };

            if (report.ok && aprovarRevisao) {
              const fp = buildMlReviewFingerprint(next, report.categoria_ml_id);
              next.ml_preflight.fingerprint = fp;
              next.ml_revisao = {
                aprovado: true,
                aprovado_em: new Date().toISOString(),
                aprovado_por: 'lote_anti_me2',
                categoria_ml_id: report.categoria_ml_id,
                estrategia_anti_me2: report.estrategia_aplicada,
                checks: Object.fromEntries(ML_REVIEW_CHECKS.map((k) => [k, true])),
                observacoes: `Preparado em lote Anti-ME2 (${report.estrategia_aplicada} -> ${report.categoria_ml_id})`,
                fingerprint: fp,
              };
            }
            return { idx, next, report, error: null };
          } catch (err) {
            return { idx, next: null, report: null, error: err.message };
          }
        })
      );

      for (const r of chunkResults) {
        if (r.next && r.report?.ok) {
          products[r.idx] = r.next;
          preparadosOk += 1;
          resultados.push({
            sku: r.next.sku,
            ok: true,
            categoria_ml_id: r.report.categoria_ml_id,
            estrategia: r.report.estrategia_aplicada,
            modo_envio: r.report.payload?.shipping?.mode || 'not_specified',
          });
        } else {
          if (r.next) products[r.idx] = r.next;
          comBloqueio += 1;
          resultados.push({
            sku: products[r.idx]?.sku,
            ok: false,
            error: r.error || (r.report?.blockers || []).join('; ') || 'Bloqueado na validação',
          });
        }
      }
    }

    if (sliceIndices.length > 0) {
      await persistCatalog(products);
    }

    const restantesPendentes = Math.max(0, pendingIndices.length - sliceIndices.length);
    const totalAprovados = products.filter((p) => !p.ml_item_id && getMlReviewGate(p).ok).length;

    res.json({
      ok: comBloqueio === 0,
      processados: sliceIndices.length,
      preparados_ok: preparadosOk,
      com_bloqueio: comBloqueio,
      restantes_pendentes: restantesPendentes,
      total_aprovados_prontos_para_subir: totalAprovados,
      resultados,
    });
  } catch (err) {
    next(err);
  }
});

export default router;
