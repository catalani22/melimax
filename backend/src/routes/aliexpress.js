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
      piso_79_90_count: 0,
      custo_medio: 0,
      venda_media: 0,
      lucro_liquido_medio: 0,
      roi_medio_pct: 0,
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
  const pisoCount = products.filter(
    (p) => p.piso_79_90_aplicado || Number(p.preco_venda_ml_sugerido) <= 79.91
  ).length;

  const sumCost = products.reduce((acc, p) => acc + (Number(p.preco_custo_aliexpress_brl) || 0), 0);
  const sumPrice = products.reduce((acc, p) => acc + (Number(p.preco_venda_ml_sugerido) || 0), 0);
  const sumProfit = products.reduce((acc, p) => acc + (Number(p.lucro_liquido_estimado_brl) || 0), 0);
  const sumRoi = products.reduce((acc, p) => acc + (Number(p.roi_sobre_custo_pct) || 0), 0);
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
    piso_79_90_count: pisoCount,
    custo_medio: Number((sumCost / total).toFixed(2)),
    venda_media: Number((sumPrice / total).toFixed(2)),
    lucro_liquido_medio: Number((sumProfit / total).toFixed(2)),
    roi_medio_pct: Number((sumRoi / total).toFixed(1)),
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
  current.qualidade_anuncio_meta = `${q.score}% (Meta 85%+)`;
  current.atualizado_em = new Date().toISOString();

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

