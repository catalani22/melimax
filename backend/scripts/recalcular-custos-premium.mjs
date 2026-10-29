import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import '../src/env.js';
import { query } from '../src/lib/db.js';
import {
  ML_TAX_RATE,
  ML_SHIPPING_COST,
  DEFAULT_MULTIPLIER,
  MIN_ML_PRICE,
  calculateMlPricing,
  buildCompleteCsv,
  buildMercadoLivreBulkCsv,
} from '../src/lib/aliexpress-scraper.js';
import {
  applyCostBreakdownToProduct,
  buildCostBreakdown,
  getExactListingFee,
} from '../src/lib/ml-fees.js';

const CATALOG_STATE_KEY = 'aliexpress_catalog';
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const BACKEND_ROOT = path.resolve(__dirname, '..');
const REPO_ROOT = path.resolve(BACKEND_ROOT, '..');
const DRY_RUN = process.argv.includes('--dry-run');
const SNAPSHOT = process.argv.includes('--snapshot');
const CONCURRENCY = Math.max(Number(process.env.RECALC_CONCURRENCY) || 5, 1);

const round2 = (value) => Number(Number(value || 0).toFixed(2));

async function readCatalog() {
  const { rows } = await query('SELECT value FROM app_state WHERE key = $1', [
    CATALOG_STATE_KEY,
  ]);
  const value = rows[0]?.value;
  if (!value) return null;
  const parsed = typeof value === 'string' ? JSON.parse(value) : value;
  return Array.isArray(parsed) ? parsed : null;
}

async function mapLimit(items, limit, fn) {
  const results = new Array(items.length);
  let nextIndex = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (nextIndex < items.length) {
      const index = nextIndex;
      nextIndex += 1;
      results[index] = await fn(items[index], index);
    }
  });
  await Promise.all(workers);
  return results;
}

async function recalculateProduct(product) {
  const cost = Math.max(Number(product.preco_custo_aliexpress_brl) || 0, 0);
  const currentPrice = Number(product.preco_venda_ml_sugerido) || 0;
  const multiplier =
    Number(product.multiplicador_venda) > 0
      ? Number(product.multiplicador_venda)
      : DEFAULT_MULTIPLIER;
  const fallback = calculateMlPricing(cost, multiplier, MIN_ML_PRICE);
  const price = round2(currentPrice > 0 ? currentPrice : fallback.finalPrice);

  const fee = await getExactListingFee({
    categoryId: product.categoria_ml_id,
    price,
  });
  const breakdown = buildCostBreakdown({
    price,
    cost,
    fee,
    shippingCost: ML_SHIPPING_COST,
    taxRate: ML_TAX_RATE,
  });
  const updated = applyCostBreakdownToProduct(product, breakdown, ML_TAX_RATE);

  return {
    ...updated,
    multiplicador_venda: multiplier,
    preco_calculado_2_8x_brl: round2(cost * multiplier),
    piso_79_90_aplicado: price > round2(cost * multiplier),
    atualizado_em: new Date().toISOString(),
  };
}

async function main() {
  console.log(
    `[premium] taxa=real ML premium | imposto=${(ML_TAX_RATE * 100).toFixed(2)}% | frete=R$${ML_SHIPPING_COST.toFixed(2)} | concorrencia=${CONCURRENCY}`
  );

  const catalog = await readCatalog();
  if (!catalog) {
    throw new Error('Catálogo não encontrado em app_state.aliexpress_catalog.');
  }

  const recalculated = await mapLimit(catalog, CONCURRENCY, (product, index) => {
    if ((index + 1) % 100 === 0) {
      console.log(`[premium] processados ${index + 1}/${catalog.length}`);
    }
    return recalculateProduct(product);
  });

  const comCusto = recalculated.filter(
    (item) => Number(item.preco_custo_aliexpress_brl) > 0
  ).length;
  const lucroNegativo = recalculated.filter(
    (item) => Number(item.lucro_liquido_estimado_brl) < 0
  ).length;
  const apiOk = recalculated.filter(
    (item) => item.taxa_ml_fonte === 'mercadolivre_api'
  ).length;
  const fallback = recalculated.length - apiOk;
  const roiMedio =
    recalculated.reduce((acc, item) => acc + Number(item.roi_sobre_custo_pct || 0), 0) /
    (recalculated.length || 1);
  const taxas = new Map();
  for (const item of recalculated) {
    const key = `${item.categoria_ml_id} ${item.taxa_ml_pct}% + R$${item.taxa_ml_fixa_brl}`;
    taxas.set(key, (taxas.get(key) || 0) + 1);
  }

  console.log(
    `[premium] produtos=${recalculated.length} com_custo=${comCusto} lucro_negativo=${lucroNegativo} api_ok=${apiOk} fallback=${fallback} roi_medio=${roiMedio.toFixed(1)}%`
  );
  for (const [key, count] of [...taxas.entries()].sort((a, b) => b[1] - a[1])) {
    console.log(`[premium] ${key}: ${count}`);
  }

  if (DRY_RUN) {
    console.log('[premium] dry-run: banco não alterado.');
    return;
  }

  const backupPath = `/tmp/aliexpress_catalog_pre-premium-${Date.now()}.json`;
  fs.writeFileSync(backupPath, JSON.stringify(catalog, null, 0));
  console.log(`[premium] backup: ${backupPath}`);

  await query(
    `INSERT INTO app_state (key, value, updated_at)
     VALUES ($1, $2, NOW())
     ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = NOW()`,
    [CATALOG_STATE_KEY, JSON.stringify(recalculated)]
  );
  console.log('[premium] app_state.aliexpress_catalog atualizado.');

  if (SNAPSHOT) {
    const targets = [
      path.join(BACKEND_ROOT, 'data', 'aliexpress_produtos.json'),
      path.join(REPO_ROOT, 'dados', 'aliexpress_produtos.json'),
    ];
    for (const target of targets) {
      fs.mkdirSync(path.dirname(target), { recursive: true });
      fs.writeFileSync(target, JSON.stringify(recalculated, null, 2));
      console.log(`[premium] snapshot: ${target}`);
    }

    const completeCsv = buildCompleteCsv(recalculated);
    const bulkCsv = buildMercadoLivreBulkCsv(recalculated);
    const dropfacilOnly = recalculated.filter(
      (p) =>
        String(p.fornecedor_loja_id) === '1104933528' ||
        /DropFacil/i.test(String(p.fornecedor_nome || ''))
    );
    const dropCompleteCsv = buildCompleteCsv(dropfacilOnly);
    const dropBulkCsv = buildMercadoLivreBulkCsv(dropfacilOnly);
    const dirs = [
      path.join(BACKEND_ROOT, 'data'),
      path.join(REPO_ROOT, 'dados'),
      path.join(REPO_ROOT, 'frontend/public'),
      path.join(REPO_ROOT, 'public'),
    ];
    for (const dir of dirs) {
      fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(
        path.join(dir, 'mercadolivre_aliexpress_completo.csv'),
        completeCsv,
        'utf8'
      );
      fs.writeFileSync(
        path.join(dir, 'mercadolivre_planilha_publicacao.csv'),
        bulkCsv,
        'utf8'
      );
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
    console.log('[premium] snapshots CSV atualizados em data/, dados/, frontend/public/ e public/.');
  }
}

main().catch((err) => {
  console.error('[premium] erro:', err.message);
  process.exitCode = 1;
});
