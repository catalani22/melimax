import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import '../src/env.js';
import { query } from '../src/lib/db.js';

const CATALOG_STATE_KEY = 'aliexpress_catalog';
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const BACKEND_ROOT = path.resolve(__dirname, '..');
const REPO_ROOT = path.resolve(BACKEND_ROOT, '..');
const OUT_DIR = path.join(REPO_ROOT, 'dados');
const JSON_PATH = path.join(OUT_DIR, 'auditoria_custos_premium_817.json');
const CSV_PATH = path.join(OUT_DIR, 'auditoria_custos_premium_817.csv');

const num = (value) => Number(value) || 0;
const round2 = (value) => Number(num(value).toFixed(2));
const round1 = (value) => Number(num(value).toFixed(1));
const brlNumber = (value) => num(value).toFixed(2).replace('.', ',');
const csvCell = (value) => {
  const text = String(value ?? '');
  return /[;"\r\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
};

async function readCatalog() {
  const { rows } = await query('SELECT value, updated_at FROM app_state WHERE key = $1', [
    CATALOG_STATE_KEY,
  ]);
  const value = rows[0]?.value;
  if (!value) return { products: null, updatedAt: null };
  const parsed = typeof value === 'string' ? JSON.parse(value) : value;
  return {
    products: Array.isArray(parsed) ? parsed : null,
    updatedAt: rows[0].updated_at,
  };
}

function costOf(product) {
  const detail = product.detalhamento_custos || {};
  const salePrice = round2(product.preco_venda_ml_sugerido ?? detail.preco_venda_brl);
  const productCost = round2(
    product.custo_produto_brl ?? product.preco_custo_aliexpress_brl ?? detail.custo_produto_brl
  );
  const feePct = num(product.taxa_ml_pct ?? detail.comissao_ml_pct);
  const feeFixed = round2(product.taxa_ml_fixa_brl ?? detail.comissao_ml_fixa_brl);
  const mlFee = round2(product.taxa_ml_estimada_brl ?? detail.comissao_ml_brl);
  const taxPct = num(product.imposto_pct ?? detail.impostos_pct);
  const taxes = round2(product.imposto_estimado_brl ?? detail.impostos_brl);
  const shipping = round2(product.custo_frete_vendedor_brl ?? detail.frete_brl);
  const listingFee = round2(product.custo_listagem_ml_brl ?? detail.custo_listagem_ml_brl);
  const totalCost = round2(
    product.custo_total_operacao_brl ?? detail.custo_total_brl ?? productCost + mlFee + taxes + shipping + listingFee
  );
  const netProfit = round2(product.lucro_liquido_estimado_brl ?? detail.lucro_liquido_brl ?? salePrice - totalCost);
  const marginPct = round1(salePrice > 0 ? (netProfit / salePrice) * 100 : 0);
  const roiPct = round1(productCost > 0 ? (netProfit / productCost) * 100 : 0);
  return {
    sku: product.sku,
    codigo_interno: product.codigo_interno,
    titulo_ml: product.titulo_ml,
    categoria_ml: product.categoria_ml,
    categoria_ml_id: product.categoria_ml_id,
    salePrice,
    productCost,
    feePct,
    feeFixed,
    mlFee,
    taxPct,
    taxes,
    shipping,
    listingFee,
    totalCost,
    netProfit,
    marginPct,
    roiPct,
    feeSource: product.taxa_ml_fonte || detail.fonte_taxa_ml || 'desconhecida',
    listingType: product.taxa_ml_listing_type_name || 'Premium',
  };
}

function summarize(rows) {
  const totalSale = round2(rows.reduce((acc, row) => acc + row.salePrice, 0));
  const totalCost = round2(rows.reduce((acc, row) => acc + row.productCost, 0));
  const totalFees = round2(rows.reduce((acc, row) => acc + row.mlFee + row.listingFee, 0));
  const totalTaxes = round2(rows.reduce((acc, row) => acc + row.taxes, 0));
  const totalShipping = round2(rows.reduce((acc, row) => acc + row.shipping, 0));
  const totalOperational = round2(rows.reduce((acc, row) => acc + row.totalCost, 0));
  const totalNet = round2(rows.reduce((acc, row) => acc + row.netProfit, 0));

  const feeMap = new Map();
  const categoryMap = new Map();
  for (const row of rows) {
    const feeKey = `${row.feePct}%|${row.feeFixed}`;
    const feeEntry = feeMap.get(feeKey) || {
      taxa_ml_pct: row.feePct,
      taxa_ml_fixa_brl: row.feeFixed,
      produtos: 0,
      total_comissao_brl: 0,
    };
    feeEntry.produtos += 1;
    feeEntry.total_comissao_brl = round2(feeEntry.total_comissao_brl + row.mlFee);
    feeMap.set(feeKey, feeEntry);

    const catKey = row.categoria_ml_id || 'SEM_CATEGORIA';
    const catEntry = categoryMap.get(catKey) || {
      categoria_ml_id: catKey,
      categoria_ml: row.categoria_ml || '—',
      produtos: 0,
      taxas_encontradas: new Set(),
      total_comissao_brl: 0,
      total_impostos_brl: 0,
      total_lucro_brl: 0,
      total_custo_produto_brl: 0,
    };
    catEntry.produtos += 1;
    catEntry.taxas_encontradas.add(`${row.feePct}%`);
    catEntry.total_comissao_brl = round2(catEntry.total_comissao_brl + row.mlFee);
    catEntry.total_impostos_brl = round2(catEntry.total_impostos_brl + row.taxes);
    catEntry.total_lucro_brl = round2(catEntry.total_lucro_brl + row.netProfit);
    catEntry.total_custo_produto_brl = round2(catEntry.total_custo_produto_brl + row.productCost);
    categoryMap.set(catKey, catEntry);
  }

  return {
    produtos: rows.length,
    total_preco_venda_brl: totalSale,
    total_custo_produtos_brl: totalCost,
    total_comissoes_ml_brl: totalFees,
    total_impostos_brl: totalTaxes,
    total_frete_brl: totalShipping,
    total_custo_operacao_brl: totalOperational,
    total_lucro_liquido_brl: totalNet,
    margem_liquida_media_pct: round1(totalSale > 0 ? (totalNet / totalSale) * 100 : 0),
    roi_medio_sobre_custo_pct: round1(totalCost > 0 ? (totalNet / totalCost) * 100 : 0),
    produtos_com_taxa_real_ml: rows.filter((row) => row.feeSource === 'mercadolivre_api').length,
    produtos_com_fallback: rows.filter((row) => row.feeSource !== 'mercadolivre_api').length,
    produtos_com_lucro_negativo: rows.filter((row) => row.netProfit < 0).length,
    distribuicao_taxas: [...feeMap.values()].sort((a, b) => b.produtos - a.produtos),
    por_categoria: [...categoryMap.values()]
      .map((entry) => ({
        ...entry,
        taxas_encontradas: [...entry.taxas_encontradas].sort((a, b) => parseFloat(a) - parseFloat(b)),
        roi_sobre_custo_pct: round1(
          entry.total_custo_produto_brl > 0
            ? (entry.total_lucro_brl / entry.total_custo_produto_brl) * 100
            : 0
        ),
      }))
      .sort((a, b) => b.produtos - a.produtos),
  };
}

function writeCsv(rows) {
  const headers = [
    'sku',
    'codigo_interno',
    'titulo_ml',
    'categoria_ml_id',
    'categoria_ml',
    'tipo_anuncio_ml',
    'preco_venda_brl',
    'custo_produto_brl',
    'taxa_ml_pct',
    'taxa_ml_fixa_brl',
    'comissao_ml_brl',
    'impostos_pct',
    'impostos_brl',
    'frete_brl',
    'custo_listagem_ml_brl',
    'custo_total_operacao_brl',
    'lucro_liquido_brl',
    'margem_liquida_pct',
    'roi_sobre_custo_pct',
    'fonte_taxa_ml',
  ];
  const lines = [headers.join(';')];
  for (const row of rows) {
    lines.push(
      [
        row.sku,
        row.codigo_interno,
        row.titulo_ml,
        row.categoria_ml_id,
        row.categoria_ml,
        row.listingType,
        brlNumber(row.salePrice),
        brlNumber(row.productCost),
        String(row.feePct).replace('.', ','),
        brlNumber(row.feeFixed),
        brlNumber(row.mlFee),
        String(row.taxPct).replace('.', ','),
        brlNumber(row.taxes),
        brlNumber(row.shipping),
        brlNumber(row.listingFee),
        brlNumber(row.totalCost),
        brlNumber(row.netProfit),
        String(row.marginPct).replace('.', ','),
        String(row.roiPct).replace('.', ','),
        row.feeSource,
      ]
        .map(csvCell)
        .join(';')
    );
  }
  fs.writeFileSync(CSV_PATH, `\uFEFF${lines.join('\r\n')}\r\n`, 'utf8');
}

async function main() {
  const { products, updatedAt } = await readCatalog();
  if (!products) throw new Error('Catálogo não encontrado em app_state.aliexpress_catalog.');

  const rows = products.map(costOf);
  const summary = summarize(rows);
  const report = {
    gerado_em: new Date().toISOString(),
    fonte: 'app_state.aliexpress_catalog',
    catalogo_atualizado_em: updatedAt ? new Date(updatedAt).toISOString() : null,
    modelo: {
      anuncio: 'Premium (gold_pro)',
      comissao_ml: 'taxa real consultada na API do Mercado Livre por categoria e faixa de preço',
      impostos: 'percentual configurado em ML_TAX_RATE',
      frete_vendedor: 'R$ 0,00',
    },
    resumo: summary,
  };

  fs.mkdirSync(OUT_DIR, { recursive: true });
  fs.writeFileSync(JSON_PATH, `${JSON.stringify(report, null, 2)}\n`, 'utf8');
  writeCsv(rows);

  console.log(`[auditoria] produtos=${summary.produtos}`);
  console.log(
    `[auditoria] venda=${summary.total_preco_venda_brl} custo_produtos=${summary.total_custo_produtos_brl} comissoes=${summary.total_comissoes_ml_brl} impostos=${summary.total_impostos_brl} frete=${summary.total_frete_brl}`
  );
  console.log(
    `[auditoria] custo_total=${summary.total_custo_operacao_brl} lucro=${summary.total_lucro_liquido_brl} margem=${summary.margem_liquida_media_pct}% roi=${summary.roi_medio_sobre_custo_pct}% fallback=${summary.produtos_com_fallback} lucro_negativo=${summary.produtos_com_lucro_negativo}`
  );
  console.log(`[auditoria] json: ${JSON_PATH}`);
  console.log(`[auditoria] csv: ${CSV_PATH}`);
}

main().catch((err) => {
  console.error('[auditoria] erro:', err.message);
  process.exitCode = 1;
});
