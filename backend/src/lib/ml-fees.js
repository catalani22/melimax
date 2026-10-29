import { mlFetch } from './ml.js';

const FEE_CACHE_TTL = 30 * 60 * 1000;
const LISTING_TYPE = process.env.ML_LISTING_TYPE || 'gold_pro';
const FALLBACK_FEE_RATE = Number(process.env.ML_FEE_RATE || 0.19);
const feeCache = new Map();

const round2 = (value) => Number(Number(value || 0).toFixed(2));
const round1 = (value) => Number(Number(value || 0).toFixed(1));

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function fallbackFee(price, source, error) {
  return {
    percentage: FALLBACK_FEE_RATE,
    fixed_fee: 0,
    sale_fee_amount: round2(Number(price) * FALLBACK_FEE_RATE),
    listing_fee_amount: 0,
    listing_type_id: LISTING_TYPE,
    listing_type_name: 'Premium',
    currency_id: 'BRL',
    source,
    error: error || null,
    queried_at: new Date().toISOString(),
  };
}

export function clearMlFeeCache() {
  feeCache.clear();
}

export async function getExactListingFee({
  categoryId,
  price,
  listingTypeId = LISTING_TYPE,
}) {
  const numericPrice = round2(price);
  const category = String(categoryId || '').trim();
  if (!category || numericPrice <= 0) {
    return fallbackFee(numericPrice, 'fallback_sem_categoria');
  }

  const key = `${category}:${listingTypeId}:${numericPrice}`;
  const hit = feeCache.get(key);
  if (hit && Date.now() - hit.createdAt < FEE_CACHE_TTL) return hit.value;

  let lastError = null;
  for (let attempt = 1; attempt <= 3; attempt += 1) {
    try {
      const params = new URLSearchParams({
        price: numericPrice.toFixed(2),
        listing_type_id: listingTypeId,
        category_id: category,
      });
      const data = await mlFetch(`/sites/MLB/listing_prices?${params.toString()}`);
      const details = data.sale_fee_details || {};
      const percentage = Number(details.percentage_fee || 0) / 100;
      const fixedFee = Number(details.fixed_fee || 0);
      const saleFeeAmount = Number(
        data.sale_fee_amount ?? numericPrice * percentage + fixedFee
      );
      const value = {
        percentage,
        fixed_fee: round2(fixedFee),
        sale_fee_amount: round2(saleFeeAmount),
        listing_fee_amount: round2(data.listing_fee_amount || 0),
        listing_type_id: data.listing_type_id || listingTypeId,
        listing_type_name: data.listing_type_name || 'Premium',
        currency_id: data.currency_id || 'BRL',
        source: 'mercadolivre_api',
        error: null,
        queried_at: new Date().toISOString(),
      };
      feeCache.set(key, { value, createdAt: Date.now() });
      return value;
    } catch (err) {
      lastError = err;
      if (err.status === 429 || (err.status >= 500 && err.status < 600)) {
        await sleep(500 * attempt);
        continue;
      }
      break;
    }
  }

  console.error(
    `[ml-fees] falha ao consultar ${category} R$ ${numericPrice.toFixed(2)}:`,
    lastError?.message || 'erro desconhecido'
  );
  return fallbackFee(numericPrice, 'fallback_api_error', lastError?.message || null);
}

