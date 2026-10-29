import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  scrapeAliExpressProduct,
  extractAliExpressItemId,
  rewriteMercadoLivreTitle,
  buildCompleteCsv,
  buildMercadoLivreBulkCsv,
} from '../backend/src/lib/aliexpress-scraper.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');

const CSV_TEMPLATE_PATH = path.join(
  ROOT,
  'public/assets/aistudio/produtos_aliexpress_brasil_dropshipping_d8ee3f39.csv'
);
const CSV_PRICING_PATH = path.join(
  ROOT,
  'public/assets/aistudio/lista_precificacao_dropshipping_e13209bc.csv'
);
const CHECKPOINT_JSON_PATH = path.join(ROOT, 'dados/aliexpress_produtos.json');
const STORE_CATALOG_PATH = path.join(ROOT, 'dados/cssv_store_catalog.json');

const PDF_SUPPLEMENTAL_COSTS = {
  '1005012084055450': { cost: 15.41, orig: 42.63 },
  '1005012108093900': { cost: 55.0, orig: 100.0 },
  '1005013172984863': { cost: 33.55, orig: 55.5 },
  '1005012072201980': { cost: 35.29, orig: 58.02 },
  '1005013163065189': { cost: 33.17, orig: 54.94 },
  '1005012897317023': { cost: 38.38, orig: 62.5 },
  '1005012904988663': { cost: 38.73, orig: 63.0 },
  '1005011988173102': { cost: 27.0, orig: 46.0 },
  '1005013212801966': { cost: 22.86, orig: 40.0 },
  '1005013472219028': { cost: 44.85, orig: 65.0 },
  '1005012825699536': { cost: 30.31, orig: 50.8 },
  '1005012903318383': { cost: 30.79, orig: 51.5 },
  '1005012083483959': { cost: 47.38, orig: 68.67 },
};

// Active sibling items from CSSV SHOP Store (1105400522) for the 3 paused SKUs at identical price tiers
const PAUSED_SIBLING_MAP = {
  '1005012832146041': '1005012831842471',
  '1005012823217315': '1005013380318139',
  '1005012825699536': '1005012102668350',
};

function loadPricingMap() {
  const map = new Map();
  if (fs.existsSync(CSV_PRICING_PATH)) {
    const lines = fs.readFileSync(CSV_PRICING_PATH, 'utf8').trim().split(/\r?\n/);
    for (let i = 1; i < lines.length; i++) {
      const parts = lines[i].split(',');
      const itemId = extractAliExpressItemId(parts[0]);
      const cost = parseFloat(parts[1]);
      if (itemId && Number.isFinite(cost) && cost > 0) {
        map.set(itemId, { cost, orig: null });
      }
    }
  }
  for (const [id, info] of Object.entries(PDF_SUPPLEMENTAL_COSTS)) {
    map.set(id, info);
  }
  return map;
}

function loadInputItems() {
  const lines = fs.readFileSync(CSV_TEMPLATE_PATH, 'utf8').trim().split(/\r?\n/);
  const items = [];
  for (let i = 1; i < lines.length; i++) {
    const line = lines[i].trim();
    if (!line) continue;
    const cols = line.split(',');
    const internalCode = cols[0]?.trim();
    const url = cols.find((c) => c.includes('aliexpress.com/item/'))?.trim();
    const itemId = extractAliExpressItemId(url);
    if (internalCode && itemId) {
      items.push({ internalCode, url, itemId });
    }
  }
  return items;
}

function loadCheckpointMap() {
  const map = new Map();
  if (!fs.existsSync(CHECKPOINT_JSON_PATH)) return map;
  try {
    const arr = JSON.parse(fs.readFileSync(CHECKPOINT_JSON_PATH, 'utf8'));
    for (const item of arr) {
      if (
        item?.aliexpress_item_id &&
        item?.qtd_imagens >= 4 &&
        item?.titulo_ml &&
        !/Produto Pronta Entrega/i.test(item.titulo_ml)
      ) {
        // Re-polish title with updated punctuation cleaner
        const cleanTitle = rewriteMercadoLivreTitle(
          item.titulo_aliexpress_original || item.titulo_ml,
          item.atributos_lista || [],
          item.variacao_modelo || ''
        );
        map.set(`${item.codigo_interno}:${item.aliexpress_item_id}`, {
          ...item,
          titulo_ml: cleanTitle,
        });
      }
    }
  } catch {}
  return map;
}

function loadStoreCatalogMap() {
  const map = new Map();
  if (!fs.existsSync(STORE_CATALOG_PATH)) return map;
  try {
    const arr = JSON.parse(fs.readFileSync(STORE_CATALOG_PATH, 'utf8'));
    for (const item of arr) {
      if (item?.id) map.set(String(item.id), item);
    }
  } catch {}
  return map;
}

