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
  detectFamousBrand,
  detectMlPolicyRisk,
  sanitizeBenignPolicyTerms,
  parseImageDimensionsFromBuffer,
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

export function hydrateProductAntiMe2(product) {
  if (!product || typeof product !== 'object') return product;
  const cleanedTitle = product.titulo_ml
    ? sanitizeBenignPolicyTerms(product.titulo_ml).slice(0, 60)
    : product.titulo_ml;
  const baseWithCleanTitle =
    cleanedTitle !== product.titulo_ml ? { ...product, titulo_ml: cleanedTitle } : product;

  const dept = resolveNonMe2DepartmentCategory(baseWithCleanTitle);
  const currentStock = Number(baseWithCleanTitle.estoque_disponivel);
  const clampedStock =
    Number.isFinite(currentStock) && currentStock >= 1 && currentStock <= 3 ? currentStock : 3;
  const validExistingCat =
    baseWithCleanTitle.categoria_sem_me2_id &&
    baseWithCleanTitle.categoria_sem_me2_id !== 'MLB1911' &&
    VERIFIED_NON_ME2_CATEGORY_IDS.has(baseWithCleanTitle.categoria_sem_me2_id);
  const existingSemMe2 = validExistingCat ? baseWithCleanTitle.categoria_sem_me2_id : dept.id;
  const existingSemMe2Nome = validExistingCat
    ? baseWithCleanTitle.categoria_sem_me2_nome || dept.name
    : dept.name;
  const detectedBrand = detectFamousBrand(baseWithCleanTitle);
  const detectedPolicyRisk = detectMlPolicyRisk(baseWithCleanTitle);
  const isPolicyQuarantined =
    baseWithCleanTitle.risco_politica_liberado_manualmente === true
      ? false
      : Boolean(baseWithCleanTitle.risco_politica_ml || detectedPolicyRisk);

  return {
    ...baseWithCleanTitle,
    estoque_disponivel: clampedStock,
    categoria_sem_me2_id: existingSemMe2,
    categoria_sem_me2_nome: existingSemMe2Nome,
    categoria_outros_outros_id: OUTROS_OUTROS_LEAF_ID,
    categoria_outros_outros_nome: OUTROS_OUTROS_LEAF_NAME,
    estrategia_envio_anti_me2:
      baseWithCleanTitle.estrategia_envio_anti_me2 || 'cascata_me1_outros_mlb3530',
    marca_famosa_quarentena: Boolean(baseWithCleanTitle.marca_famosa_quarentena || detectedBrand),
    marca_famosa_detectada: baseWithCleanTitle.marca_famosa_detectada || detectedBrand || null,
    risco_politica_ml: isPolicyQuarantined,
    motivo_risco_politica_ml: isPolicyQuarantined
      ? baseWithCleanTitle.motivo_risco_politica_ml || detectedPolicyRisk || 'Política ML (ANVISA / Fotos)'
      : null,
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
        hydrated.estoque_disponivel !== item.estoque_disponivel ||
        hydrated.titulo_ml !== item.titulo_ml ||
        Boolean(hydrated.marca_famosa_quarentena) !== Boolean(item.marca_famosa_quarentena) ||
        Boolean(hydrated.risco_politica_ml) !== Boolean(item.risco_politica_ml)
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

  // Ensure zero duplicate 60-char titles across eligible products to prevent ML duplicate_item penalties
  const seenNormalizedTitles = new Map();
  for (let i = 0; i < baseList.length; i += 1) {
    const p = baseList[i];
    if (!p?.titulo_ml || p.risco_politica_ml || p.marca_famosa_quarentena) continue;
    const normT = String(p.titulo_ml)
      .normalize('NFD')
      .replace(/[\u0300-\u036f]/g, '')
      .toLowerCase()
      .replace(/\s+/g, ' ')
      .trim();
    if (!normT) continue;
    if (seenNormalizedTitles.has(normT)) {
      const codeNum = String(p.codigo_interno || p.sku || i + 1).replace(/[^A-Z0-9]/gi, '').slice(-4);
      const suffix = ` Ref ${codeNum}`;
      const maxBase = Math.max(12, 60 - suffix.length);
      const disambiguated = `${String(p.titulo_ml).trim().slice(0, maxBase).trim()}${suffix}`;
      if (disambiguated !== p.titulo_ml) {
        baseList[i] = { ...p, titulo_ml: disambiguated };
        changed = true;
      }
    } else {
      seenNormalizedTitles.set(normT, p.sku);
    }
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

  const policyRiskReason =
    product?.risco_politica_liberado_manualmente === true
      ? null
      : product?.risco_politica_ml
        ? product.motivo_risco_politica_ml || 'Política ML (ANVISA / Fotos)'
        : detectMlPolicyRisk(product);
  if (policyRiskReason) {
    missing.push(`quarentena preventiva ML (${policyRiskReason})`);
  }

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
  const marcasFamosasCount = products.filter((p) => Boolean(p.marca_famosa_quarentena)).length;
  const riscosPoliticaCount = products.filter((p) => Boolean(p.risco_politica_ml)).length;
  const prontosCount = products.filter(
    (p) =>
      !p.ml_item_id &&
      !p.marca_famosa_quarentena &&
      !p.risco_politica_ml &&
      p.status_anuncio !== 'verificar_estoque_fornecedor'
  ).length;
  const publicadosCount = products.filter((p) => Boolean(p.ml_item_id)).length;
  const revisaoAprovada = products.filter(
    (p) =>
      !p.ml_item_id &&
      !p.marca_famosa_quarentena &&
      !p.risco_politica_ml &&
      getMlReviewGate(p).ok
  ).length;
  const revisaoAprovadaTotal = products.filter((p) => getMlReviewGate(p).ok).length;
  const antiMe2Prontos = products.filter(
    (p) =>
      !p.ml_item_id &&
      !p.marca_famosa_quarentena &&
      !p.risco_politica_ml &&
      getMlReviewGate(p).ok &&
      p.ml_preflight?.anti_me2_verified
  ).length;
  const revisaoPendente = products.filter(
    (p) =>
      !p.ml_item_id &&
      !p.marca_famosa_quarentena &&
      !p.risco_politica_ml &&
      !getMlReviewGate(p).ok
  ).length;
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
    marcas_famosas_quarentena: marcasFamosasCount,
    riscos_politica_quarentena: riscosPoliticaCount,
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
    if (
      status === 'prontos' &&
      (item.ml_item_id ||
        item.marca_famosa_quarentena ||
        item.risco_politica_ml ||
        item.status_anuncio === 'verificar_estoque_fornecedor')
    ) {
      return false;
    }
    if (status === 'publicados' && !item.ml_item_id) return false;
    if (status === 'marcas_famosas' && !item.marca_famosa_quarentena) return false;
    if (status === 'riscos_politica' && !item.risco_politica_ml) return false;
    if (status === 'sem_marca_famosa' && (item.marca_famosa_quarentena || item.risco_politica_ml)) return false;
    if (q) {
      const hay = `${item.sku} ${item.codigo_interno} ${item.aliexpress_item_id} ${item.titulo_ml} ${item.titulo_aliexpress_original} ${item.fornecedor_nome} ${item.categoria_ml} ${item.marca_famosa_detectada || ''} ${item.motivo_risco_politica_ml || ''} ${item.lote_origem || ''}`.toLowerCase();
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
      headers: {
        'User-Agent':
          'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36',
        Accept: 'image/avif,image/webp,image/apng,image/*,*/*;q=0.8',
      },
    });
    if (!response.ok) return { ok: false, error: `HTTP ${response.status}` };
    const buffer = Buffer.from(await response.arrayBuffer());
    const isMlHosted = /mlstatic\.com/i.test(url);
    if (buffer.length < (isMlHosted ? 5 * 1024 : 10 * 1024)) {
      return { ok: false, error: 'arquivo pequeno demais' };
    }
    const meta = parseImageDimensionsFromBuffer(buffer);
    if (!meta || !meta.width || !meta.height) {
      const ctype = String(response.headers.get('content-type') || '').toLowerCase();
      if (ctype.startsWith('image/') && buffer.length >= 16 * 1024) {
        return { ok: true, width: 800, height: 800, bytes: buffer.length, estimated: true };
      }
      return { ok: false, error: 'formato de imagem não reconhecido' };
    }
    if (!isMlHosted && Math.min(meta.width, meta.height) < 500) {
      return { ok: false, error: `resolução baixa (${meta.width}x${meta.height})` };
    }
    return {
      ok: true,
      format: meta.format,
      width: meta.width,
      height: meta.height,
      bytes: buffer.length,
    };
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

const diagnosticPictureCache = new Map();

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
    if (id) {
      cachedDbAnchorItemId = { itemId: id, expiresAt: Date.now() + 5 * 60 * 1000 };
      return id;
    }
  } catch {}
  try {
    const catHit = getAliExpressCatalog().find((p) => p?.ml_item_id);
    if (catHit?.ml_item_id) {
      const id = String(catHit.ml_item_id).trim();
      cachedDbAnchorItemId = { itemId: id, expiresAt: Date.now() + 5 * 60 * 1000 };
      return id;
    }
  } catch {}
  try {
    const profile = await getMlAccountShippingProfile();
    if (profile.connected && profile.user_id) {
      const s = await mlFetch(
        `/users/${encodeURIComponent(profile.user_id)}/items/search?limit=1`
      );
      const id = String(s?.results?.[0] || '').trim();
      if (id) {
        cachedDbAnchorItemId = { itemId: id, expiresAt: Date.now() + 5 * 60 * 1000 };
        return id;
      }
    }
  } catch {}
  return '';
}

function baseImageHashKey(url) {
  const str = String(url || '').trim();
  const m = str.match(/\/kf\/([A-Za-z0-9]+)/i);
  if (m) return `kf:${m[1]}`;
  const mlm = str.match(/(\d{5,}-MLB\d+_\d+)/i);
  if (mlm) return `ml:${mlm[1]}`;
  return str.split('?')[0].replace(/_[0-9]+x[0-9]+\.[a-z]+$/i, '');
}