export function buildCostBreakdown({
  price,
  cost,
  fee,
  shippingCost = 0,
  taxRate = Number(process.env.ML_TAX_RATE || 0.06),
}) {
  const salePrice = round2(price);
  const productCost = round2(cost);
  const shipping = round2(shippingCost);
  const commission = round2(
    fee?.sale_fee_amount ??
      salePrice * Number(fee?.percentage || 0) + Number(fee?.fixed_fee || 0)
  );
  const listingFee = round2(fee?.listing_fee_amount || 0);
  const taxes = round2(salePrice * Number(taxRate || 0));
  const totalCost = round2(productCost + commission + listingFee + taxes + shipping);
  const netProfit = round2(salePrice - totalCost);

  return {
    salePrice,
    productCost,
    shipping,
    commission,
    listingFee,
    taxes,
    totalCost,
    netProfit,
    netMarginPct: salePrice > 0 ? round1((netProfit / salePrice) * 100) : 0,
    roiPct: productCost > 0 ? round1((netProfit / productCost) * 100) : 0,
    feePercentagePct: round2(Number(fee?.percentage || 0) * 100),
    feeFixed: round2(fee?.fixed_fee || 0),
    feeSource: fee?.source || 'fallback',
    feeQueriedAt: fee?.queried_at || new Date().toISOString(),
    listingTypeId: fee?.listing_type_id || LISTING_TYPE,
    listingTypeName: fee?.listing_type_name || 'Premium',
    currencyId: fee?.currency_id || 'BRL',
  };
}

export function applyCostBreakdownToProduct(product, breakdown, taxRate) {
  const taxPct = round2(Number(taxRate || 0) * 100);
  const detalhamento = {
    preco_venda_brl: breakdown.salePrice,
    custo_produto_brl: breakdown.productCost,
    comissao_ml_pct: breakdown.feePercentagePct,
    comissao_ml_fixa_brl: breakdown.feeFixed,
    comissao_ml_brl: breakdown.commission,
    custo_listagem_ml_brl: breakdown.listingFee,
    impostos_pct: taxPct,
    impostos_brl: breakdown.taxes,
    frete_brl: breakdown.shipping,
    custo_total_brl: breakdown.totalCost,
    lucro_liquido_brl: breakdown.netProfit,
    margem_liquida_pct: breakdown.netMarginPct,
    roi_sobre_custo_pct: breakdown.roiPct,
    fonte_taxa_ml: breakdown.feeSource,
    calculado_em: breakdown.feeQueriedAt,
  };

  return {
    ...product,
    tipo_anuncio: 'Premium (gold_pro)',
    tipo_anuncio_ml: 'premium',
    taxa_ml_pct: breakdown.feePercentagePct,
    taxa_ml_fixa_brl: breakdown.feeFixed,
    taxa_ml_estimada_brl: breakdown.commission,
    custo_anuncio_premium_brl: breakdown.commission,
    custo_listagem_ml_brl: breakdown.listingFee,
    taxa_ml_fonte: breakdown.feeSource,
    taxa_ml_listing_type_id: breakdown.listingTypeId,
    taxa_ml_listing_type_name: breakdown.listingTypeName,
    taxa_ml_calculada_em: breakdown.feeQueriedAt,
    imposto_pct: taxPct,
    imposto_estimado_brl: breakdown.taxes,
    custo_produto_brl: breakdown.productCost,
    custo_frete_vendedor_brl: breakdown.shipping,
    custo_total_operacao_brl: breakdown.totalCost,
    margem_estimada: round2(breakdown.salePrice - breakdown.productCost),
    lucro_liquido_estimado_brl: breakdown.netProfit,
    margem_liquida_pct: breakdown.netMarginPct,
    roi_sobre_custo_pct: breakdown.roiPct,
    detalhamento_custos: detalhamento,
  };
}

export async function priceProductWithExactMlFee({
  product,
  price,
  cost,
  shippingCost = Number(process.env.ML_SHIPPING_COST || 0),
  taxRate = Number(process.env.ML_TAX_RATE || 0.06),
}) {
  const fee = await getExactListingFee({
    categoryId: product?.categoria_ml_id,
    price,
    listingTypeId: LISTING_TYPE,
  });
  const breakdown = buildCostBreakdown({
    price,
    cost,
    fee,
    shippingCost,
    taxRate,
  });
  return {
    fee,
    breakdown,
    product: applyCostBreakdownToProduct(product, breakdown, taxRate),
  };
}