async function buildHighScoreMlAttributes(product, leafCategoryId) {
  const attrMap = new Map([
    ['BRAND', { id: 'BRAND', value_name: product.marca || 'Genérica' }],
    ['MODEL', { id: 'MODEL', value_name: product.modelo || 'Padrão' }],
    ['SELLER_SKU', { id: 'SELLER_SKU', value_name: product.sku }],
    ['EMPTY_GTIN_REASON', { id: 'EMPTY_GTIN_REASON', value_id: '17055160' }],
    ['SALE_FORMAT', { id: 'SALE_FORMAT', value_name: 'Unidade' }],
    ['UNITS_PER_PACK', { id: 'UNITS_PER_PACK', value_name: '1' }],
  ]);

  try {
    const catAttrs = await mlFetch(`/categories/${encodeURIComponent(leafCategoryId)}/attributes`);
    if (Array.isArray(catAttrs)) {
      for (const def of catAttrs) {
        if (!def?.id || attrMap.has(def.id)) continue;
        const isReq = Boolean(def.tags?.required || def.tags?.catalog_required || def.tags?.new_required);
        if (!isReq) continue;

        if (def.id === 'COLOR' || def.id === 'MAIN_COLOR') {
          attrMap.set(def.id, {
            id: def.id,
            value_name: def.values?.[0]?.name || 'Preto',
          });
        } else if (def.id === 'VOLTAGE') {
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

async function publishSingleProductToMl(product, options = {}) {
  let leafCategoryId = options.category_id || null;
  if (!leafCategoryId) {
    try {
      const discovery = await mlFetch(
        `/sites/MLB/domain_discovery/search?limit=1&q=${encodeURIComponent(product.titulo_ml)}`
      );
      if (Array.isArray(discovery) && discovery[0]?.category_id) {
        leafCategoryId = discovery[0].category_id;
      }
    } catch {}
  }

  if (!leafCategoryId) {
    throw new Error(
      'Conecte a conta Mercado Livre da MeLi Max Shop (ML_APP_ID e ML_CLIENT_SECRET) para publicar via API.'
    );
  }

  const pictures = (product.imagens || [])
    .filter(Boolean)
    .slice(0, 8)
    .map((url) => ({ source: url }));

  const status = options.status === 'active' ? 'active' : 'paused';
  const listingTypeId = options.listing_type_id || PREMIUM_LISTING_TYPE;
  const attributes = await buildHighScoreMlAttributes(product, leafCategoryId);

  const payload = {
    title: product.titulo_ml.slice(0, 60),
    category_id: leafCategoryId,
    price: Number(product.preco_venda_ml_sugerido),
    currency_id: 'BRL',
    available_quantity: Math.max(Number(product.estoque_disponivel) || 10, 1),
    buying_mode: 'buy_it_now',
    condition: 'new',
    listing_type_id: listingTypeId,
    status,
    pictures,
    shipping: {
      mode: 'not_specified',
      local_pick_up: false,
      free_shipping: true,
      costs: [
        {
          description: 'Todo o Brasil — Entrega de 5 a 10 dias',
          cost: 0,
        },
      ],
    },
    sale_terms: [
      { id: 'WARRANTY_TYPE', value_name: 'Garantia do vendedor' },
      { id: 'WARRANTY_TIME', value_name: '30 dias' },
      { id: 'MANUFACTURING_TIME', value_name: '1 dias' },
    ],
    attributes,
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
      created.status || status,
      product.qualidade_score || 98,
      product.aliexpress_item_id,
      product.preco_custo_aliexpress_brl,
      product.fornecedor_loja_id || 'aliexpress-brasil',
      created.permalink || null,
      (product.margem_liquida_pct || 0) / 100,
      product.imagem_1 || null,
      listingTypeId,
      product.preco_custo_aliexpress_brl,
      product.taxa_ml_estimada_brl,
      product.imposto_estimado_brl,
      0,
      product.lucro_liquido_estimado_brl,
    ]
  ).catch(() => null);

  return created;
}

router.post('/publicar-ml', async (req, res, next) => {
  try {
    const sku = req.body?.sku;
    const product = findAliExpressByIdentifier(sku);
    if (!product) {
      return res.status(404).json({ error: 'Produto AliExpress não encontrado no catálogo.' });
    }

    const created = await publishSingleProductToMl(product, {
      category_id: req.body?.category_id,
      status: req.body?.status,
      listing_type_id: req.body?.listing_type_id,
    });

    const products = getAliExpressCatalog();
    const idx = products.findIndex((p) => p.sku === product.sku);
    if (idx >= 0) {
      products[idx] = {
        ...products[idx],
        status_anuncio: created.status || req.body?.status || 'paused',
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
    const status = req.body?.status === 'active' ? 'active' : 'paused';
    const listingTypeId = req.body?.listing_type_id || PREMIUM_LISTING_TYPE;
    const fornecedor = String(req.body?.fornecedor || '').trim();

    const products = getAliExpressCatalog();
    let targets = [];

    if (requestedSkus.length > 0) {
      const skuSet = new Set(requestedSkus.map((s) => String(s).trim().toUpperCase()));
      targets = products.filter((p) => skuSet.has(String(p.sku || '').toUpperCase())).slice(0, limite);
    } else {
      targets = products
        .filter((p) => {
          if (p.ml_item_id) return false;
          if (p.status_anuncio === 'verificar_estoque_fornecedor') return false;
          if ((p.qualidade_score || computeMlQualityScore(p).score) < 85) return false;
          if (fornecedor && p.fornecedor_nome !== fornecedor && String(p.fornecedor_loja_id) !== fornecedor) {
            return false;
          }
          return true;
        })
        .slice(0, limite);
    }

    if (!targets.length) {
      return res.status(400).json({
        error: 'Nenhum produto pendente elegível (Qualidade 85%+) encontrado para o lote informado.',
      });
    }

    const resultados = [];
    let enviados = 0;
    let falhas = 0;

    for (const item of targets) {
      try {
        const created = await publishSingleProductToMl(item, {
          status,
          listing_type_id: listingTypeId,
        });
        enviados += 1;
        const idx = products.findIndex((p) => p.sku === item.sku);
        if (idx >= 0) {
          products[idx] = {
            ...products[idx],
            status_anuncio: created.status || status,
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
          status: created.status || status,
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
      status_inicial: status,
      resultados,
    });
  } catch (err) {
    next(err);
  }
});

export default router;
