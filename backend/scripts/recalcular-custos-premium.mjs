import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import '../src/env.js';
import { query } from '../src/lib/db.js';
import {
  ML_FEE_RATE,
  ML_TAX_RATE,
  ML_SHIPPING_COST,
  DEFAULT_MULTIPLIER,
  MIN_ML_PRICE,
  calculateMlPricing,
} from '../src/lib/aliexpress-scraper.js';

const CATALOG_STATE_KEY = 'aliexpress_catalog';
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const BACKEND_ROOT = path.resolve(__dirname, '..');
const REPO_ROOT = path.resolve(BACKEND_ROOT, '..');
const DRY_RUN = process.argv.includes('--dry-run');
const SNAPSHOT = process.argv.includes('--snapshot');

const round2 = (value) => Number(Number(value || 0).toFixed(2));
const round1 = (value) => Number(Number(value || 0).toFixed(1));

async function readCatalog() {
  const { rows } = await query('SELECT value FROM app_state WHERE key = $1', [
    CATALOG_STATE_KEY,
  ]);
  const value = rows[0]?.value;
  if (!value) return null;
  const parsed = typeof value === 'string' ? JSON.parse(value) : value;
  return Array.isArray(parsed) ? parsed : null;
}

function recalculateProduct(product) {
  const cost = Math.max(Number(product.preco_custo_aliexpress_brl) || 0, 0);
  const currentPrice = Number(product.preco_venda_ml_sugerido) || 0;
  const multiplier =
    Number(product.multiplicador_venda) > 0
      ? Number(product.multiplicador_venda)
      : DEFAULT_MULTIPLIER;

  const fallback = calculateMlPricing(cost, multiplier, MIN_ML_PRICE);
  const finalPrice = round2(currentPrice > 0 ? currentPrice : fallback.finalPrice);

  const mlFee = round2(finalPrice * ML_FEE_RATE);
  const taxes = round2(finalPrice * ML_TAX_RATE);
  const shipping = round2(ML_SHIPPING_COST);
  const grossMargin = round2(finalPrice - cost);
  const netProfit = round2(finalPrice - cost - mlFee - taxes - shipping);
  const netMarginPct = finalPrice > 0 ? round1((netProfit / finalPrice) * 100) : 0;
  const roiPct = cost > 0 ? round1((netProfit / cost) * 100) : 0;
  const totalOperationCost = round2(cost + mlFee + taxes + shipping);

  return {
    ...product,
    multiplicador_venda: multiplier,
    preco_venda_ml_sugerido: finalPrice,
    preco_calculado_2_8x_brl: round2(cost * multiplier),
    piso_79_90_aplicado: finalPrice > round2(cost * multiplier),
    tipo_anuncio: 'Premium (gold_pro)',
    tipo_anuncio_ml: 'premium',
    taxa_ml_estimada_brl: mlFee,
    imposto_estimado_brl: taxes,
    custo_anuncio_premium_brl: mlFee,
    custo_frete_vendedor_brl: shipping,
    custo_total_operacao_brl: totalOperationCost,
    margem_estimada: grossMargin,
    lucro_liquido_estimado_brl: netProfit,
    margem_liquida_pct: netMarginPct,
    roi_sobre_custo_pct: roiPct,
    atualizado_em: new Date().toISOString(),
  };
}

async function main() {
  console.log(
    `[premium] taxa=${(ML_FEE_RATE * 100).toFixed(2)}% imposto=${(ML_TAX_RATE * 100).toFixed(2)}% frete=R$${ML_SHIPPING_COST.toFixed(2)}`
  );

  const catalog = await readCatalog();
  if (!catalog) {
    throw new Error('Catálogo não encontrado em app_state.aliexpress_catalog.');
  }

  const recalculated = catalog.map(recalculateProduct);
  const semCusto = recalculated.filter(
    (item) => !(Number(item.preco_custo_aliexpress_brl) > 0)
  ).length;
  const lucroNegativo = recalculated.filter(
    (item) => Number(item.lucro_liquido_estimado_brl) < 0
  ).length;
  const roiMedio =
    recalculated.reduce((acc, item) => acc + Number(item.roi_sobre_custo_pct || 0), 0) /
    (recalculated.length || 1);

  console.log(
    `[premium] produtos=${recalculated.length} sem_custo=${semCusto} lucro_negativo=${lucroNegativo} roi_medio=${roiMedio.toFixed(1)}%`
  );

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
  }
}

main().catch((err) => {
  console.error('[premium] erro:', err.message);
  process.exitCode = 1;
});