async function runWithConcurrency(items, concurrency, worker) {
  const results = new Array(items.length);
  let cursor = 0;

  async function next() {
    while (cursor < items.length) {
      const idx = cursor++;
      results[idx] = await worker(items[idx], idx);
    }
  }

  await Promise.all(Array.from({ length: concurrency }, () => next()));
  return results;
}

async function main() {
  const pricingMap = loadPricingMap();
  const inputItems = loadInputItems();
  const checkpointMap = loadCheckpointMap();
  const storeCatalogMap = loadStoreCatalogMap();

  console.log(
    `Processando ${inputItems.length} produtos (Checkpoint PDP completo: ${checkpointMap.size} | Catálogo Loja CSSV: ${storeCatalogMap.size})...`
  );

  const products = await runWithConcurrency(inputItems, 6, async (entry, idx) => {
    const cpKey = `${entry.internalCode}:${entry.itemId}`;
    if (checkpointMap.has(cpKey)) {
      return checkpointMap.get(cpKey);
    }

    const priceInfo = pricingMap.get(entry.itemId) || {};
    let storeEntry = storeCatalogMap.get(entry.itemId) || null;
    let isSiblingFallback = false;

    if (!storeEntry && PAUSED_SIBLING_MAP[entry.itemId]) {
      storeEntry = storeCatalogMap.get(PAUSED_SIBLING_MAP[entry.itemId]) || null;
      isSiblingFallback = Boolean(storeEntry);
    }

    const scraped = await scrapeAliExpressProduct({
      urlOrId: entry.url,
      internalCode: entry.internalCode,
      knownCostBrl: priceInfo.cost || null,
      knownOrigPriceBrl: priceInfo.orig || null,
      storeEntry,
      skipLivePdp: Boolean(storeEntry),
    });

    if (isSiblingFallback) {
      scraped.status_anuncio = 'verificar_estoque_fornecedor';
      scraped.fornecedor_contato = `https://pt.aliexpress.com/item/${PAUSED_SIBLING_MAP[entry.itemId]}.html`;
    }

    if ((idx + 1) % 15 === 0 || idx === inputItems.length - 1) {
      console.log(
        `[${idx + 1}/${inputItems.length}] ${scraped.sku} | R$ ${scraped.preco_custo_aliexpress_brl} -> R$ ${scraped.preco_venda_ml_sugerido} | ${scraped.qtd_imagens} imgs | ${scraped.titulo_ml}`
      );
    }
    return scraped;
  });

  const dadosDir = path.join(ROOT, 'dados');
  const frontendPublicDir = path.join(ROOT, 'frontend/public');
  const rootPublicDir = path.join(ROOT, 'public');
  fs.mkdirSync(dadosDir, { recursive: true });
  fs.mkdirSync(frontendPublicDir, { recursive: true });
  fs.mkdirSync(rootPublicDir, { recursive: true });

  const jsonPath = path.join(dadosDir, 'aliexpress_produtos.json');
  const completeCsvPath = path.join(dadosDir, 'mercadolivre_aliexpress_completo.csv');
  const bulkCsvPath = path.join(dadosDir, 'mercadolivre_planilha_publicacao.csv');

  const completeCsvContent = buildCompleteCsv(products);
  const bulkCsvContent = buildMercadoLivreBulkCsv(products);

  fs.writeFileSync(jsonPath, JSON.stringify(products, null, 2), 'utf8');
  fs.writeFileSync(completeCsvPath, completeCsvContent, 'utf8');
  fs.writeFileSync(bulkCsvPath, bulkCsvContent, 'utf8');

  for (const dir of [frontendPublicDir, rootPublicDir]) {
    fs.writeFileSync(
      path.join(dir, 'mercadolivre_aliexpress_completo.csv'),
      completeCsvContent,
      'utf8'
    );
    fs.writeFileSync(
      path.join(dir, 'mercadolivre_planilha_publicacao.csv'),
      bulkCsvContent,
      'utf8'
    );
  }

  const total = products.length;
  const with4PlusImgs = products.filter((p) => p.qtd_imagens >= 4).length;
  const withGenericTitle = products.filter((p) =>
    /Produto Pronta Entrega/i.test(p.titulo_ml)
  ).length;
  const minPriceAll = Math.min(...products.map((p) => p.preco_venda_ml_sugerido));
  const maxTitleLen = Math.max(...products.map((p) => p.titulo_ml.length));

  console.log('\n=== AUDITORIA FINAL DO CSV GERADO ===');
  console.log(`Total de produtos extraídos: ${total}`);
  console.log(`Produtos com >= 4 imagens:   ${with4PlusImgs}/${total}`);
  console.log(`Títulos genéricos (falha):   ${withGenericTitle}`);
  console.log(`Menor preço de venda ML:     R$ ${minPriceAll.toFixed(2)}`);
  console.log(`Maior tamanho de título ML:  ${maxTitleLen} caracteres`);
}

main().catch((err) => {
  console.error('Erro fatal:', err);
  process.exit(1);
});