export async function autoSelectCleanGalleryAndCover(
  imageUrls,
  { categoryId, title, elementId, maxToTest = 6 } = {}
) {
  const allUrls = [...new Set((imageUrls || []).map((u) => String(u || '').trim()).filter(Boolean))];
  if (!allUrls.length || !elementId) {
    return {
      diagnosticAvailable: false,
      hasCleanCover: true,
      coverSwapped: false,
      orderedUrls: allUrls,
      forbiddenFound: [],
      diagnostics: [],
    };
  }

  // Group by underlying image hash so resized copies share the same diagnostic call
  const distinctEntries = [];
  const seenHashes = new Set();
  for (const url of allUrls) {
    const hKey = baseImageHashKey(url);
    if (!seenHashes.has(hKey) && distinctEntries.length < maxToTest) {
      seenHashes.add(hKey);
      distinctEntries.push({ url, hKey });
    }
  }

  const diagByHash = new Map();
  let anyDiagnosticSucceeded = false;

  await Promise.all(
    distinctEntries.map(async ({ url, hKey }, idx) => {
      const cacheKey = `${hKey}|${categoryId || ''}`;
      if (diagnosticPictureCache.has(cacheKey)) {
        anyDiagnosticSucceeded = true;
        diagByHash.set(hKey, { ...diagnosticPictureCache.get(cacheKey), index: idx + 1, url });
        return;
      }
      try {
        const res = await mlFetch('/moderations/pictures/diagnostic', {
          method: 'POST',
          body: {
            element_id: elementId,
            picture_url: url,
            context: {
              category_id: categoryId || OUTROS_OUTROS_LEAF_ID,
              title: String(title || 'Produto').slice(0, 60),
              picture_type: 'thumbnail',
              language: 'pt',
            },
          },
        });
        anyDiagnosticSucceeded = true;
        const detections = extractDetectionNames(res);
        const fatal = detections.filter((d) =>
          /adult|suggestive|racy|nudity|sensitive|sexual|underwear|offensive|gore|weapon|drugs|personal_data|contact|qr_code|external_link/i.test(
            d
          )
        );
        const coverIssues = detections.filter((d) =>
          /text_logo|watermark|non_white_background|poor_quality|minimum_size|blur|border|collage|mannequin/i.test(
            d
          )
        );
        const entry = {
          ok: true,
          detections,
          fatal,
          coverIssues,
          cleanCover: fatal.length === 0 && coverIssues.length === 0,
        };
        diagnosticPictureCache.set(cacheKey, entry);
        diagByHash.set(hKey, { ...entry, index: idx + 1, url });
      } catch (err) {
        diagByHash.set(hKey, {
          ok: false,
          detections: [],
          fatal: [],
          coverIssues: [],
          cleanCover: true,
          warning: err.message,
          index: idx + 1,
          url,
        });
      }
    })
  );

  if (!anyDiagnosticSucceeded) {
    return {
      diagnosticAvailable: false,
      hasCleanCover: true,
      coverSwapped: false,
      orderedUrls: allUrls,
      forbiddenFound: [],
      diagnostics: [...diagByHash.values()],
    };
  }

  const forbiddenFound = [];
  const cleanCoverUrls = [];
  const secondarySafeUrls = [];

  for (const url of allUrls) {
    const hKey = baseImageHashKey(url);
    const diag = diagByHash.get(hKey);
    if (diag?.fatal?.length) {
      forbiddenFound.push({ url, detections: diag.fatal });
      continue;
    }
    // Also drop secondary images with explicit watermarks
    if (diag?.coverIssues?.includes('watermark')) {
      continue;
    }
    if (diag?.ok && diag.cleanCover) {
      cleanCoverUrls.push(url);
    } else {
      secondarySafeUrls.push(url);
    }
  }

  const orderedUrls = [...cleanCoverUrls, ...secondarySafeUrls];
  const hasCleanCover = cleanCoverUrls.length > 0;
  const coverSwapped =
    orderedUrls.length > 0 && allUrls.length > 0 && orderedUrls[0] !== allUrls[0];

  return {
    diagnosticAvailable: true,
    hasCleanCover,
    coverSwapped,
    orderedUrls: orderedUrls.length > 0 ? orderedUrls : allUrls.filter((u) => !forbiddenFound.some((f) => f.url === u)),
    forbiddenFound,
    diagnostics: [...diagByHash.values()],
  };
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
  if (tags.includes('self_service_in')) return false;
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

export function parseMlValidationOutcome(validationOrErr) {
  const isErrInstance = validationOrErr instanceof Error;
  const data =
    (isErrInstance
      ? validationOrErr.details || validationOrErr.data
      : validationOrErr?.details || validationOrErr?.data || validationOrErr) || {};
  const causes = Array.isArray(data?.cause) ? data.cause : [];
  const errors = causes.filter((c) => String(c?.type || 'error').toLowerCase() === 'error');
  const warnings = causes.filter((c) => String(c?.type || '').toLowerCase() !== 'error');
  const msg = String(data?.message || validationOrErr?.message || '');
  // Note: ML POST /items/validate returns HTTP 400 "Validation error" even when `cause` contains ONLY warnings!
  const hasUncausedHttpError = isErrInstance && causes.length === 0;
  return {
    ok: !hasUncausedHttpError && errors.length === 0,
    errors: hasUncausedHttpError
      ? [{ code: data?.code || validationOrErr?.code || 'ML_VALIDATE_ERROR', message: msg }]
      : errors,
    warnings,
    raw: data,
    status: validationOrErr?.status || data?.status || 200,
    fullText: `${msg} ${JSON.stringify(data)}`,
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
    if (firstOutcome.ok) {
      return { ok: true, payload: bodyFamily, outcome: firstOutcome, namingMode: 'family_name' };
    }
  }

  // Always try legacy `title` fallback unless auth failed (401)
  if (firstOutcome.status !== 401) {
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
      const secondOutcome = parseMlValidationOutcome(err2);
      if (secondOutcome.ok) {
        return { ok: true, payload: bodyTitle, outcome: secondOutcome, namingMode: 'title' };
      }
      return {
        ok: false,
        payload: bodyTitle,
        outcome: secondOutcome,
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
      label: 'custom_gratis_tabela_0_sem_etiqueta',
      shipping: {
        mode: 'custom',
        local_pick_up: false,
        free_shipping: true,
        costs: [{ description: 'Todo o Brasil — Frete Grátis (5 a 10 dias)', cost: 0 }],
      },
    },
    {
      label: 'not_specified_gratis_tabela_0_sem_etiqueta',
      shipping: {
        mode: 'not_specified',
        local_pick_up: false,
        free_shipping: true,
        costs: [{ description: 'Todo o Brasil — Frete Grátis (5 a 10 dias)', cost: 0 }],
      },
    },
    {
      label: 'not_specified_combinar_sem_etiqueta',
      shipping: {
        mode: 'not_specified',
        local_pick_up: false,
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

  const policyRiskReason =
    hydrated?.risco_politica_liberado_manualmente === true
      ? null
      : hydrated?.risco_politica_ml
        ? hydrated.motivo_risco_politica_ml || 'Política ML (ANVISA / Fotos)'
        : detectMlPolicyRisk(prepared);
  if (policyRiskReason) {
    checks.politica_ml = false;
    blockers.push(
      `Quarentena Anti-Suspensão ML (${policyRiskReason}): item retido preventivamente para proteger a loja contra infração de ANVISA / Saúde / Estética / Fotos Sensíveis.`
    );
  } else {
    checks.politica_ml = true;
  }

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
      const refs =
        Array.isArray(errItem.references) && errItem.references.length
          ? ` (${errItem.references.join(', ')})`
          : '';
      blockers.push(
        `Validação ML: ${errItem.code || 'ERRO'}${refs}: ${errItem.message || 'campo ou atributo inválido'}`
      );
    }
  } else {
    checks.categoria = true;
    checks.frete = true;
  }

  const categoryId = cascade.categoryId || deptSuggestion.id;
  const payload = cascade.payload;

  const diagnosticReports = [];
  if (prepared.imagens.length > 0) {
    const anchorItemId = String(
      options.anchor_item_id || hydrated?.ml_item_id || (await resolveDefaultAnchorItemId()) || ''
    ).trim();

    if (!anchorItemId) {
      checks.fotos = checks.imagens && !imageReports.some((r) => !r.ok);
      warnings.push(
        'Sem anúncio âncora prévio para moderação remota; fotos validadas por inspeção binária HD (>=500x500).'
      );
    } else {
      const galleryAudit = await autoSelectCleanGalleryAndCover(prepared.imagens, {
        categoryId,
        title: prepared.titulo_ml,
        elementId: anchorItemId,
        maxToTest: options.fast_batch ? 5 : 6,
      });
      for (const d of galleryAudit.diagnostics) {
        diagnosticReports.push({
          index: d.index,
          url: d.url,
          detections: d.detections,
          warning: d.warning,
        });
      }

      if (galleryAudit.forbiddenFound.length > 0) {
        adjustments.push(
          `${galleryAudit.forbiddenFound.length} foto(s) com conteúdo sensível/restrito removida(s) automaticamente.`
        );
      }
      if (galleryAudit.orderedUrls.length < ML_MIN_IMAGES) {
        checks.fotos = false;
        blockers.push(
          `Após remover fotos com conteúdo sensível/marca d'água, restaram apenas ${galleryAudit.orderedUrls.length}/${ML_MIN_IMAGES} fotos válidas.`
        );
      } else if (galleryAudit.diagnosticAvailable && !galleryAudit.hasCleanCover && options.strict_cover !== false) {
        checks.fotos = false;
        blockers.push(
          'Critério de Capa ML: todas as fotos deste fornecedor possuem texto promocional, logo ou fundo fora do padrão branco digital (causaria pendência "Melhore a foto de capa").'
        );
      } else {
        checks.fotos = checks.imagens && !imageReports.some((r) => !r.ok);
        if (galleryAudit.coverSwapped) {
          adjustments.push(
            'Foto limpa com fundo branco (sem texto/logo) promovida automaticamente para Foto 1 (Capa).'
          );
        }
        prepared.imagens = galleryAudit.orderedUrls.slice(0, 8);
        if (payload && Array.isArray(prepared.imagens) && prepared.imagens.length >= ML_MIN_IMAGES) {
          payload.pictures = prepared.imagens.map((source) => ({ source }));
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

  const safeBrand =
    product.marca && !detectFamousBrand({ marca: product.marca }) ? product.marca : 'Genérica';
  const safeModel =
    product.modelo && !detectFamousBrand({ modelo: product.modelo }) ? product.modelo : 'Padrão';

  const attrMap = new Map([
    ['BRAND', { id: 'BRAND', value_name: safeBrand }],
    ['MODEL', { id: 'MODEL', value_name: safeModel }],
    ['SELLER_SKU', { id: 'SELLER_SKU', value_name: product.sku || product.codigo_interno || 'MELIMAX-01' }],
  ]);

  try {
    const catAttrs = await getCachedCategoryAttributes(leafCategoryId);
    if (Array.isArray(catAttrs)) {
      const byId = new Map(catAttrs.map((def) => [def.id, def]));

      if (byId.has('SALE_FORMAT')) {
        attrMap.set('SALE_FORMAT', { id: 'SALE_FORMAT', value_name: 'Unidade' });
      }
      if (byId.has('UNITS_PER_PACK')) {
        attrMap.set('UNITS_PER_PACK', { id: 'UNITS_PER_PACK', value_name: '1' });
      }
      if (byId.has('MANUFACTURER')) {
        attrMap.set('MANUFACTURER', { id: 'MANUFACTURER', value_name: safeBrand });
      }
      if (byId.has('INCLUDES_ASSEMBLY_MANUAL')) {
        attrMap.set('INCLUDES_ASSEMBLY_MANUAL', {
          id: 'INCLUDES_ASSEMBLY_MANUAL',
          value_id: '242084',
        });
      }
      if (byId.has('PART_NUMBER')) {
        attrMap.set('PART_NUMBER', {
          id: 'PART_NUMBER',
          value_name: String(product.codigo_interno || product.sku || 'UNIV-01').slice(0, 40),
        });
      }

      const colorDef = byId.get('COLOR') || byId.get('MAIN_COLOR');
      if (colorDef && !colorDef.tags?.defines_picture) {
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

        const isReq = Boolean(def.tags?.required || def.tags?.catalog_required || def.tags?.new_required);
        if (!isReq) continue;

        if (def.id === 'VOLTAGE') {
          attrMap.set(def.id, {
            id: def.id,
            value_name: /110|220|bivolt/i.test(product.titulo_ml) ? '110V/220V (Bivolt)' : 'Não aplica',
          });
        } else if (def.id === 'GENDER' && Array.isArray(def.values) && def.values.length > 0) {
          const neutral =
            def.values.find((v) => /sem\s*g[eê]nero|unissex/i.test(v.name || '')) || def.values[0];
          attrMap.set(def.id, { id: def.id, value_id: neutral.id });
        } else if (def.id === 'SIZE') {
          attrMap.set(def.id, { id: def.id, value_name: 'Único' });
        } else if (Array.isArray(def.values) && def.values.length > 0) {
          attrMap.set(def.id, { id: def.id, value_id: def.values[0].id });
        } else if (def.value_type === 'number_unit') {
          const unit = def.allowed_units?.[0]?.id || 'cm';
          attrMap.set(def.id, { id: def.id, value_name: `1 ${unit}` });
        } else if (def.value_type === 'number') {
          attrMap.set(def.id, { id: def.id, value_name: '1' });
        } else {
          attrMap.set(def.id, { id: def.id, value_name: safeModel });
        }
      }
    }
  } catch {}

  return [...attrMap.values()];
}

export async function ensureItemStrictlyPaused(mlItemId) {
  if (!mlItemId) return null;
  const encoded = encodeURIComponent(String(mlItemId).trim());
  try {
    const first = await mlFetch(`/items/${encoded}`, {
      method: 'PUT',
      body: { status: 'paused' },
    });
    if (first && first.status !== 'active') return first;
  } catch {}
  await sleep(220);
  try {
    const second = await mlFetch(`/items/${encoded}`, {
      method: 'PUT',
      body: { status: 'paused' },
    });
    if (second) return second;
  } catch {}
  try {
    return await mlFetch(`/items/${encoded}`);
  } catch {
    return null;
  }
}

async function postItemWithTitleFallback(payload, { forcePause = true } = {}) {
  let created = null;
  try {
    created = await mlFetch('/items', { method: 'POST', body: payload });
  } catch (err) {
    if (err?.status !== 401) {
      const alt = { ...payload };
      if (alt.family_name && !alt.title) {
        alt.title = alt.family_name;
        delete alt.family_name;
        created = await mlFetch('/items', { method: 'POST', body: alt });
      } else if (alt.title && !alt.family_name) {
        alt.family_name = alt.title;
        delete alt.title;
        created = await mlFetch('/items', { method: 'POST', body: alt });
      } else {
        throw err;
      }
    } else {
      throw err;
    }
  }
  // CRITICAL: ML POST /items ignores status:"paused" and creates items as "active"!
  // Immediately force PUT { status: "paused" } so NO item ever goes live prematurely.
  if (created?.id && forcePause) {
    const paused = await ensureItemStrictlyPaused(created.id);
    if (paused?.status) {
      created = {
        ...created,
        status: paused.status,
        sub_status: paused.sub_status || created.sub_status,
      };
    } else {
      created = { ...created, status: 'paused' };
    }
  }
  return created;
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
    const ignorarSkusSet = new Set(
      (Array.isArray(req.body?.ignorar_skus) ? req.body.ignorar_skus : []).map((s) =>
        String(s).trim().toUpperCase()
      )
    );
    const incluirMarcasFamosas = Boolean(req.body?.incluir_marcas_famosas);
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
        if (!incluirMarcasFamosas && product.marca_famosa_quarentena) {
          bloqueados.push({
            sku: product.sku,
            missing: [`Marca famosa reservada (${product.marca_famosa_detectada || 'BPP'})`],
          });
          continue;
        }
        const pRisk = product.risco_politica_ml
          ? product.motivo_risco_politica_ml || 'Política ML'
          : detectMlPolicyRisk(product);
        if (pRisk && product.risco_politica_liberado_manualmente !== true) {
          bloqueados.push({
            sku: product.sku,
            missing: [`Quarentena Política ML (${pRisk})`],
          });
          continue;
        }
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
          if (ignorarSkusSet.has(String(p.sku || '').toUpperCase())) return false;
          if (!incluirMarcasFamosas && p.marca_famosa_quarentena) return false;
          if (p.risco_politica_ml || detectMlPolicyRisk(p)) return false;
          if (p.status_anuncio === 'verificar_estoque_fornecedor') return false;
          if (fornecedor && p.fornecedor_nome !== fornecedor && String(p.fornecedor_loja_id) !== fornecedor) {
            return false;
          }
          return getMlReviewGate(p).ok;
        })
        .slice(0, limite);
    }

    if (!targets.length) {
      const restantesAprovados = products.filter(
        (p) =>
          !p.ml_item_id &&
          (!p.marca_famosa_quarentena || incluirMarcasFamosas) &&
          !p.risco_politica_ml &&
          !detectMlPolicyRisk(p) &&
          !ignorarSkusSet.has(String(p.sku || '').toUpperCase()) &&
          getMlReviewGate(p).ok
      ).length;
      if (requestedSkus.length === 0 && restantesAprovados === 0) {
        return res.json({
          ok: true,
          enviados: 0,
          falhas: 0,
          restantes_aprovados: 0,
          bloqueados,
          status_inicial: 'paused',
          resultados: [],
        });
      }
      return res.status(409).json({
        error:
          'Nenhum produto elegível com pré-publicação automática e revisão manual aprovadas.',
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
          if (product.marca_famosa_quarentena || detectFamousBrand(product)) {
            bloqueados.push({
              ml_item_id: row.ml_item_id,
              sku: product.sku,
              missing: [`Marca famosa reservada (${product.marca_famosa_detectada || 'BPP'})`],
            });
            continue;
          }
          const catRisk = product.risco_politica_ml
            ? product.motivo_risco_politica_ml || 'Política ML'
            : detectMlPolicyRisk(product);
          if (catRisk && product.risco_politica_liberado_manualmente !== true) {
            bloqueados.push({
              ml_item_id: row.ml_item_id,
              sku: product.sku,
              missing: [`Bloqueado Anti-Suspensão (${catRisk})`],
            });
            continue;
          }
          const gate = getMlReviewGate(product);
          if (!gate.ok) {
            bloqueados.push({ ml_item_id: row.ml_item_id, sku: product.sku, missing: gate.missing });
            continue;
          }
          const before = await mlFetch(`/items/${encodeURIComponent(row.ml_item_id)}`);
          const liveMod = detectLiveModerationAlert(before);
          const liveRisk = detectMlPolicyRisk(before);
          if (liveMod || liveRisk) {
            bloqueados.push({
              ml_item_id: row.ml_item_id,
              sku: product.sku,
              missing: [`Alerta de moderação/política ML (${liveMod || liveRisk})`],
            });
            continue;
          }
          if (!isItemShippingFreeOfMe2(before.shipping || {})) {
            bloqueados.push({
              ml_item_id: row.ml_item_id,
              sku: product.sku,
              missing: [`Anúncio está em ME2 (${before.shipping?.mode || 'me2'}) — converta para Outros/Sem Etiqueta antes de ativar`],
            });
            continue;
          }
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

export async function collectAllAccountListingIds(userId) {
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

  try {
    for (const p of getAliExpressCatalog()) {
      if (p?.ml_item_id) idSet.add(String(p.ml_item_id));
    }
  } catch {}

  if (userId) {
    const statusesToScan = ['paused', 'active', 'under_review', 'inactive'];
    await Promise.all(
      statusesToScan.map(async (st) => {
        try {
          let first = await mlFetch(
            `/users/${encodeURIComponent(userId)}/items/search?search_type=scan&status=${st}&limit=100`
          );
          let batch = Array.isArray(first?.results) ? first.results : [];
          for (const itemId of batch) {
            if (itemId) idSet.add(String(itemId));
          }
          let scrollId = first?.scroll_id || '';
          let pages = 1;
          const totalExpected = Number(first?.paging?.total || batch.length);
          let collected = batch.length;
          while (scrollId && batch.length === 100 && collected < totalExpected && pages < 30) {
            const nextRes = await mlFetch(
              `/users/${encodeURIComponent(userId)}/items/search?search_type=scan&scroll_id=${encodeURIComponent(scrollId)}&limit=100`
            );
            batch = Array.isArray(nextRes?.results) ? nextRes.results : [];
            for (const itemId of batch) {
              if (itemId) idSet.add(String(itemId));
            }
            collected += batch.length;
            scrollId = nextRes?.scroll_id || scrollId;
            pages += 1;
          }
        } catch {
          try {
            let offset = 0;
            while (offset < 1000) {
              const pageRes = await mlFetch(
                `/users/${encodeURIComponent(userId)}/items/search?status=${st}&limit=100&offset=${offset}`
              );
              const list = Array.isArray(pageRes?.results) ? pageRes.results : [];
              for (const itemId of list) {
                if (itemId) idSet.add(String(itemId));
              }
              const total = Number(pageRes?.paging?.total || 0);
              offset += 100;
              if (list.length < 100 || offset >= total) break;
            }
          } catch {}
        }
      })
    );
  }
  return { allIds: [...idSet], dbRowsByMlId };
}

export async function fetchMultiItemsFast(ids) {
  const uniqueIds = [...new Set((ids || []).map((x) => String(x || '').trim()).filter(Boolean))];
  const chunks = [];
  for (let i = 0; i < uniqueIds.length; i += 20) {
    chunks.push(uniqueIds.slice(i, i + 20));
  }
  const out = [];
  // Fetch up to 6 chunks (120 items) concurrently per wave -> 1,300+ items in ~1.4s
  for (let w = 0; w < chunks.length; w += 6) {
    const wave = chunks.slice(w, w + 6);
    const waveResults = await Promise.all(
      wave.map(async (chunk) => {
        try {
          const multi = await mlFetch(`/items?ids=${chunk.map(encodeURIComponent).join(',')}`);
          const found = [];
          if (Array.isArray(multi)) {
            for (const entry of multi) {
              if (entry?.code === 200 && entry?.body?.id) {
                found.push(entry.body);
              }
            }
          }
          return found;
        } catch {
          const fallbackFound = [];
          for (const singleId of chunk) {
            try {
              const single = await mlFetch(`/items/${encodeURIComponent(singleId)}`);
              if (single?.id) fallbackFound.push(single);
            } catch {}
          }
          return fallbackFound;
        }
      })
    );
    for (const group of waveResults) {
      out.push(...group);
    }
  }
  return out;
}

export function isLiveItemModerationLocked(liveItem) {
  const subs = Array.isArray(liveItem?.sub_status)
    ? liveItem.sub_status.map((s) => String(s).toLowerCase())
    : [];
  return subs.some((s) =>
    ['forbidden', 'intellectual_property', 'brand_protection', 'suspended', 'held'].includes(s)
  );
}

export function detectLiveModerationAlert(liveItem) {
  if (!liveItem || typeof liveItem !== 'object') return null;
  const subs = Array.isArray(liveItem.sub_status)
    ? liveItem.sub_status.map((s) => String(s).toLowerCase())
    : [];
  const status = String(liveItem.status || '').toLowerCase();

  if (subs.includes('forbidden')) {
    return 'Cancelado/Proibido pela Política do ML (ANVISA / Saúde / Restrito)';
  }
  if (
    subs.some((s) =>
      /picture|photo|thumbnail|waiting_for_patch|moderation_penalty|bad_quality/i.test(s)
    )
  ) {
    return `Infração ou Pausa em Fotos no ML (${subs.join(', ')})`;
  }
  if (subs.some((s) => ['intellectual_property', 'brand_protection'].includes(s))) {
    return `Proteção de Marca / Propriedade Intelectual (${subs.join(', ')})`;
  }
  if (subs.some((s) => ['suspended', 'held'].includes(s)) || status === 'inactive') {
    return `Retido pela Moderação do ML (${subs.join(', ') || status})`;
  }
  return null;
}

const KNOWN_CATEGORY_NAMES = new Map([
  ...NON_ME2_DEPARTMENTAL_LEAVES.map((c) => [c.id, c.name]),
  [OUTROS_OUTROS_LEAF_ID, OUTROS_OUTROS_LEAF_NAME],
]);

router.get('/diagnostico-geral-envio', async (_req, res, next) => {
  try {
    await refreshAliExpressCatalog();
    const products = getAliExpressCatalog();
    const profile = await getMlAccountShippingProfile(true);
    const byMlId = catalogIndexByMlItem(products);

    let subidosMl = {
      total_encontrados: 0,
      ativos: 0,
      pausados: 0,
      sob_revisao_ou_inativos: 0,
      em_me2: 0,
      em_me2_elegiveis: 0,
      em_me2_marcas_famosas: 0,
      em_me2_riscos_politica: 0,
      sem_me2_ok: 0,
      em_me1: 0,
      em_custom: 0,
      em_not_specified: 0,
      fechados: 0,
      distribuicao_categorias: [],
      amostra_me2: [],
      alertas_moderacao_e_risco: {
        total_abertos_com_risco: 0,
        moderados_pelo_ml: 0,
        preventivos_anvisa_fotos: 0,
        itens: [],
      },
    };

    if (profile.connected) {
      const { allIds } = await collectAllAccountListingIds(profile.user_id);
      const liveItems = await fetchMultiItemsFast(allIds);
      const openItems = liveItems.filter((it) => it.status !== 'closed');
      const me2Items = openItems.filter((it) => !isItemShippingFreeOfMe2(it.shipping || {}));
      const me2Famous = me2Items.filter((it) => Boolean(detectFamousBrand(it)));
      const me2PolicyRisk = me2Items.filter(
        (it) =>
          !detectFamousBrand(it) &&
          (Boolean(detectMlPolicyRisk(it)) ||
            Boolean(detectLiveModerationAlert(it)) ||
            Boolean(byMlId.get(String(it.id))?.risco_politica_ml))
      );
      const cleanItems = openItems.filter((it) => isItemShippingFreeOfMe2(it.shipping || {}));

      const catCountMap = new Map();
      for (const it of openItems) {
        const cid = String(it.category_id || 'SEM_CAT');
        const cur = catCountMap.get(cid) || {
          category_id: cid,
          nome: KNOWN_CATEGORY_NAMES.get(cid) || cid,
          qtd: 0,
          sem_me2: 0,
          em_me2: 0,
          homologada_outros: VERIFIED_NON_ME2_CATEGORY_IDS.has(cid),
        };
        cur.qtd += 1;
        if (isItemShippingFreeOfMe2(it.shipping || {})) cur.sem_me2 += 1;
        else cur.em_me2 += 1;
        catCountMap.set(cid, cur);
      }

      const riskItemsOpen = [];
      let moderadosPeloMl = 0;
      let preventivosAnvisaFotos = 0;

      for (const it of openItems) {
        const linked = byMlId.get(String(it.id));
        const sellerSkuAttr = (it.attributes || []).find((a) => a.id === 'SELLER_SKU')?.value_name;
        const liveMod = detectLiveModerationAlert(it);
        const policyRisk =
          linked?.risco_politica_ml
            ? linked.motivo_risco_politica_ml
            : detectMlPolicyRisk(it) || (linked ? detectMlPolicyRisk(linked) : null);

        // Exclude pure famous-brand paused items that don't have ML moderation infractions or ANVISA/photo risk
        if (!liveMod && !policyRisk) continue;

        if (liveMod) moderadosPeloMl += 1;
        else preventivosAnvisaFotos += 1;

        riskItemsOpen.push({
          id: it.id,
          sku: linked?.sku || sellerSkuAttr || null,
          title: it.title || linked?.titulo_ml || '',
          status: it.status,
          sub_status: it.sub_status || [],
          category_id: it.category_id,
          shipping_mode: it.shipping?.mode || 'not_specified',
          origem_alerta: liveMod ? 'moderacao_ml_ativa' : 'preventivo_anvisa_fotos',
          motivo: liveMod || policyRisk,
        });
      }

      subidosMl = {
        total_encontrados: openItems.length,
        ativos: openItems.filter((it) => it.status === 'active').length,
        pausados: openItems.filter((it) => it.status === 'paused').length,
        sob_revisao_ou_inativos: openItems.filter((it) =>
          ['under_review', 'inactive'].includes(String(it.status || '').toLowerCase())
        ).length,
        em_me2: me2Items.length,
        em_me2_elegiveis: Math.max(0, me2Items.length - me2Famous.length - me2PolicyRisk.length),
        em_me2_marcas_famosas: me2Famous.length,
        em_me2_riscos_politica: me2PolicyRisk.length,
        sem_me2_ok: cleanItems.length,
        em_me1: cleanItems.filter((it) => it.shipping?.mode === 'me1').length,
        em_custom: cleanItems.filter((it) => it.shipping?.mode === 'custom').length,
        em_not_specified: cleanItems.filter((it) => it.shipping?.mode === 'not_specified').length,
        fechados: liveItems.filter((it) => it.status === 'closed').length,
        distribuicao_categorias: [...catCountMap.values()].sort((a, b) => b.qtd - a.qtd),
        amostra_me2: me2Items.slice(0, 8).map((it) => ({
          id: it.id,
          title: it.title,
          status: it.status,
          category_id: it.category_id,
          shipping_mode: it.shipping?.mode || 'me2',
          marca_famosa:
            detectFamousBrand(it) ||
            detectLiveModerationAlert(it) ||
            detectMlPolicyRisk(it) ||
            null,
        })),
        alertas_moderacao_e_risco: {
          total_abertos_com_risco: riskItemsOpen.length,
          moderados_pelo_ml: moderadosPeloMl,
          preventivos_anvisa_fotos: preventivosAnvisaFotos,
          itens: riskItemsOpen.slice(0, 60),
        },
      };
    }

    const unuploaded = products.filter((p) => !p.ml_item_id);
    const unuploadedFamous = unuploaded.filter((p) => Boolean(p.marca_famosa_quarentena));
    const unuploadedPolicyRisk = unuploaded.filter(
      (p) => !p.marca_famosa_quarentena && Boolean(p.risco_politica_ml)
    );
    const unuploadedEligible = unuploaded.filter(
      (p) => !p.marca_famosa_quarentena && !p.risco_politica_ml
    );
    const gateOkAntiMe2 = unuploadedEligible.filter(
      (p) => getMlReviewGate(p).ok && p.ml_preflight?.anti_me2_verified
    );
    const pendentesPreparo = unuploadedEligible.filter(
      (p) => !getMlReviewGate(p).ok || !p.ml_preflight?.anti_me2_verified
    );
    const totalFamousAll = products.filter((p) => Boolean(p.marca_famosa_quarentena)).length;
    const totalPolicyRiskAll = products.filter((p) => Boolean(p.risco_politica_ml)).length;

    res.json({
      ok: true,
      conta_ml: profile,
      subidos_ml: subidosMl,
      catalogo_1000: {
        total: products.length,
        ja_publicados: products.length - unuploaded.length,
        nao_publicados: unuploaded.length,
        nao_publicados_elegiveis: unuploadedEligible.length,
        marcas_famosas_quarentena: unuploadedFamous.length,
        marcas_famosas_total_base: totalFamousAll,
        riscos_politica_nao_publicados: unuploadedPolicyRisk.length,
        riscos_politica_total_base: totalPolicyRiskAll,
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

router.post('/higienizar-riscos-ml', async (req, res, next) => {
  try {
    await refreshAliExpressCatalog();
    const dryRun = Boolean(req.body?.dry_run);
    const limite = Math.min(Math.max(Number(req.body?.limite) || 25, 1), 60);
    const ignorarIdsSet = new Set(
      (Array.isArray(req.body?.ignorar_ids) ? req.body.ignorar_ids : []).map((id) => String(id).trim())
    );
    const profile = await getMlAccountShippingProfile(true);
    if (!profile.connected) {
      return res.status(409).json({
        error: 'Conecte a conta do Mercado Livre primeiro para higienizar os anúncios com risco.',
      });
    }

    const { allIds, dbRowsByMlId } = await collectAllAccountListingIds(profile.user_id);
    const liveItems = await fetchMultiItemsFast(allIds);
    const products = getAliExpressCatalog();
    const byMlId = catalogIndexByMlItem(products);
    const bySku = new Map();
    const byAliId = new Map();
    for (let i = 0; i < products.length; i += 1) {
      const p = products[i];
      if (p.sku) bySku.set(String(p.sku).toUpperCase(), i);
      if (p.aliexpress_item_id) byAliId.set(String(p.aliexpress_item_id), i);
    }

    const candidates = [];
    for (const live of liveItems) {
      const mlId = String(live.id);
      if (ignorarIdsSet.has(mlId)) continue;
      const dbRow = dbRowsByMlId.get(mlId) || null;
      const sellerSkuAttr = (live.attributes || []).find((a) => a.id === 'SELLER_SKU')?.value_name;

      let prodIdx = -1;
      const directProd = byMlId.get(mlId);
      if (directProd) {
        prodIdx = products.findIndex((p) => p.sku === directProd.sku);
      } else if (sellerSkuAttr && bySku.has(String(sellerSkuAttr).toUpperCase())) {
        prodIdx = bySku.get(String(sellerSkuAttr).toUpperCase());
      } else if (dbRow?.source_item_id && byAliId.has(String(dbRow.source_item_id))) {
        prodIdx = byAliId.get(String(dbRow.source_item_id));
      }
      const matched = prodIdx >= 0 ? products[prodIdx] : null;
      const liveMod = detectLiveModerationAlert(live);
      const policyRisk =
        matched?.risco_politica_ml
          ? matched.motivo_risco_politica_ml
          : detectMlPolicyRisk(live) || (matched ? detectMlPolicyRisk(matched) : null);

      if (!liveMod && !policyRisk) continue;
      const subTags = Array.isArray(live.sub_status)
        ? live.sub_status.map((s) => String(s).toLowerCase())
        : [];
      const alreadyTerminatedByMl =
        live.status === 'closed' ||
        (live.status === 'inactive' &&
          subTags.some((s) => ['cancelled', 'forbidden', 'deleted'].includes(s)));
      if (alreadyTerminatedByMl && (!matched || !matched.ml_item_id)) continue;

      candidates.push({
        live,
        mlId,
        prodIdx,
        matched,
        reason: liveMod || policyRisk || 'Política ML (ANVISA / Fotos Sensíveis)',
      });
    }

    const slice = candidates.slice(0, limite);
    let fechadosNoMl = 0;
    let jaFechadosOuCancelados = 0;
    let quarentenadosCatalogo = 0;
    let falhas = 0;
    let catalogChanged = false;
    const detalhes = [];

    // Process in fast parallel waves of 5
    for (let w = 0; w < slice.length; w += 5) {
      const wave = slice.slice(w, w + 5);
      await Promise.all(
        wave.map(async (entry) => {
          const { live, mlId, prodIdx, matched, reason } = entry;
          if (dryRun) {
            detalhes.push({
              ml_item_id: mlId,
              sku: matched?.sku || null,
              title: live.title || matched?.titulo_ml || '',
              status_antes: live.status,
              acao: 'simulacao_fechar_e_isolar',
              motivo: reason,
              ok: true,
            });
            return;
          }

          let finalMlStatus = live.status;
          try {
            if (live.status !== 'closed') {
              await mlFetch(`/items/${encodeURIComponent(mlId)}`, {
                method: 'PUT',
                body: { status: 'paused' },
              }).catch(() => null);
              const closedRes = await mlFetch(`/items/${encodeURIComponent(mlId)}`, {
                method: 'PUT',
                body: { status: 'closed' },
              }).catch(() => null);
              if (closedRes?.status === 'closed') {
                finalMlStatus = 'closed';
                fechadosNoMl += 1;
              } else {
                const recheck = await mlFetch(`/items/${encodeURIComponent(mlId)}`).catch(() => live);
                finalMlStatus = recheck?.status || live.status;
                if (finalMlStatus === 'closed' || finalMlStatus === 'inactive') {
                  jaFechadosOuCancelados += 1;
                } else {
                  fechadosNoMl += 1;
                }
              }
            } else {
              jaFechadosOuCancelados += 1;
            }

            if (finalMlStatus === 'closed') {
              await mlFetch(`/items/${encodeURIComponent(mlId)}`, {
                method: 'PUT',
                body: { deleted: 'true' },
              }).catch(() => null);
            }

            await query("UPDATE listings SET status='closed' WHERE ml_item_id=$1", [mlId]).catch(
              () => null
            );

            if (prodIdx >= 0) {
              products[prodIdx] = {
                ...products[prodIdx],
                ml_item_id: null,
                ml_permalink: null,
                ml_item_id_risco_fechado: mlId,
                risco_politica_ml: true,
                motivo_risco_politica_ml: reason,
                ml_revisao: null,
                status_anuncio: 'quarentena_politica_ml',
                atualizado_em: new Date().toISOString(),
              };
              quarentenadosCatalogo += 1;
              catalogChanged = true;
            }

            detalhes.push({
              ml_item_id: mlId,
              sku: matched?.sku || null,
              title: live.title || matched?.titulo_ml || '',
              status_antes: live.status,
              status_depois: finalMlStatus,
              acao: 'fechado_e_quarentenado',
              motivo: reason,
              ok: true,
            });
          } catch (err) {
            falhas += 1;
            detalhes.push({
              ml_item_id: mlId,
              sku: matched?.sku || null,
              title: live.title || matched?.titulo_ml || '',
              status_antes: live.status,
              motivo: reason,
              error: err.message,
              ok: false,
            });
          }
        })
      );
    }

    if (catalogChanged && !dryRun) {
      await persistCatalog(products);
    }

    res.json({
      ok: falhas === 0,
      dry_run: dryRun,
      total_identificados: candidates.length,
      processados: slice.length,
      restantes_pendentes: Math.max(0, candidates.length - slice.length),
      fechados_no_ml: fechadosNoMl,
      ja_fechados_ou_cancelados: jaFechadosOuCancelados,
      quarentenados_catalogo: quarentenadosCatalogo,
      falhas,
      detalhes,
    });
  } catch (err) {
    next(err);
  }
});

export async function tryConvertExistingItemInPlace(liveItem, synthProduct, targetCatId, profile, estrategia) {
  const oldId = String(liveItem.id);

  // 1. Try ME1 in-place if enabled on seller account
  if (profile.me1_enabled && estrategia !== 'forcar_mlb3530') {
    try {
      await mlFetch(`/items/${encodeURIComponent(oldId)}`, {
        method: 'PUT',
        body: {
          status: 'paused',
          shipping: { mode: 'me1', local_pick_up: false, free_shipping: true },
        },
      });
      const checkMe1 = await mlFetch(`/items/${encodeURIComponent(oldId)}`);
      if (isItemShippingFreeOfMe2(checkMe1.shipping || {})) {
        const pausedMe1 =
          checkMe1.status === 'active'
            ? (await ensureItemStrictlyPaused(oldId)) || checkMe1
            : checkMe1;
        return { converted: pausedMe1, lastPutError: null };
      }
    } catch {}
  }

  // 2. Try category + attributes + shipping conversion in-place when 0 sales
  if (Number(liveItem.sold_quantity || 0) > 0) {
    return { converted: null, lastPutError: 'Anúncio já possui vendas; requer substituição.' };
  }

  const catTries =
    targetCatId === OUTROS_OUTROS_LEAF_ID
      ? [OUTROS_OUTROS_LEAF_ID]
      : [targetCatId, OUTROS_OUTROS_LEAF_ID];

  let lastPutError = null;
  for (const tryCat of catTries) {
    const catAttrs = await buildHighScoreMlAttributes(synthProduct, tryCat);

    // Attempt A0: Single PUT with category_id + attributes + custom R$ 0,00 table (no label, collects buyer address + allows tracking PUT)
    try {
      await mlFetch(`/items/${encodeURIComponent(oldId)}`, {
        method: 'PUT',
        body: {
          category_id: tryCat,
          attributes: catAttrs,
          status: 'paused',
          available_quantity: Math.min(Math.max(Number(synthProduct.estoque_disponivel) || 3, 1), 3),
          shipping: {
            mode: 'custom',
            local_pick_up: false,
            free_shipping: true,
            costs: [{ description: 'Todo o Brasil — Frete Grátis (5 a 10 dias)', cost: 0 }],
          },
        },
      });
      const checkA0 = await mlFetch(`/items/${encodeURIComponent(oldId)}`);
      if (isItemShippingFreeOfMe2(checkA0.shipping || {})) {
        const pausedA0 =
          checkA0.status === 'active' ? (await ensureItemStrictlyPaused(oldId)) || checkA0 : checkA0;
        return { converted: pausedA0, lastPutError: null };
      }
    } catch (errA0) {
      lastPutError = errA0.message;
    }

    // Attempt A: Single PUT with category_id + attributes + not_specified R$ 0,00 free shipping table (no label)
    try {
      await mlFetch(`/items/${encodeURIComponent(oldId)}`, {
        method: 'PUT',
        body: {
          category_id: tryCat,
          attributes: catAttrs,
          status: 'paused',
          available_quantity: Math.min(Math.max(Number(synthProduct.estoque_disponivel) || 3, 1), 3),
          shipping: {
            mode: 'not_specified',
            local_pick_up: false,
            free_shipping: true,
            costs: [{ description: 'Todo o Brasil — Frete Grátis (5 a 10 dias)', cost: 0 }],
          },
        },
      });
      const checkA = await mlFetch(`/items/${encodeURIComponent(oldId)}`);
      if (isItemShippingFreeOfMe2(checkA.shipping || {})) {
        const pausedA =
          checkA.status === 'active' ? (await ensureItemStrictlyPaused(oldId)) || checkA : checkA;
        return { converted: pausedA, lastPutError: null };
      }
    } catch (errA) {
      lastPutError = errA.message;
    }

    // Attempt B: Two-step PUT (1st change category+attributes so ML drops ME2, 2nd set not_specified)
    try {
      await mlFetch(`/items/${encodeURIComponent(oldId)}`, {
        method: 'PUT',
        body: {
          category_id: tryCat,
          attributes: catAttrs,
          status: 'paused',
        },
      });
      await mlFetch(`/items/${encodeURIComponent(oldId)}`, {
        method: 'PUT',
        body: {
          status: 'paused',
          available_quantity: Math.min(Math.max(Number(synthProduct.estoque_disponivel) || 3, 1), 3),
          shipping: {
            mode: 'not_specified',
            local_pick_up: false,
          },
        },
      }).catch(() => null);
      const checkB = await mlFetch(`/items/${encodeURIComponent(oldId)}`);
      if (isItemShippingFreeOfMe2(checkB.shipping || {})) {
        const pausedB =
          checkB.status === 'active' ? (await ensureItemStrictlyPaused(oldId)) || checkB : checkB;
        return { converted: pausedB, lastPutError: null };
      }
    } catch (errB) {
      lastPutError = errB.message;
    }

    // Attempt C: Minimal category-only PUT
    try {
      await mlFetch(`/items/${encodeURIComponent(oldId)}`, {
        method: 'PUT',
        body: { category_id: tryCat },
      });
      await mlFetch(`/items/${encodeURIComponent(oldId)}`, {
        method: 'PUT',
        body: { shipping: { mode: 'not_specified', local_pick_up: false } },
      }).catch(() => null);
      const checkC = await mlFetch(`/items/${encodeURIComponent(oldId)}`);
      if (isItemShippingFreeOfMe2(checkC.shipping || {})) {
        const pausedC =
          checkC.status === 'active' ? (await ensureItemStrictlyPaused(oldId)) || checkC : checkC;
        return { converted: pausedC, lastPutError: null };
      }
    } catch (errC) {
      lastPutError = errC.message;
    }
  }

  return { converted: null, lastPutError };
}

router.post('/migrar-subidos-me2', async (req, res, next) => {
  try {
    await refreshAliExpressCatalog();
    const limite = Math.min(Math.max(Number(req.body?.limite) || 6, 1), 15);
    const estrategia = String(req.body?.estrategia || 'cascata').toLowerCase();
    const dryRun = Boolean(req.body?.dry_run);
    const incluirMarcasFamosas = Boolean(req.body?.incluir_marcas_famosas);
    const ignorarIdsSet = new Set(
      (Array.isArray(req.body?.ignorar_ids) ? req.body.ignorar_ids : []).map((id) => String(id).trim())
    );

    const profile = await getMlAccountShippingProfile();
    if (!profile.connected) {
      return res.status(409).json({
        error: 'Conta do Mercado Livre desconectada no backend. Conecte via OAuth primeiro.',
      });
    }

    const { allIds, dbRowsByMlId } = await collectAllAccountListingIds(profile.user_id);
    const liveItems = await fetchMultiItemsFast(allIds);
    const allMe2Open = liveItems.filter(
      (it) => it.status !== 'closed' && !isItemShippingFreeOfMe2(it.shipping || {})
    );
    const me2Queue = allMe2Open.filter((it) => !ignorarIdsSet.has(String(it.id)));

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
    let reservadosMarcaFamosa = 0;
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
      const detectedBrand =
        detectFamousBrand(liveItem) || (matchedProduct ? detectFamousBrand(matchedProduct) : null);
      const detectedPolicyRisk =
        detectMlPolicyRisk(liveItem) ||
        (matchedProduct?.risco_politica_ml
          ? matchedProduct.motivo_risco_politica_ml
          : matchedProduct
            ? detectMlPolicyRisk(matchedProduct)
            : null);
      const liveModAlert = detectLiveModerationAlert(liveItem);
      const modLocked = isLiveItemModerationLocked(liveItem);

      if (detectedPolicyRisk || (liveModAlert && !detectedBrand)) {
        reservadosMarcaFamosa += 1;
        if (!dryRun) {
          await closeMe2ItemSafely(oldId);
          await query("UPDATE listings SET status='closed' WHERE ml_item_id=$1", [oldId]).catch(
            () => null
          );
        }
        if (prodIdx >= 0) {
          products[prodIdx] = {
            ...products[prodIdx],
            ml_item_id: null,
            ml_permalink: null,
            ml_item_id_risco_fechado: oldId,
            risco_politica_ml: true,
            motivo_risco_politica_ml: detectedPolicyRisk || liveModAlert,
            ml_revisao: null,
            status_anuncio: 'quarentena_politica_ml',
          };
          catalogChanged = true;
        }
        resultados.push({
          ok: true,
          reservado_marca_famosa: true,
          acao: 'fechado_e_quarentenado_politica_ml',
          ml_item_id_antigo: oldId,
          ml_item_id_novo: oldId,
          sku: matchedProduct?.sku || sellerSkuAttr || null,
          marca_detectada: detectedPolicyRisk || liveModAlert || 'Política ML',
          categoria_aplicada: liveItem.category_id,
          modo_envio: 'quarentena_politica_ml',
        });
        continue;
      }

      if (!incluirMarcasFamosas && (detectedBrand || modLocked)) {
        reservadosMarcaFamosa += 1;
        if (!dryRun && liveItem.status === 'active') {
          await mlFetch(`/items/${encodeURIComponent(oldId)}`, {
            method: 'PUT',
            body: { status: 'paused' },
          }).catch(() => null);
        }
        if (prodIdx >= 0) {
          products[prodIdx] = {
            ...products[prodIdx],
            marca_famosa_quarentena: true,
            marca_famosa_detectada: detectedBrand || 'Moderação ML',
            status_anuncio: 'aguardando_procedimento_marca',
          };
          catalogChanged = true;
        }
        resultados.push({
          ok: true,
          reservado_marca_famosa: true,
          acao: 'reservado_marca_famosa',
          ml_item_id_antigo: oldId,
          ml_item_id_novo: oldId,
          sku: matchedProduct?.sku || sellerSkuAttr || null,
          marca_detectada: detectedBrand || (liveItem.sub_status || []).join(',') || 'Marca Protegida',
          categoria_aplicada: liveItem.category_id,
          modo_envio: 'reservado_bpp',
        });
        continue;
      }

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

        const livePics = (liveItem.pictures || [])
          .map((pic) => pic.secure_url || pic.url)
          .filter(Boolean);

        const synthProduct = matchedProduct
          ? {
              ...matchedProduct,
              imagens:
                getProductImages(matchedProduct).length >= 4
                  ? getProductImages(matchedProduct)
                  : livePics,
            }
          : hydrateProductAntiMe2({
              sku: sellerSkuAttr || `MLMIG-${oldId}`,
              codigo_interno: sellerSkuAttr || oldId,
              aliexpress_item_id: dbRow?.source_item_id || oldId,
              titulo_ml: liveItem.title || liveItem.family_name || 'Produto Pronta Entrega',
              descricao_ml_otimizada: `${liveItem.title || 'Produto'}. Estoque no Brasil com frete grátis e prazo de 5 a 10 dias corridos.`,
              preco_venda_ml_sugerido: Math.max(Number(liveItem.price) || ML_MIN_PRICE, ML_MIN_PRICE),
              preco_custo_aliexpress_brl: Number(dbRow?.source_price) || 29.9,
              imagens: livePics,
              qtd_imagens: livePics.length,
              marca: 'Genérica',
              modelo:
                (liveItem.attributes || []).find((a) => a.id === 'MODEL')?.value_name || 'Padrão',
              estoque_disponivel: Math.min(Math.max(Number(liveItem.available_quantity) || 3, 1), 3),
            });

        const { converted: convertedItem, lastPutError } = await tryConvertExistingItemInPlace(
          liveItem,
          synthProduct,
          targetCatId,
          profile,
          estrategia
        );

        if (convertedItem) {
          convertidosInPlace += 1;
          const descForConverted = ensureFreeShippingNoticeInDescription(
            synthProduct.descricao_ml_otimizada || ''
          );
          if (descForConverted.length >= 100) {
            await mlFetch(`/items/${encodeURIComponent(convertedItem.id)}/description`, {
              method: 'PUT',
              body: { plain_text: descForConverted },
            }).catch(() => null);
          }

          if (prodIdx >= 0) {
            try {
              const p = products[prodIdx];
              const finalCat = convertedItem.category_id || targetCatId;
              const updatedProd = {
                ...p,
                titulo_ml: sanitizeMlTitle(p.titulo_ml || convertedItem.title || ''),
                descricao_ml_otimizada: ensureFreeShippingNoticeInDescription(
                  p.descricao_ml_otimizada || ''
                ),
                estoque_disponivel: Math.min(Math.max(Number(p.estoque_disponivel) || 3, 1), 3),
                ml_item_id: convertedItem.id,
                status_anuncio: 'paused',
                ml_shipping: convertedItem.shipping,
              };
              const fp = buildMlReviewFingerprint(updatedProd, finalCat);
              updatedProd.ml_preflight = {
                ...(p.ml_preflight || {}),
                ok: true,
                anti_me2_verified: true,
                estrategia_aplicada: 'convertido_in_place',
                checked_at: new Date().toISOString(),
                blockers: [],
                categoria_ml_id: finalCat,
                fingerprint: fp,
              };
              updatedProd.ml_revisao = {
                aprovado: true,
                aprovado_em: new Date().toISOString(),
                aprovado_por: 'migracao_anti_me2',
                categoria_ml_id: finalCat,
                checks: Object.fromEntries(ML_REVIEW_CHECKS.map((k) => [k, true])),
                observacoes: `Convertido in-place para ${convertedItem.shipping?.mode} (${finalCat})`,
                fingerprint: fp,
              };
              products[prodIdx] = updatedProd;
              catalogChanged = true;
            } catch {}
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

        // 3. ML locked category_id/ME2 on oldId -> Validate clean replacement, close oldId, and recreate!
        let fallbackDesc = synthProduct.descricao_ml_otimizada || '';
        if (!fallbackDesc || fallbackDesc.length < 100) {
          try {
            const d = await mlFetch(`/items/${encodeURIComponent(oldId)}/description`);
            if (d?.plain_text) fallbackDesc = d.plain_text;
          } catch {}
        }
        synthProduct.descricao_ml_otimizada =
          fallbackDesc ||
          `${liveItem.title || 'Produto'}. Estoque no Brasil com frete grátis e prazo de 5 a 10 dias corridos.`;
        if (livePics.length >= 4) {
          // Prefer already ML-moderated mlstatic pictures when recreating an existing item
          synthProduct.imagens = livePics;
          synthProduct.qtd_imagens = livePics.length;
        }

        const { prepared, report } = await runMlPreflight(synthProduct, {
          ignore_existing_ml_item: true,
          fast_batch: true,
          estrategia,
        });

        if (!report.ok || !report.payload) {
          throw new Error(
            `In-place recusado (${lastPutError || 'bloqueado'}) e substituto falhou: ${(report.blockers || []).join('; ')}`
          );
        }

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
      await sleep(160);
    }

    if (catalogChanged) {
      await persistCatalog(products);
    }

    const restantesFila = Math.max(0, me2Queue.length - slice.length);
    const restantesElegiveis = Math.max(
      0,
      allMe2Open.filter(
        (it) =>
          !ignorarIdsSet.has(String(it.id)) &&
          !slice.some((s) => String(s.id) === String(it.id)) &&
          (incluirMarcasFamosas || (!detectFamousBrand(it) && !isLiveItemModerationLocked(it)))
      ).length
    );

    res.json({
      ok: falhas === 0,
      dry_run: dryRun,
      total_em_me2_antes: allMe2Open.length,
      processados: slice.length,
      convertidos_in_place: convertidosInPlace,
      recriados_sem_me2: recriadosSemMe2,
      reservados_marca_famosa: reservadosMarcaFamosa,
      falhas,
      restantes_em_me2: restantesElegiveis,
      restantes_fila: restantesFila,
      resultados,
    });
  } catch (err) {
    next(err);
  }
});

router.post('/preparar-lote-catalogo', async (req, res, next) => {
  try {
    await refreshAliExpressCatalog();
    const limite = Math.min(Math.max(Number(req.body?.limite) || 20, 1), 40);
    const estrategia = String(req.body?.estrategia || 'cascata').toLowerCase();
    const aprovarRevisao = req.body?.aprovar_revisao !== false;
    const fornecedor = String(req.body?.fornecedor || '').trim();
    const revalidarTodos = Boolean(req.body?.revalidar_todos);
    const incluirMarcasFamosas = Boolean(req.body?.incluir_marcas_famosas);
    const ignorarSkusSet = new Set(
      (Array.isArray(req.body?.ignorar_skus) ? req.body.ignorar_skus : []).map((s) =>
        String(s).trim().toUpperCase()
      )
    );

    const profile = await getMlAccountShippingProfile();
    if (!profile.connected) {
      return res.status(409).json({
        error: 'Conecte a conta do Mercado Livre primeiro para validar payloads oficiais em lote.',
      });
    }

    const products = getAliExpressCatalog();
    const pendingIndices = [];
    let reservadosMarcaFamosa = 0;
    let reservadosRiscoPolitica = 0;
    let famousMarkedChanged = false;

    for (let i = 0; i < products.length; i += 1) {
      const p = products[i];
      if (p.ml_item_id) continue;
      if (p.status_anuncio === 'verificar_estoque_fornecedor') continue;
      if (ignorarSkusSet.has(String(p.sku || '').toUpperCase())) continue;
      if (
        fornecedor &&
        p.fornecedor_nome !== fornecedor &&
        String(p.fornecedor_loja_id) !== fornecedor
      ) {
        continue;
      }
      if (!incluirMarcasFamosas && p.marca_famosa_quarentena) {
        reservadosMarcaFamosa += 1;
        if (p.status_anuncio !== 'aguardando_procedimento_marca') {
          products[i] = {
            ...p,
            status_anuncio: 'aguardando_procedimento_marca',
          };
          famousMarkedChanged = true;
        }
        continue;
      }
      const pRisk = p.risco_politica_ml
        ? p.motivo_risco_politica_ml || 'Política ML'
        : detectMlPolicyRisk(p);
      if (pRisk && p.risco_politica_liberado_manualmente !== true) {
        reservadosRiscoPolitica += 1;
        if (!p.risco_politica_ml || p.status_anuncio !== 'quarentena_politica_ml') {
          products[i] = {
            ...p,
            risco_politica_ml: true,
            motivo_risco_politica_ml: pRisk,
            ml_revisao: null,
            status_anuncio: 'quarentena_politica_ml',
          };
          famousMarkedChanged = true;
        }
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

    // Process in controlled parallel micro-chunks of 5 to stay fast (< 5s) on Vercel Serverless
    for (let c = 0; c < sliceIndices.length; c += 5) {
      const group = sliceIndices.slice(c, c + 5);
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

    if (sliceIndices.length > 0 || famousMarkedChanged) {
      await persistCatalog(products);
    }

    const restantesPendentes = Math.max(0, pendingIndices.length - sliceIndices.length);
    const totalAprovados = products.filter(
      (p) =>
        !p.ml_item_id &&
        !p.marca_famosa_quarentena &&
        !p.risco_politica_ml &&
        getMlReviewGate(p).ok
    ).length;

    res.json({
      ok: comBloqueio === 0,
      processados: sliceIndices.length,
      preparados_ok: preparadosOk,
      com_bloqueio: comBloqueio,
      reservados_marca_famosa: reservadosMarcaFamosa,
      reservados_risco_politica: reservadosRiscoPolitica,
      restantes_pendentes: restantesPendentes,
      total_aprovados_prontos_para_subir: totalAprovados,
      resultados,
    });
  } catch (err) {
    next(err);
  }
});

// ============================================================================
// CENTRAL DE EMERGÊNCIA, RAIO-X OFICIAL DE MODERAÇÕES & SANEAMENTO ML (100% PAUSADO)
// ============================================================================

async function fetchAccountOfficialInfractions(userId, maxPages = 4) {
  const byItemId = new Map();
  const groupedReasons = new Map();
  if (!userId) return { byItemId, list: [] };

  for (let page = 0; page < maxPages; page += 1) {
    const offset = page * 50;
    try {
      const data = await mlFetch(
        `/moderations/infractions/${encodeURIComponent(userId)}?limit=50&offset=${offset}`
      );
      const infractions = Array.isArray(data?.infractions)
        ? data.infractions
        : Array.isArray(data?.results)
          ? data.results
          : Array.isArray(data)
            ? data
            : [];
      if (!infractions.length) break;

      for (const inf of infractions) {
        const itemId = String(inf?.related_item_id || inf?.element_id || '').trim();
        const reason = String(inf?.reason || inf?.filter_subgroup || 'Moderação de política ML')
          .replace(/<[^>]+>/g, ' ')
          .replace(/\s+/g, ' ')
          .trim();
        const remedy = String(inf?.remedy || '')
          .replace(/<[^>]+>/g, ' ')
          .replace(/\s+/g, ' ')
          .trim();
        const subgroup = String(inf?.filter_subgroup || inf?.element_type || 'policy').trim();

        if (/^MLB\d+$/i.test(itemId) && !byItemId.has(itemId)) {
          byItemId.set(itemId, { reason, remedy, subgroup, date: inf?.date_created || null });
        }

        const rKey = `${subgroup}|${reason.slice(0, 120)}`;
        const cur = groupedReasons.get(rKey) || {
          subgroup,
          reason,
          remedy,
          qtd: 0,
          exemplos_ids: [],
        };
        cur.qtd += 1;
        if (/^MLB\d+$/i.test(itemId) && cur.exemplos_ids.length < 5 && !cur.exemplos_ids.includes(itemId)) {
          cur.exemplos_ids.push(itemId);
        }
        groupedReasons.set(rKey, cur);
      }

      if (infractions.length < 50) break;
    } catch {
      break;
    }
  }

  return {
    byItemId,
    list: [...groupedReasons.values()].sort((a, b) => b.qtd - a.qtd),
  };
}

function classifyLiveMlItemState(liveItem, matchedProduct, infractionInfo, isDuplicateOpen) {
  const status = String(liveItem?.status || '').toLowerCase();
  const subs = Array.isArray(liveItem?.sub_status)
    ? liveItem.sub_status.map((s) => String(s).toLowerCase())
    : [];
  const tags = Array.isArray(liveItem?.tags)
    ? liveItem.tags.map((t) => String(t).toLowerCase())
    : [];
  const freeOfMe2 = isItemShippingFreeOfMe2(liveItem?.shipping || {});
  const policyRisk =
    matchedProduct?.risco_politica_ml
      ? matchedProduct.motivo_risco_politica_ml
      : detectMlPolicyRisk(liveItem) || (matchedProduct ? detectMlPolicyRisk(matchedProduct) : null);
  const famousBrand =
    detectFamousBrand(liveItem) || (matchedProduct ? detectFamousBrand(matchedProduct) : null);

  const infText = `${infractionInfo?.subgroup || ''} ${infractionInfo?.reason || ''} ${infractionInfo?.remedy || ''}`.toLowerCase();

  const hasFatalSub = subs.some((s) =>
    ['forbidden', 'cancelled', 'intellectual_property', 'brand_protection', 'suspended', 'held', 'deleted'].includes(s)
  );
  const isIrrecoverableInfraction =
    /proibid|cancelad|propriedade\s+intelectual|marca|medicament|sa[uú]de|anvisa|anatel|duplicad|n[aã]o\s+[eé]\s+poss[ií]vel\s+reativar/i.test(
      infText
    );

  const isInativoPolitica =
    status === 'under_review' ||
    status === 'inactive' ||
    hasFatalSub ||
    subs.some((s) => ['waiting_for_patch', 'warning', 'moderation_penalty'].includes(s));

  const isIrrecoverable =
    Boolean(policyRisk) ||
    Boolean(famousBrand) ||
    Boolean(isDuplicateOpen) ||
    hasFatalSub ||
    status === 'inactive' ||
    isIrrecoverableInfraction;

  const hasPoorThumbnail =
    tags.includes('poor_quality_thumbnail') ||
    subs.some((s) => /picture|thumbnail|photo/i.test(s)) ||
    /foto|imagem|capa|fundo\s+branco|marca\s+d['’]?[aá]gua|texto|logo/i.test(infText);

  const hasIncompleteSpecs =
    tags.includes('incomplete_technical_specs') ||
    /ficha\s+t[eé]cnica|c[oó]digo\s+universal|gtin|ean|atribut/i.test(infText);

  const hasCategoryMismatch =
    /categoria|outros|recategoriz|miscategoriz/i.test(infText);

  const isPendingFix =
    !isIrrecoverable &&
    (hasPoorThumbnail || hasIncompleteSpecs || !freeOfMe2 || subs.includes('waiting_for_patch') || subs.includes('picture_download_pending'));

  const isCleanPaused =
    status === 'paused' &&
    !isInativoPolitica &&
    !isIrrecoverable &&
    !isPendingFix &&
    freeOfMe2;

  let diagnosticoCurto = 'Pausado limpo e pronto (sem ME2)';
  if (isDuplicateOpen) diagnosticoCurto = 'Duplicado aberto na conta (fechar cópia extra)';
  else if (policyRisk) diagnosticoCurto = `Política ML / ANVISA / Fotos (${policyRisk})`;
  else if (famousBrand) diagnosticoCurto = `Marca Registrada BPP (${famousBrand})`;
  else if (hasFatalSub || status === 'inactive')
    diagnosticoCurto = infractionInfo?.reason || `Penalizado/Inativo (${subs.join(', ') || status})`;
  else if (hasCategoryMismatch)
    diagnosticoCurto = infractionInfo?.reason || 'Conflito de categoria apontado pelo ML';
  else if (subs.includes('waiting_for_patch'))
    diagnosticoCurto = infractionInfo?.reason || 'Pausado aguardando correção (waiting_for_patch)';
  else if (hasPoorThumbnail) diagnosticoCurto = 'Foto de capa com texto/logo ou fundo fora do branco (poor_quality_thumbnail)';
  else if (hasIncompleteSpecs) diagnosticoCurto = 'Ficha técnica / GTIN incompleto (incomplete_technical_specs)';
  else if (!freeOfMe2) diagnosticoCurto = `Ainda em ME2 (${liveItem?.shipping?.mode || 'me2'})`;
  else if (status === 'active') diagnosticoCurto = 'ATIVO na loja (pausar imediatamente)';

  return {
    status,
    subs,
    tags,
    freeOfMe2,
    policyRisk,
    famousBrand,
    isDuplicateOpen: Boolean(isDuplicateOpen),
    isInativoPolitica,
    isIrrecoverable,
    hasPoorThumbnail,
    hasIncompleteSpecs,
    hasCategoryMismatch,
    isPendingFix,
    isCleanPaused,
    diagnosticoCurto,
    infraction: infractionInfo || null,
  };
}

function findDuplicateOpenItemIds(openItems) {
  const duplicateIds = new Set();
  const seenByKey = new Map();
  // Sort so clean paused non-ME2 items win over penalized or ME2 ones
  const sorted = [...openItems].sort((a, b) => {
    const scoreItem = (it) => {
      let s = 0;
      if (isItemShippingFreeOfMe2(it.shipping || {})) s += 4;
      if (it.status === 'paused' && !(it.sub_status || []).includes('waiting_for_patch')) s += 3;
      if (!(it.tags || []).includes('poor_quality_thumbnail')) s += 2;
      return s;
    };
    return scoreItem(b) - scoreItem(a);
  });

  for (const it of sorted) {
    const skuAttr = (it.attributes || []).find((a) => a.id === 'SELLER_SKU')?.value_name;
    const normTitle = String(it.title || it.family_name || '')
      .normalize('NFD')
      .replace(/[\u0300-\u036f]/g, '')
      .toLowerCase()
      .replace(/\s+/g, ' ')
      .trim();
    const key = skuAttr ? `sku:${String(skuAttr).toUpperCase()}` : normTitle ? `title:${normTitle}` : '';
    if (!key) continue;
    if (seenByKey.has(key)) {
      duplicateIds.add(String(it.id));
    } else {
      seenByKey.set(key, String(it.id));
    }
  }
  return duplicateIds;
}

router.post('/pausar-tudo-conta-ml', async (req, res, next) => {
  try {
    await refreshAliExpressCatalog();
    const limite = Math.min(Math.max(Number(req.body?.limite) || 80, 1), 150);
    const ignorarIdsSet = new Set(
      (Array.isArray(req.body?.ignorar_ids) ? req.body.ignorar_ids : []).map((id) => String(id).trim())
    );

    const profile = await getMlAccountShippingProfile(true);
    if (!profile.connected) {
      return res.status(409).json({
        error: 'Conecte a conta do Mercado Livre primeiro para pausar os anúncios ativos.',
      });
    }

    // Fast scan specifically for ALL active items on the account
    const activeIdSet = new Set();
    try {
      let first = await mlFetch(
        `/users/${encodeURIComponent(profile.user_id)}/items/search?search_type=scan&status=active&limit=100`
      );
      let batch = Array.isArray(first?.results) ? first.results : [];
      for (const id of batch) if (id) activeIdSet.add(String(id));
      let scrollId = first?.scroll_id || '';
      const totalExpected = Number(first?.paging?.total || batch.length);
      let collected = batch.length;
      let pages = 1;
      while (scrollId && batch.length === 100 && collected < totalExpected && pages < 30) {
        const nextRes = await mlFetch(
          `/users/${encodeURIComponent(profile.user_id)}/items/search?search_type=scan&scroll_id=${encodeURIComponent(scrollId)}&limit=100`
        );
        batch = Array.isArray(nextRes?.results) ? nextRes.results : [];
        for (const id of batch) if (id) activeIdSet.add(String(id));
        collected += batch.length;
        scrollId = nextRes?.scroll_id || scrollId;
        pages += 1;
      }
    } catch {
      const { allIds } = await collectAllAccountListingIds(profile.user_id);
      const live = await fetchMultiItemsFast(allIds);
      for (const it of live) {
        if (it.status === 'active') activeIdSet.add(String(it.id));
      }
    }

    const allActiveIds = [...activeIdSet].filter((id) => !ignorarIdsSet.has(id));
    const slice = allActiveIds.slice(0, limite);
    const products = getAliExpressCatalog();
    const byMlId = catalogIndexByMlItem(products);
    let pausadosAgora = 0;
    let falhas = 0;
    let catalogChanged = false;
    const detalhes = [];

    for (let w = 0; w < slice.length; w += 10) {
      const wave = slice.slice(w, w + 10);
      await Promise.all(
        wave.map(async (mlId) => {
          try {
            const after = await ensureItemStrictlyPaused(mlId);
            const okPaused = !after || after.status !== 'active';
            if (okPaused) {
              pausadosAgora += 1;
              await query("UPDATE listings SET status='paused' WHERE ml_item_id=$1", [mlId]).catch(
                () => null
              );
              const prod = byMlId.get(mlId);
              if (prod) {
                prod.status_anuncio = after?.status || 'paused';
                catalogChanged = true;
              }
              detalhes.push({ ml_item_id: mlId, status: after?.status || 'paused', ok: true });
            } else {
              falhas += 1;
              detalhes.push({
                ml_item_id: mlId,
                status: after.status,
                ok: false,
                error: 'Continuou ativo após tentativa de pausa',
              });
            }
          } catch (err) {
            falhas += 1;
            detalhes.push({ ml_item_id: mlId, ok: false, error: err.message });
          }
        })
      );
    }

    if (catalogChanged) {
      await persistCatalog(products);
    }

    res.json({
      ok: falhas === 0,
      total_ativos_detectados: allActiveIds.length,
      processados: slice.length,
      pausados_agora: pausadosAgora,
      ativos_restantes: Math.max(0, allActiveIds.length - slice.length),
      falhas,
      detalhes,
    });
  } catch (err) {
    next(err);
  }
});

router.get('/raio-x-moderacoes-ml', async (_req, res, next) => {
  try {
    await refreshAliExpressCatalog();
    const profile = await getMlAccountShippingProfile(true);
    if (!profile.connected) {
      return res.status(409).json({
        error: 'Conecte a conta do Mercado Livre primeiro para carregar o Raio-X das pendências.',
      });
    }

    const [{ allIds }, infractionsData] = await Promise.all([
      collectAllAccountListingIds(profile.user_id),
      fetchAccountOfficialInfractions(profile.user_id, 4),
    ]);

    const liveItems = await fetchMultiItemsFast(allIds);
    const openItems = liveItems.filter((it) => it.status !== 'closed');
    const duplicateIds = findDuplicateOpenItemIds(openItems);
    const products = getAliExpressCatalog();
    const byMlId = catalogIndexByMlItem(products);

    let ativosNaLoja = 0;
    let pausadosLimposProntos = 0;
    let inativosPoliticasTotal = 0;
    let inativosIrrecuperaveis = 0;
    let inativosRecuperaveisPatch = 0;
    let pendentesCorrigirTotal = 0;
    let pendentesCapa = 0;
    let pendentesFichaGtin = 0;
    let pendentesMe2 = 0;
    let duplicadosAbertos = 0;
    let healthSum = 0;
    let healthCount = 0;

    const tagBreakdown = new Map();
    const amostraInativos = [];
    const amostraPendentes = [];

    for (const it of openItems) {
      const mlId = String(it.id);
      const matched = byMlId.get(mlId) || null;
      const inf = infractionsData.byItemId.get(mlId) || null;
      const isDup = duplicateIds.has(mlId);
      const c = classifyLiveMlItemState(it, matched, inf, isDup);

      if (typeof it.health === 'number' && it.health > 0) {
        healthSum += it.health <= 1 ? it.health * 100 : it.health;
        healthCount += 1;
      }

      if (c.status === 'active') ativosNaLoja += 1;
      if (isDup) duplicadosAbertos += 1;
      if (c.isCleanPaused) pausadosLimposProntos += 1;

      if (c.isInativoPolitica || c.isIrrecoverable) {
        inativosPoliticasTotal += 1;
        if (c.isIrrecoverable) inativosIrrecuperaveis += 1;
        else inativosRecuperaveisPatch += 1;

        if (amostraInativos.length < 30) {
          amostraInativos.push({
            id: mlId,
            sku: matched?.sku || (it.attributes || []).find((a) => a.id === 'SELLER_SKU')?.value_name || null,
            title: it.title || it.family_name || '',
            status: it.status,
            sub_status: c.subs,
            category_id: it.category_id,
            irrecuperavel: c.isIrrecoverable,
            motivo: c.diagnosticoCurto,
            remedy: inf?.remedy || null,
          });
        }
      } else if (c.isPendingFix) {
        pendentesCorrigirTotal += 1;
        if (c.hasPoorThumbnail) pendentesCapa += 1;
        if (c.hasIncompleteSpecs) pendentesFichaGtin += 1;
        if (!c.freeOfMe2) pendentesMe2 += 1;

        if (amostraPendentes.length < 30) {
          amostraPendentes.push({
            id: mlId,
            sku: matched?.sku || (it.attributes || []).find((a) => a.id === 'SELLER_SKU')?.value_name || null,
            title: it.title || it.family_name || '',
            status: it.status,
            tags: c.tags,
            category_id: it.category_id,
            shipping_mode: it.shipping?.mode || '',
            motivo: c.diagnosticoCurto,
          });
        }
      }

      for (const s of c.subs) {
        if (s === 'paused_by_seller') continue;
        tagBreakdown.set(`sub:${s}`, (tagBreakdown.get(`sub:${s}`) || 0) + 1);
      }
      for (const t of c.tags) {
        if (['poor_quality_thumbnail', 'incomplete_technical_specs', 'moderation_penalty', 'catalog_listing_eligible'].includes(t)) {
          tagBreakdown.set(`tag:${t}`, (tagBreakdown.get(`tag:${t}`) || 0) + 1);
        }
      }
    }

    // Sample official /performance score if item.health wasn't populated
    if (healthCount === 0 && openItems.length > 0) {
      try {
        const perf = await mlFetch(`/items/${encodeURIComponent(openItems[0].id)}/performance`);
        if (typeof perf?.score === 'number') {
          healthSum = perf.score <= 1 ? perf.score * 100 : perf.score;
          healthCount = 1;
        }
      } catch {}
    }

    res.json({
      ok: true,
      conta_ml: profile,
      resumo: {
        total_abertos_conta: openItems.length,
        fechados_conta: liveItems.length - openItems.length,
        ativos_na_loja: ativosNaLoja,
        pausados_limpos_prontos: pausadosLimposProntos,
        inativos_por_politicas: inativosPoliticasTotal,
        inativos_irrecuperaveis_fechar: inativosIrrecuperaveis,
        inativos_recuperaveis_patch: inativosRecuperaveisPatch,
        pendentes_para_corrigir: pendentesCorrigirTotal,
        pendentes_capa_fora_padrao: pendentesCapa,
        pendentes_ficha_gtin: pendentesFichaGtin,
        pendentes_envio_me2: pendentesMe2,
        duplicados_abertos: duplicadosAbertos,
        qualidade_media_ml_pct: healthCount > 0 ? Math.round(healthSum / healthCount) : null,
      },
      motivos_oficiais_ml: infractionsData.list.slice(0, 20),
      contagem_tags_substatus: [...tagBreakdown.entries()]
        .map(([chave, qtd]) => ({ chave, qtd }))
        .sort((a, b) => b.qtd - a.qtd),
      amostra_inativos: amostraInativos,
      amostra_pendentes: amostraPendentes,
    });
  } catch (err) {
    next(err);
  }
});

router.post('/sanear-pendencias-ml', async (req, res, next) => {
  try {
    await refreshAliExpressCatalog();
    const modo = String(req.body?.modo || 'corrigir_recuperaveis').toLowerCase();
    // fechar_irrecuperaveis | corrigir_recuperaveis | fechar_restantes_com_alerta
    const defaultLimit = modo === 'corrigir_recuperaveis' ? 12 : 35;
    const limite = Math.min(Math.max(Number(req.body?.limite) || defaultLimit, 1), 60);
    const fecharSeContinuarBloqueado = Boolean(req.body?.fechar_se_continuar_bloqueado);
    const ignorarIdsSet = new Set(
      (Array.isArray(req.body?.ignorar_ids) ? req.body.ignorar_ids : []).map((id) => String(id).trim())
    );

    const profile = await getMlAccountShippingProfile(true);
    if (!profile.connected) {
      return res.status(409).json({
        error: 'Conecte a conta do Mercado Livre primeiro para executar o saneamento.',
      });
    }

    const [{ allIds, dbRowsByMlId }, infractionsData] = await Promise.all([
      collectAllAccountListingIds(profile.user_id),
      fetchAccountOfficialInfractions(profile.user_id, 3),
    ]);
    const liveItems = await fetchMultiItemsFast(allIds);
    const openItems = liveItems.filter((it) => it.status !== 'closed');
    const duplicateIds = findDuplicateOpenItemIds(openItems);

    const products = getAliExpressCatalog();
    const byMlId = catalogIndexByMlItem(products);
    const bySku = new Map();
    const byAliId = new Map();
    for (let i = 0; i < products.length; i += 1) {
      const p = products[i];
      if (p.sku) bySku.set(String(p.sku).toUpperCase(), i);
      if (p.aliexpress_item_id) byAliId.set(String(p.aliexpress_item_id), i);
    }

    const queue = [];
    for (const it of openItems) {
      const mlId = String(it.id);
      if (ignorarIdsSet.has(mlId)) continue;
      const dbRow = dbRowsByMlId.get(mlId) || null;
      const sellerSkuAttr = (it.attributes || []).find((a) => a.id === 'SELLER_SKU')?.value_name;

      let prodIdx = -1;
      const directProd = byMlId.get(mlId);
      if (directProd) {
        prodIdx = products.findIndex((p) => p.sku === directProd.sku);
      } else if (sellerSkuAttr && bySku.has(String(sellerSkuAttr).toUpperCase())) {
        prodIdx = bySku.get(String(sellerSkuAttr).toUpperCase());
      } else if (dbRow?.source_item_id && byAliId.has(String(dbRow.source_item_id))) {
        prodIdx = byAliId.get(String(dbRow.source_item_id));
      }
      const matched = prodIdx >= 0 ? products[prodIdx] : null;
      const inf = infractionsData.byItemId.get(mlId) || null;
      const isDup = duplicateIds.has(mlId);
      const state = classifyLiveMlItemState(it, matched, inf, isDup);

      if (modo === 'fechar_irrecuperaveis') {
        if (!state.isIrrecoverable) continue;
        // Skip already-terminated inactive cancelled items if already unlinked in catalog
        if (
          it.status === 'inactive' &&
          state.subs.some((s) => ['cancelled', 'forbidden', 'deleted'].includes(s)) &&
          (!matched || !matched.ml_item_id)
        ) {
          continue;
        }
        queue.push({ it, mlId, prodIdx, matched, state });
      } else if (modo === 'corrigir_recuperaveis') {
        if (state.isIrrecoverable || state.isCleanPaused) continue;
        if (state.isPendingFix || state.isInativoPolitica || state.status === 'active') {
          queue.push({ it, mlId, prodIdx, matched, state });
        }
      } else if (modo === 'fechar_restantes_com_alerta') {
        if (state.isCleanPaused) continue;
        if (state.isInativoPolitica || state.isPendingFix || state.isIrrecoverable) {
          queue.push({ it, mlId, prodIdx, matched, state });
        }
      }
    }

    const slice = queue.slice(0, limite);
    let corrigidosPausados = 0;
    let capasTrocadas = 0;
    let fechadosIsolados = 0;
    let mantidosPausadosRevisaoManual = 0;
    let falhas = 0;
    let catalogChanged = false;
    const detalhes = [];

    const closeAndIsolateHelper = async (entry, motivoFechamento) => {
      const { it, mlId, prodIdx, matched, state } = entry;
      await mlFetch(`/items/${encodeURIComponent(mlId)}`, {
        method: 'PUT',
        body: { status: 'paused' },
      }).catch(() => null);
      const cRes = await mlFetch(`/items/${encodeURIComponent(mlId)}`, {
        method: 'PUT',
        body: { status: 'closed' },
      }).catch(() => null);
      if (cRes?.status === 'closed' || it.status === 'closed') {
        await mlFetch(`/items/${encodeURIComponent(mlId)}`, {
          method: 'PUT',
          body: { deleted: 'true' },
        }).catch(() => null);
      }
      await query("UPDATE listings SET status='closed' WHERE ml_item_id=$1", [mlId]).catch(() => null);

      if (prodIdx >= 0 && !state.isDuplicateOpen) {
        const nextProd = {
          ...products[prodIdx],
          ml_item_id: null,
          ml_permalink: null,
          ml_item_id_risco_fechado: mlId,
          ml_revisao: null,
          atualizado_em: new Date().toISOString(),
        };
        if (state.famousBrand) {
          nextProd.marca_famosa_quarentena = true;
          nextProd.marca_famosa_detectada = state.famousBrand;
          nextProd.status_anuncio = 'aguardando_procedimento_marca';
        } else {
          nextProd.risco_politica_ml = true;
          nextProd.motivo_risco_politica_ml = motivoFechamento;
          nextProd.status_anuncio = 'quarentena_politica_ml';
        }
        products[prodIdx] = nextProd;
        catalogChanged = true;
      }
      fechadosIsolados += 1;
      detalhes.push({
        ml_item_id: mlId,
        sku: matched?.sku || null,
        title: it.title || matched?.titulo_ml || '',
        acao: 'fechado_e_isolado',
        motivo: motivoFechamento,
        ok: true,
      });
    };

    const waveSize = modo === 'corrigir_recuperaveis' ? 4 : 6;
    for (let w = 0; w < slice.length; w += waveSize) {
      const wave = slice.slice(w, w + waveSize);
      await Promise.all(
        wave.map(async (entry) => {
          const { it, mlId, prodIdx, matched, state } = entry;
          try {
            if (modo === 'fechar_irrecuperaveis' || modo === 'fechar_restantes_com_alerta') {
              await closeAndIsolateHelper(entry, state.diagnosticoCurto);
              return;
            }

            // MODO === 'corrigir_recuperaveis'
            const livePics = (it.pictures || [])
              .map((pic) => pic.secure_url || pic.url)
              .filter(Boolean);
            const catalogPics = matched ? getProductImages(matched) : [];
            const candidateUrls = [...new Set([...catalogPics, ...livePics])];

            const galleryAudit = await autoSelectCleanGalleryAndCover(candidateUrls, {
              categoryId: it.category_id || OUTROS_OUTROS_LEAF_ID,
              title: matched?.titulo_ml || it.title || '',
              elementId: mlId,
              maxToTest: 6,
            });

            const bestUrls =
              galleryAudit.orderedUrls.length > 0 ? galleryAudit.orderedUrls.slice(0, 8) : livePics;
            const deptCat = resolveNonMe2DepartmentCategory(
              matched || { titulo_ml: it.title || it.family_name || '' }
            );
            const targetCat = isItemShippingFreeOfMe2(it.shipping || {})
              ? it.category_id
              : deptCat.id;

            const fullAttrs = await buildHighScoreMlAttributes(
              matched || {
                sku: (it.attributes || []).find((a) => a.id === 'SELLER_SKU')?.value_name || mlId,
                codigo_interno: mlId,
                titulo_ml: it.title || 'Produto',
                marca: 'Genérica',
                modelo: 'Padrão',
              },
              targetCat
            );

            const putBody = {
              attributes: fullAttrs,
              available_quantity: Math.min(Math.max(Number(it.available_quantity) || 3, 1), 3),
              status: 'paused',
            };
            if (bestUrls.length > 0) {
              putBody.pictures = bestUrls.map((source) => ({ source }));
            }
            if (!isItemShippingFreeOfMe2(it.shipping || {}) && Number(it.sold_quantity || 0) === 0) {
              putBody.category_id = targetCat;
              putBody.shipping = {
                mode: 'custom',
                local_pick_up: false,
                free_shipping: true,
                costs: [{ description: 'Todo o Brasil — Frete Grátis (5 a 10 dias)', cost: 0 }],
              };
            }

            let patchApplied = false;
            try {
              await mlFetch(`/items/${encodeURIComponent(mlId)}`, {
                method: 'PUT',
                body: putBody,
              });
              patchApplied = true;
            } catch {
              // Fallback minimal PUT (pictures + attributes only, e.g. if category/shipping is locked)
              try {
                await mlFetch(`/items/${encodeURIComponent(mlId)}`, {
                  method: 'PUT',
                  body: {
                    ...(bestUrls.length > 0
                      ? { pictures: bestUrls.map((source) => ({ source })) }
                      : {}),
                    attributes: fullAttrs,
                  },
                });
                patchApplied = true;
              } catch {}
            }

            if (matched?.descricao_ml_otimizada) {
              const cleanDesc = ensureFreeShippingNoticeInDescription(matched.descricao_ml_otimizada);
              if (cleanDesc.length >= 100) {
                await mlFetch(`/items/${encodeURIComponent(mlId)}/description`, {
                  method: 'PUT',
                  body: { plain_text: cleanDesc },
                }).catch(() => null);
              }
            }

            // CRITICAL: Always force paused after patching so ML never auto-activates a fixed waiting_for_patch item!
            const finalItem = (await ensureItemStrictlyPaused(mlId)) || it;
            const afterState = classifyLiveMlItemState(finalItem, matched, state.infraction, false);

            if (galleryAudit.coverSwapped && patchApplied) {
              capasTrocadas += 1;
            }

            if (
              fecharSeContinuarBloqueado &&
              (afterState.isInativoPolitica || (!galleryAudit.hasCleanCover && afterState.hasPoorThumbnail))
            ) {
              await closeAndIsolateHelper(
                entry,
                !galleryAudit.hasCleanCover
                  ? 'Sem foto de fundo branco limpa no fornecedor (isolado p/ revisão de capa)'
                  : `Permaneceu retido pelo ML (${afterState.diagnosticoCurto})`
              );
              return;
            }

            await query("UPDATE listings SET status='paused' WHERE ml_item_id=$1", [mlId]).catch(
              () => null
            );

            if (prodIdx >= 0) {
              const updatedProd = {
                ...products[prodIdx],
                status_anuncio: finalItem.status || 'paused',
                ml_sub_status: finalItem.sub_status || [],
                ml_shipping: finalItem.shipping || products[prodIdx].ml_shipping || null,
                requer_foto_capa_manual: !galleryAudit.hasCleanCover,
                atualizado_em: new Date().toISOString(),
              };
              if (bestUrls.length >= 4 && galleryAudit.coverSwapped) {
                updatedProd.imagens = bestUrls;
                updatedProd.imagem_1 = bestUrls[0] || '';
                updatedProd.imagem_2 = bestUrls[1] || '';
                updatedProd.imagem_3 = bestUrls[2] || '';
                updatedProd.imagem_4 = bestUrls[3] || '';
              }
              products[prodIdx] = updatedProd;
              catalogChanged = true;
            }

            if (!afterState.isInativoPolitica && galleryAudit.hasCleanCover) {
              corrigidosPausados += 1;
              detalhes.push({
                ml_item_id: mlId,
                sku: matched?.sku || null,
                title: it.title || '',
                acao: galleryAudit.coverSwapped
                  ? 'capa_limpa_aplicada_e_pausado'
                  : 'ficha_revisada_e_pausado',
                status_final: finalItem.status || 'paused',
                ok: true,
              });
            } else {
              mantidosPausadosRevisaoManual += 1;
              detalhes.push({
                ml_item_id: mlId,
                sku: matched?.sku || null,
                title: it.title || '',
                acao: 'pausado_aguardando_foto_ou_categoria_manual',
                motivo: !galleryAudit.hasCleanCover
                  ? 'Fornecedor não possui foto 100% fundo branco sem texto'
                  : afterState.diagnosticoCurto,
                status_final: finalItem.status || 'paused',
                ok: true,
              });
            }
          } catch (err) {
            falhas += 1;
            detalhes.push({
              ml_item_id: mlId,
              sku: matched?.sku || null,
              title: it.title || '',
              ok: false,
              error: err.message,
            });
          }
        })
      );
    }

    if (catalogChanged) {
      await persistCatalog(products);
    }

    res.json({
      ok: falhas === 0,
      modo,
      total_fila_inicial: queue.length,
      processados: slice.length,
      restantes_pendentes: Math.max(0, queue.length - slice.length),
      corrigidos_e_pausados: corrigidosPausados,
      capas_limpas_promovidas: capasTrocadas,
      fechados_e_isolados: fechadosIsolados,
      mantidos_pausados_revisao_manual: mantidosPausadosRevisaoManual,
      falhas,
      detalhes,
    });
  } catch (err) {
    next(err);
  }
});

export default router;
