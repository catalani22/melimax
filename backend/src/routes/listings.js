import express from 'express';
import { query } from '../lib/db.js';
import { mlFetch } from '../lib/ml.js';
import { findSupplierCost } from '../lib/supplier-costs.js';

const router = express.Router();

const LISTING_TYPE = process.env.ML_LISTING_TYPE || 'gold_special';
const EMPTY_GTIN_REASON = process.env.ML_EMPTY_GTIN_REASON || '17055160';
const DEFAULT_SHIPPING_COST = Number(process.env.ML_SHIPPING_COST || 25);
const TAX_RATE = Number(process.env.ML_TAX_RATE || 0.06);
const MIN_NET_MARGIN = Number(process.env.ML_MIN_NET_MARGIN || 0.45);
const MIN_PRICE_MULTIPLE = Number(process.env.ML_MIN_PRICE_MULTIPLE || 3);
const MIN_PROFIT_OVER_COST = Number(
  process.env.ML_MIN_PROFIT_OVER_COST || 1
);
const MARKET_TOLERANCE = Number(process.env.ML_MARKET_TOLERANCE || 1.05);
const STOCK_STALE_HOURS = Number(process.env.ML_STOCK_STALE_HOURS || 24);
const SHIPPING_TABLE = [
  { maxKg: 0.3, cost: 21.9 },
  { maxKg: 0.5, cost: 23.9 },
  { maxKg: 1, cost: 26.9 },
  { maxKg: 2, cost: 31.9 },
  { maxKg: 5, cost: 42.9 },
  { maxKg: 10, cost: 58.9 },
  { maxKg: 20, cost: 79.9 },
  { maxKg: Infinity, cost: 99.9 },
];
const feeCache = new Map();
const FEE_CACHE_TTL = 30 * 60 * 1000;
const sourceCache = new Map();
const SOURCE_CACHE_TTL = 5 * 60 * 1000;
const SOURCE_CACHE_MAX = 200;
const SKIP_ATTRIBUTES = new Set([
  'ITEM_CONDITION',
  'SELLER_SKU',
  'SELLER_PACKAGE_HEIGHT',
  'SELLER_PACKAGE_LENGTH',
  'SELLER_PACKAGE_WIDTH',
  'SELLER_PACKAGE_WEIGHT',
]);

function clampMargin(value) {
  const margin = Number(value);
  if (!Number.isFinite(margin)) return 0.5;
  return Math.min(Math.max(margin, 0.05), 0.75);
}

function normalizeAttribute(attr) {
  const valueId =
    attr.value_id != null && String(attr.value_id).trim() !== ''
      ? String(attr.value_id).trim()
      : null;
  if (valueId) return { id: attr.id, value_id: valueId };

  const valueName =
    attr.value_name != null && String(attr.value_name).trim() !== ''
      ? String(attr.value_name).trim()
      : null;
  if (valueName) return { id: attr.id, value_name: valueName };

  const first = Array.isArray(attr.values)
    ? attr.values.find(
        (item) =>
          item &&
          ((item.id != null && String(item.id).trim() !== '') ||
            (item.name != null && String(item.name).trim() !== ''))
      )
    : null;
  if (first?.id != null && String(first.id).trim() !== '') {
    return { id: attr.id, value_id: String(first.id).trim() };
  }
  if (first?.name) return { id: attr.id, value_name: String(first.name).trim() };

  return null;
}

function buildAttributes(attributes) {
  const seen = new Set();
  const result = [];

  for (const attr of attributes || []) {
    if (!attr?.id || SKIP_ATTRIBUTES.has(attr.id) || seen.has(attr.id)) continue;
    const normalized = normalizeAttribute(attr);
    if (!normalized) continue;
    seen.add(attr.id);
    result.push(normalized);
  }

  if (!seen.has('GTIN') && !seen.has('EMPTY_GTIN_REASON')) {
    result.push({ id: 'EMPTY_GTIN_REASON', value_id: EMPTY_GTIN_REASON });
  }

  return result;
}

function buildPictures(pictures) {
  return (pictures || [])
    .map((picture) => picture.secure_url || picture.url)
    .filter(Boolean)
    .slice(0, 6)
    .map((url) => ({ source: String(url).replace(/^http:/, 'https:') }));
}

function sanitizeTitle(title) {
  return String(title || '').replace(/\s+/g, ' ').trim().slice(0, 60);
}

function scoreListing(payload, descriptionText, title) {
  let score = 0;
  if (title && title.length >= 20) score += 20;
  if (payload.pictures && payload.pictures.length >= 3) score += 20;
  if (String(descriptionText || '').length > 100) score += 20;
  if (payload.price >= 80) score += 15;
  if (payload.shipping?.free_shipping) score += 10;
  if (payload.attributes && payload.attributes.length > 5) score += 10;
  if (payload.accepts_mercadopago) score += 5;
  return Math.min(score, 100);
}

function friendlyMlText(text) {
  const raw = String(text || '');
  if (raw.includes('cellphone_not_unlocked')) {
    return 'Categoria de celulares nao liberada para esta conta. Desbloqueie no Mercado Livre ou use outro nicho.';
  }
  if (raw.includes('item.catalog_listing.not_eligible')) {
    return 'Este produto nao pode ser anunciado como catalogo nesta conta. Tentando anuncio normal.';
  }
  if (raw.includes('body.required_fields')) {
    return 'O Mercado Livre exige campos adicionais na ficha tecnica. Verifique os atributos do produto.';
  }
  if (raw.includes('shipping.lost_me1_by_user')) {
    return 'Sua conta nao tem o modo de envio me1 ativo; o Mercado Livre pode limitar opcoes de frete.';
  }
  if (raw.includes('item.shipping.mandatory_free_shipping')) {
    return 'O Mercado Livre aplicou frete gratis obrigatorio; inclua esse custo no preco.';
  }
  return raw;
}

function formatMlError(err) {
  const causes = err?.details?.cause;
  if (Array.isArray(causes) && causes.length) {
    const text = causes
      .map((cause) => cause.description || cause.message || cause.code)
      .filter(Boolean)
      .join(' | ');
    return friendlyMlText(text);
  }
  return friendlyMlText(
    err?.message || 'Falha ao criar anuncio no Mercado Livre'
  );
}

function warningOnly(err) {
  const causes = err?.details?.cause;
  return (
    Array.isArray(causes) &&
    causes.length > 0 &&
    causes.every((cause) => cause.type === 'warning')
  );
}

function warningMessages(err) {
  const causes = err?.details?.cause;
  if (!Array.isArray(causes)) return [];
  return causes
    .filter((cause) => cause.type === 'warning')
    .map((cause) => cause.message || cause.code)
    .filter(Boolean);
}

function pickOffer(items, wantedItemId) {
  const valid = (items || []).filter((item) => Number(item.price) > 0);
  if (!valid.length) return null;
  if (wantedItemId) {
    const wanted = valid.find((item) => item.item_id === wantedItemId);
    if (wanted) return wanted;
  }
  return [...valid].sort((a, b) => Number(a.price) - Number(b.price))[0];
}

function marketSummary(offers) {
  const prices = (offers || [])
    .map((offer) => Number(offer.price))
    .filter((price) => Number.isFinite(price) && price > 0)
    .sort((a, b) => a - b);
  if (!prices.length) return { min: null, median: null, max: null, count: 0 };
  return {
    min: prices[0],
    median: prices[Math.floor(prices.length / 2)],
    max: prices[prices.length - 1],
    count: prices.length,
  };
}

function positiveNumber(value) {
  const number = Number(value);
  return Number.isFinite(number) && number > 0 ? number : null;
}

function volumetricWeight(item) {
  const peso = positiveNumber(item?.peso_kg);
  const altura = positiveNumber(item?.altura_cm);
  const largura = positiveNumber(item?.largura_cm);
  const comprimento = positiveNumber(item?.comprimento_cm);
  const cubico =
    altura && largura && comprimento
      ? (altura * largura * comprimento) / 6000
      : null;
  const pesoConsiderado = Math.max(peso || 0, cubico || 0);
  return {
    peso_kg: peso,
    cubico_kg: cubico,
    peso_considerado: pesoConsiderado || null,
  };
}

function estimateShipping(supplierCost) {
  const weight = volumetricWeight(supplierCost);
  if (!weight.peso_considerado) {
    return {
      cost: DEFAULT_SHIPPING_COST,
      source: 'default',
      peso_kg: null,
      cubico_kg: null,
      peso_considerado: null,
    };
  }
  const row =
    SHIPPING_TABLE.find((item) => weight.peso_considerado <= item.maxKg) ||
    SHIPPING_TABLE[SHIPPING_TABLE.length - 1];
  return {
    cost: row.cost,
    source: 'weight',
    ...weight,
  };
}

function supplierStockInfo(supplierCost) {
  if (!supplierCost?.atualizado_em) {
    return { stock_updated_at: null, stock_age_hours: null, stock_stale: false };
  }
  const updatedAt = new Date(supplierCost.atualizado_em);
  if (Number.isNaN(updatedAt.getTime())) {
    return { stock_updated_at: null, stock_age_hours: null, stock_stale: false };
  }
  const ageHours = (Date.now() - updatedAt.getTime()) / (60 * 60 * 1000);
  return {
    stock_updated_at: updatedAt.toISOString(),
    stock_age_hours: Number(ageHours.toFixed(1)),
    stock_stale: ageHours > STOCK_STALE_HOURS,
  };
}

async function getSaleFee(categoryId, listingTypeId, referencePrice) {
  const priceBucket = Math.round((Number(referencePrice) || 0) / 50) * 50;
  const key = `${categoryId}:${listingTypeId}:${priceBucket}`;
  const hit = feeCache.get(key);
  if (hit && Date.now() - hit.createdAt < FEE_CACHE_TTL) return hit.value;

  try {
    const data = await mlFetch(
      `/sites/MLB/listing_prices?price=${encodeURIComponent(
        referencePrice
      )}&listing_type_id=${encodeURIComponent(
        listingTypeId
      )}&category_id=${encodeURIComponent(categoryId)}`
    );
    const percentage =
      Number(data.sale_fee_details?.percentage_fee || 0) / 100;
    const fixed = Number(data.sale_fee_details?.fixed_fee || 0);
    const fee = { percentage, fixed };
    feeCache.set(key, { value: fee, createdAt: Date.now() });
    if (feeCache.size > 500) {
      const oldest = [...feeCache.entries()].sort(
        (a, b) => a[1].createdAt - b[1].createdAt
      )[0];
      if (oldest) feeCache.delete(oldest[0]);
    }
    return fee;
  } catch {
    return { percentage: 0.12, fixed: 0 };
  }
}

async function priceListing(source, body, margin) {
  const gtin =
    (source.attributes || []).find((attr) => attr.id === 'GTIN')?.value_name ||
    null;
  const supplierCost = await findSupplierCost({
    catalogoId: source.product?.id,
    itemId: source.itemId,
    gtin,
    fornecedorId: body.fornecedor_id,
  }).catch(() => null);
  const explicitCost = Number(body.custo ?? body.cost);
  const cost =
    explicitCost > 0
      ? explicitCost
      : Number(supplierCost?.custo) || Number(source.price) || 0;
  const costSource =
    explicitCost > 0
      ? 'manual'
      : supplierCost
        ? 'supplier'
        : 'ml_offer';
  const rawShipping = body.frete ?? body.shipping_cost;
  const explicitShipping =
    rawShipping == null || rawShipping === '' ? null : Number(rawShipping);
  const shipping =
    explicitShipping != null &&
    Number.isFinite(explicitShipping) &&
    explicitShipping >= 0
      ? {
          cost: explicitShipping,
          source: 'manual',
          peso_kg: null,
          cubico_kg: null,
          peso_considerado: null,
        }
      : estimateShipping(supplierCost);
  const shippingCost = shipping.cost;
  const stock = supplierStockInfo(supplierCost);
  const taxRate = Number(body.taxa ?? body.tax_rate ?? TAX_RATE) || 0;
  const desiredMargin = clampMargin(body.margem ?? margin);
  const listingType = body.listing_type_id || LISTING_TYPE;

  if (cost <= 0) {
    const err = new Error('O custo do fornecedor precisa ser maior que zero.');
    err.status = 422;
    throw err;
  }

  const fee = await getSaleFee(source.categoryId, listingType, cost);
  const denominator = 1 - fee.percentage - taxRate - desiredMargin;
  if (denominator <= 0) {
    const err = new Error(
      'Margem, taxa do Mercado Livre e impostos tornam o preco inviavel.'
    );
    err.status = 422;
    throw err;
  }

  const computedPrice = Math.ceil(
    (cost + shippingCost + fee.fixed) / denominator
  );
  const manualPrice = Number(body.preco ?? body.price);
  const price =
    Number.isFinite(manualPrice) && manualPrice > 0
      ? Math.round(manualPrice)
      : computedPrice;

  const saleFee = Math.round(price * fee.percentage + fee.fixed);
  const taxes = Math.round(price * taxRate);
  const netProfit = Math.round(price - cost - shippingCost - saleFee - taxes);
  const netMargin = price > 0 ? netProfit / price : 0;
  const priceMultiple = cost > 0 ? price / cost : 0;
  const profitOverCost = cost > 0 ? netProfit / cost : 0;
  const market = source.market || marketSummary(source.offers);
  const competitive =
    market?.median != null ? price <= market.median * MARKET_TOLERANCE : null;

  return {
    cost,
    cost_source: costSource,
    supplier: supplierCost
      ? {
          id: supplierCost.fornecedor_id,
          nome: supplierCost.fornecedor_nome,
          sku: supplierCost.sku,
          ...stock,
        }
      : null,
    price,
    computed_price: computedPrice,
    shipping_cost: shippingCost,
    shipping_source: shipping.source,
    shipping_weight_kg: shipping.peso_considerado,
    shipping_actual_weight_kg: shipping.peso_kg,
    shipping_volumetric_kg: shipping.cubico_kg,
    sale_fee: saleFee,
    taxes,
    net_profit: netProfit,
    net_margin: Number(netMargin.toFixed(4)),
    price_multiple: Number(priceMultiple.toFixed(2)),
    profit_over_cost: Number(profitOverCost.toFixed(4)),
    fee_percentage: Number((fee.percentage * 100).toFixed(2)),
    market,
    competitive,
    viable:
      netMargin >= MIN_NET_MARGIN &&
      priceMultiple >= MIN_PRICE_MULTIPLE &&
      profitOverCost >= MIN_PROFIT_OVER_COST &&
      (competitive === null || competitive),
  };
}

function normalizeText(value) {
  if (!value) return '';
  if (typeof value === 'string') return value.trim();
  if (typeof value === 'object') {
    return String(
      value.plain_text || value.text || value.description || ''
    ).trim();
  }
  return '';
}

async function resolveSourceUncached(body) {
  const catalogoId =
    body.catalogo_id || body.catalog_product_id || body.catalogoId;
  const itemId = body.item_id || body.itemId;

  if (catalogoId) {
    const product = await mlFetch(`/products/${encodeURIComponent(catalogoId)}`);
    const offers = await mlFetch(
      `/products/${encodeURIComponent(catalogoId)}/items?limit=20`
    );
    const offer = pickOffer(offers.results, itemId);
    if (!offer) {
      const err = new Error('Nenhuma oferta ativa encontrada para este produto.');
      err.status = 422;
      throw err;
    }
    return {
      kind: 'catalog',
      product,
      offer,
      itemId: offer.item_id,
      title: product.name,
      price: Number(offer.price) || 0,
      currencyId: offer.currency_id || 'BRL',
      condition: offer.condition || 'new',
      categoryId: offer.category_id || null,
      pictures: product.pictures || [],
      attributes: product.attributes || [],
      sellerId: offer.seller_id ? String(offer.seller_id) : null,
      warranty: offer.warranty || null,
      description: normalizeText(product.short_description),
      offers: offers.results || [],
      market: marketSummary(offers.results),
    };
  }

  if (!itemId) {
    const err = new Error('Informe catalogo_id ou item_id.');
    err.status = 400;
    throw err;
  }

  let item;
  try {
    item = await mlFetch(`/items/${encodeURIComponent(itemId)}`);
  } catch (err) {
    if (err.status === 403) {
      const friendly = new Error(
        'O Mercado Livre nao libera os detalhes de itens de terceiros. Use um produto do catalogo.'
      );
      friendly.status = 422;
      throw friendly;
    }
    throw err;
  }

  const description = await mlFetch(
    `/items/${encodeURIComponent(itemId)}/description`
  ).catch(() => null);

  return {
    kind: 'item',
    product: null,
    offer: null,
    itemId,
    title: item.title,
    price: Number(item.price) || 0,
    currencyId: item.currency_id || 'BRL',
    condition: item.condition || 'new',
    categoryId: item.category_id || null,
    pictures: item.pictures || [],
    attributes: item.attributes || [],
    sellerId: item.seller?.id ? String(item.seller.id) : null,
    warranty: null,
    description: normalizeText(description),
    offers: [item],
    market: marketSummary([item]),
  };
}

function sourceCacheKey(body) {
  const catalogoId =
    body.catalogo_id || body.catalog_product_id || body.catalogoId;
  const itemId = body.item_id || body.itemId;
  return catalogoId
    ? `catalog:${catalogoId}:${itemId || ''}`
    : `item:${itemId || ''}`;
}

async function resolveSource(body) {
  const key = sourceCacheKey(body);
  const hit = sourceCache.get(key);
  if (hit && Date.now() - hit.createdAt < SOURCE_CACHE_TTL) return hit.value;

  const value = await resolveSourceUncached(body);
  sourceCache.set(key, { value, createdAt: Date.now() });
  if (sourceCache.size > SOURCE_CACHE_MAX) {
    const oldest = [...sourceCache.entries()].sort(
      (a, b) => a[1].createdAt - b[1].createdAt
    )[0];
    if (oldest) sourceCache.delete(oldest[0]);
  }
  return value;
}

function buildDescription(source, title) {
  const custom = normalizeText(source.description);
  const specs = (source.attributes || [])
    .filter((attr) => attr.value_name)
    .slice(0, 14)
    .map((attr) => `- ${attr.name || attr.id}: ${attr.value_name}`)
    .join('\n');

  const intro =
    custom.length > 120
      ? custom
      : `${title} novo, pronto para envio. Produto selecionado para entregar qualidade, durabilidade e o melhor custo-benefício.`;

  const warranty = source.warranty
    ? `Garantia: ${source.warranty}.`
    : 'Garantia: conforme descrito no anuncio.';

  return [
    intro,
    specs ? `\nEspecificações técnicas:\n${specs}` : '',
    `\nItens inclusos:\n- 1x ${title}`,
    `\n${warranty}`,
    'Envio: produto enviado com rastreamento e embalagem segura.',
    'Dúvidas? Estamos à disposição para ajudar antes e depois da compra.',
  ]
    .filter(Boolean)
    .join('\n');
}

function buildPayloads(source, body, pricing, descriptionText) {
  const sourcePrice = Number(source.price) || 0;
  if (sourcePrice <= 0) {
    const err = new Error('O produto de origem nao possui preco valido.');
    err.status = 422;
    throw err;
  }
  if (!source.categoryId) {
    const err = new Error('Nao foi possivel identificar a categoria do produto.');
    err.status = 422;
    throw err;
  }

  const pictures = buildPictures(source.pictures);
  if (!pictures.length) {
    const err = new Error('O produto de origem nao possui imagens utilizaveis.');
    err.status = 422;
    throw err;
  }

  const price = pricing.price;
  const title = sanitizeTitle(body.titulo || source.title);

  const familyName = sanitizeTitle(source.product?.name || source.title);

  const strategy = source.product?.settings?.listing_strategy || null;
  const catalogOnly =
    strategy === 'catalog_required' || strategy === 'catalog_only';
  const freeShipping = catalogOnly ? true : body.free_shipping !== false;

  const base = {
    family_name: familyName,
    category_id: source.categoryId,
    price,
    currency_id: source.currencyId,
    available_quantity: Math.max(Number(body.available_quantity) || 1, 1),
    buying_mode: 'buy_it_now',
    condition: source.condition,
    status: body.status || process.env.ML_DEFAULT_LISTING_STATUS || 'paused',
    listing_type_id: body.listing_type_id || LISTING_TYPE,
    pictures,
    accepts_mercadopago: true,
    shipping: {
      mode: 'me2',
      local_pick_up: false,
      free_shipping: freeShipping,
    },
    attributes: buildAttributes(source.attributes),
  };

  const payloads = [];

  if (source.product) {
    payloads.push({
      variant: 'catalog',
      payload: {
        ...base,
        catalog_product_id: source.product.id,
        catalog_listing: true,
        family_name: familyName,
      },
    });
  }

  if (!catalogOnly) {
    payloads.push({ variant: 'normal', payload: base });

    if (base.listing_type_id !== 'free') {
      payloads.push({
        variant: 'free',
        payload: { ...base, listing_type_id: 'free' },
      });
    }
  }

  return {
    payloads,
    price,
    margin: pricing.net_margin,
    pricing,
    sourcePrice,
    title,
    descriptionText,
    pictures,
  };
}

async function createItem(payloads) {
  const errors = [];
  for (const { variant, payload } of payloads) {
    try {
      const created = await mlFetch('/items', { method: 'POST', body: payload });
      return { created, variant, errors };
    } catch (err) {
      errors.push(`${variant}: ${formatMlError(err)}`);
    }
  }
  const err = new Error(errors[errors.length - 1] || 'Falha ao criar anuncio.');
  err.friendlyMessage = errors.join(' | ');
  err.status = 422;
  throw err;
}

async function createDescription(itemId, text) {
  if (!text) return null;
  try {
    return await mlFetch(`/items/${encodeURIComponent(itemId)}/description`, {
      method: 'POST',
      body: { plain_text: text },
    });
  } catch (err) {
    console.error('[listings] falha ao criar descricao:', formatMlError(err));
    return null;
  }
}

router.get('/', async (req, res, next) => {
  try {
    const { rows } = await query(
      'SELECT * FROM listings ORDER BY created_at DESC LIMIT 200'
    );
    res.json(rows);
  } catch (err) {
    next(err);
  }
});

router.get('/alertas', async (req, res, next) => {
  try {
    const limit = Math.min(Math.max(Number(req.query.limite) || 30, 1), 200);
    const unreadOnly = req.query.nao_lidas === 'true';
    const params = [];
    let where = '';
    if (unreadOnly) where = 'WHERE lido = FALSE';
    const { rows } = await query(
      `SELECT pa.*, s.nome AS fornecedor_nome
       FROM price_alerts pa
       LEFT JOIN suppliers s ON s.slug = pa.fornecedor_id
       ${where ? where.replace('lido', 'pa.lido') : ''}
       ORDER BY pa.created_at DESC
       LIMIT ${limit}`
    );
    const { rows: countRows } = await query(
      `SELECT COUNT(*)::int AS total,
              COUNT(*) FILTER (WHERE lido = FALSE)::int AS nao_lidas
       FROM price_alerts`
    );
    res.json({
      total: countRows[0]?.total || 0,
      nao_lidas: countRows[0]?.nao_lidas || 0,
      alertas: rows,
    });
  } catch (err) {
    next(err);
  }
});

router.post('/alertas/lidas', async (req, res, next) => {
  try {
    const ids = Array.isArray(req.body.ids)
      ? req.body.ids.map((id) => Number(id)).filter(Number.isFinite)
      : [];
    const params = [];
    let where = 'lido = FALSE';
    if (ids.length) {
      params.push(ids);
      where += ` AND id = ANY($${params.length})`;
    }
    const { rowCount } = await query(
      `UPDATE price_alerts SET lido = TRUE WHERE ${where}`,
      params
    );
    res.json({ atualizados: rowCount || 0 });
  } catch (err) {
    next(err);
  }
});

router.post('/validar', async (req, res, next) => {
  try {
    const margin = clampMargin(req.body.margem ?? req.body.margin);
    const source = await resolveSource(req.body);
    const pricing = await priceListing(source, req.body, margin);
    const descriptionText = buildDescription(source, source.title);
    const built = buildPayloads(
      source,
      req.body,
      pricing,
      descriptionText
    );

    const results = [];
    for (const { variant, payload } of built.payloads) {
      try {
        const result = await mlFetch('/items/validate', {
          method: 'POST',
          body: payload,
        });
        results.push({
          variant,
          ok: true,
          score: scoreListing(payload, descriptionText, built.title),
          result,
        });
      } catch (err) {
        const warnings = warningMessages(err);
        const ok = warningOnly(err);
        results.push({
          variant,
          ok,
          score: scoreListing(payload, descriptionText, built.title),
          error: ok ? null : formatMlError(err),
          warnings: warnings.length ? warnings : undefined,
          details: err.details || null,
        });
      }
    }

    const best = results.find((result) => result.ok) || null;
    res.json({
      ok: Boolean(best),
      best_variant: best?.variant || null,
      score: best?.score ?? null,
      description_preview: descriptionText.slice(0, 600),
      source: {
        catalogo_id: source.product?.id || null,
        item_id: source.itemId,
        title: built.title,
        source_price: built.sourcePrice,
        price: built.price,
        category_id: source.categoryId,
        seller_id: source.sellerId,
      },
      pricing,
      variants: results,
    });
  } catch (err) {
    next(err);
  }
});

router.post('/', async (req, res, next) => {
  try {
    const margin = clampMargin(req.body.margem ?? req.body.margin);
    const source = await resolveSource(req.body);
    const pricing = await priceListing(source, req.body, margin);
    if (!pricing.viable && !req.body.force) {
      return res.status(422).json({
        error:
          'Anuncio inviavel: margem/multiplicador abaixo do minimo ou preco acima da referencia de mercado.',
        pricing,
      });
    }
    const descriptionText = buildDescription(source, source.title);
    const built = buildPayloads(
      source,
      req.body,
      pricing,
      descriptionText
    );

    let created;
    let usedVariant;
    let attemptErrors = [];
    try {
      const result = await createItem(built.payloads);
      created = result.created;
      usedVariant = result.variant;
      attemptErrors = result.errors;
    } catch (err) {
      return res.status(err.status && err.status < 500 ? 422 : 502).json({
        error: err.friendlyMessage || err.message,
        details: err.details || null,
      });
    }

    await createDescription(created.id, descriptionText);

    const supplierInput = req.body.fornecedor;
    const supplier =
      (typeof supplierInput === 'string' ? supplierInput : null) ||
      supplierInput?.nome ||
      pricing.supplier?.nome ||
      (source.sellerId ? `Vendedor ${source.sellerId}` : 'Mercado Livre');
    const supplierId =
      req.body.fornecedor_id ||
      (typeof supplierInput === 'object' ? supplierInput?.id : null) ||
      pricing.supplier?.id ||
      source.sellerId ||
      null;

    const score = scoreListing(built.payloads[0].payload, descriptionText, built.title);
    const permalink =
      created.permalink ||
      `https://www.mercadolivre.com.br/p/${source.product?.id || source.itemId}`;

    await query(
      `INSERT INTO listings
         (ml_item_id, title, price, supplier, status, score, source_item_id,
          source_price, supplier_id, permalink, margin, thumbnail, catalogo_id,
          listing_type_id, cost, sale_fee, taxes, shipping_cost, packaging_cost,
          net_profit, fee_percentage, created_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,NOW())
       ON CONFLICT (ml_item_id) DO UPDATE SET
         title = EXCLUDED.title,
         price = EXCLUDED.price,
         status = EXCLUDED.status,
         score = EXCLUDED.score,
         catalogo_id = EXCLUDED.catalogo_id,
         listing_type_id = EXCLUDED.listing_type_id,
         cost = EXCLUDED.cost,
         sale_fee = EXCLUDED.sale_fee,
         taxes = EXCLUDED.taxes,
         shipping_cost = EXCLUDED.shipping_cost,
         packaging_cost = EXCLUDED.packaging_cost,
         net_profit = EXCLUDED.net_profit,
         fee_percentage = EXCLUDED.fee_percentage`,
      [
        created.id,
        built.title,
        built.price,
        supplier,
        created.status || 'active',
        score,
        source.itemId,
        built.sourcePrice,
        supplierId ? String(supplierId) : null,
        permalink,
        built.margin,
        built.pictures[0]?.source || null,
        source.product?.id || null,
        req.body.listing_type_id || LISTING_TYPE,
        Number(pricing.cost) || null,
        Number(pricing.sale_fee) || null,
        Number(pricing.taxes) || null,
        Number(pricing.shipping_cost) || null,
        Number(req.body.embalagem ?? pricing.packaging_cost) || 0,
        Number(pricing.net_profit) || null,
        Number(pricing.fee_percentage) || null,
      ]
    );

    res.status(201).json({
      ...created,
      score,
      price: built.price,
      margin: built.margin,
      variant: usedVariant,
      source_item_id: source.itemId,
      catalogo_id: source.product?.id || null,
      source_price: built.sourcePrice,
      permalink,
      warnings: [
        ...(attemptErrors.length ? [`Tentativas: ${attemptErrors.join(' | ')}`] : []),
        ...(score < 85
          ? ['Qualificacao abaixo de 85%. O anuncio foi criado, mas pode ter menos visitas.']
          : []),
      ],
    });
  } catch (err) {
    next(err);
  }
});

async function updateAllListingStatus(fromStatus, toStatus) {
  const { rows } = await query(
    'SELECT id, ml_item_id FROM listings WHERE status = $1 ORDER BY created_at ASC LIMIT 200',
    [fromStatus]
  );
  const falhas = [];
  let atualizados = 0;
  let nextIndex = 0;

  async function worker() {
    while (nextIndex < rows.length) {
      const listing = rows[nextIndex];
      nextIndex += 1;
      try {
        await mlFetch(`/items/${encodeURIComponent(listing.ml_item_id)}`, {
          method: 'PUT',
          body: { status: toStatus },
        });
        await query('UPDATE listings SET status = $1 WHERE id = $2', [
          toStatus,
          listing.id,
        ]);
        atualizados += 1;
      } catch (err) {
        falhas.push({
          id: listing.ml_item_id,
          error: formatMlError(err),
        });
      }
    }
  }

  const workers = Math.min(5, rows.length);
  await Promise.all(Array.from({ length: workers }, () => worker()));

  return { total: rows.length, atualizados, falhas };
}

router.post('/pausar-todos', async (req, res, next) => {
  try {
    const result = await updateAllListingStatus('active', 'paused');
    res.json(result);
  } catch (err) {
    next(err);
  }
});

router.post('/reativar-todos', async (req, res, next) => {
  try {
    const result = await updateAllListingStatus('paused', 'active');
    res.json(result);
  } catch (err) {
    next(err);
  }
});


async function listingMarket(catalogoId, fallbackPrice) {
  if (catalogoId) {
    try {
      const offers = await mlFetch(
        `/products/${encodeURIComponent(catalogoId)}/items?limit=20`
      );
      const summary = marketSummary(offers.results);
      if (summary.median) return summary;
    } catch {}
  }
  const fallback = Number(fallbackPrice);
  if (Number.isFinite(fallback) && fallback > 0) {
    return { min: fallback, median: fallback, max: fallback, count: 0 };
  }
  return { min: null, median: null, max: null, count: 0 };
}

router.post('/sync-prices', async (req, res, next) => {
  try {
    const limit = Math.min(Math.max(Number(req.body.max_batch) || 20, 1), 50);
    const dryRun = req.body.dry_run !== false;
    const status = req.body.status ? String(req.body.status) : null;
    const margin = clampMargin(req.body.margem ?? req.body.margin);
    const taxRate = Number(req.body.taxa ?? req.body.tax_rate ?? TAX_RATE) || 0;

    const params = [];
    let where = "ml_item_id IS NOT NULL AND status <> 'closed'";
    if (status) {
      params.push(status);
      where += ` AND status = $${params.length}`;
    }
    params.push(limit);
    const { rows } = await query(
      `SELECT * FROM listings
       WHERE ${where}
       ORDER BY last_price_sync_at ASC NULLS FIRST, created_at ASC
       LIMIT $${params.length}`,
      params
    );

    const results = [];
    let updated = 0;
    let skipped = 0;
    let errors = 0;

    for (const row of rows) {
      try {
        const supplierCost = await findSupplierCost({
          catalogoId: row.catalogo_id,
          itemId: row.source_item_id,
          fornecedorId: row.supplier_id,
        });
        if (!supplierCost) {
          skipped += 1;
          results.push({ id: row.ml_item_id, status: 'sem_custo' });
          continue;
        }

        const item = await mlFetch(`/items/${encodeURIComponent(row.ml_item_id)}`);
        const categoryId = item.category_id || null;
        const listingType = item.listing_type_id || row.listing_type_id || LISTING_TYPE;
        const cost = Number(supplierCost.custo);
        const shipping = estimateShipping(supplierCost).cost;
        const fee = await getSaleFee(categoryId, listingType, cost);
        const denominator = 1 - fee.percentage - taxRate - margin;
        if (denominator <= 0) {
          skipped += 1;
          results.push({ id: row.ml_item_id, status: 'margem_inviavel' });
          continue;
        }

        const computed = Math.ceil(
          (cost + shipping + fee.fixed) / denominator
        );
        const market = await listingMarket(
          row.catalogo_id || item.catalog_product_id,
          row.source_price
        );
        const ceiling =
          market.median != null
            ? Math.floor(market.median * MARKET_TOLERANCE)
            : null;
        const target = ceiling ? Math.min(computed, ceiling) : computed;
        const saleFee = Math.round(target * fee.percentage + fee.fixed);
        const taxes = Math.round(target * taxRate);
        const profit = Math.round(target - cost - shipping - saleFee - taxes);
        const netMargin = target > 0 ? profit / target : 0;
        const profitOverCost = cost > 0 ? profit / cost : 0;
        const viable =
          netMargin >= MIN_NET_MARGIN &&
          profitOverCost >= MIN_PROFIT_OVER_COST;
        const current = Number(item.price) || Number(row.price) || 0;
        const deltaPct = current > 0 ? (target - current) / current : 0;

        if (!viable) {
          skipped += 1;
          results.push({
            id: row.ml_item_id,
            status: 'inviavel',
            cost,
            target,
            profit,
            net_margin: Number(netMargin.toFixed(4)),
            profit_over_cost: Number(profitOverCost.toFixed(4)),
            market_median: market.median,
          });
          continue;
        }

        if (Math.abs(deltaPct) < 0.01) {
          skipped += 1;
          results.push({
            id: row.ml_item_id,
            status: 'sem_alteracao',
            price: current,
            target,
          });
          continue;
        }

        if (!dryRun) {
          await mlFetch(`/items/${encodeURIComponent(row.ml_item_id)}`, {
            method: 'PUT',
            body: { price: target },
          });
          await query(
            `UPDATE listings
             SET price = $1, margin = $2, last_price_sync_at = NOW(),
                 price_floor = $3, price_ceiling = $4, cost = $5,
                 sale_fee = $6, taxes = $7, shipping_cost = $8,
                 net_profit = $9, fee_percentage = $10
             WHERE id = $11`,
            [
              target,
              Number((profit / target).toFixed(4)),
              Math.round(
                (cost + shipping + fee.fixed) /
                  (1 - fee.percentage - taxRate - MIN_NET_MARGIN)
              ),
              ceiling,
              cost,
              saleFee,
              taxes,
              shipping,
              profit,
              Number((fee.percentage * 100).toFixed(2)),
              row.id,
            ]
          );
        }

        updated += 1;
        results.push({
          id: row.ml_item_id,
          status: dryRun ? 'planejado' : 'atualizado',
          cost,
          current_price: current,
          target_price: target,
          delta_pct: Number((deltaPct * 100).toFixed(2)),
          profit,
          net_margin: Number(netMargin.toFixed(4)),
          profit_over_cost: Number(profitOverCost.toFixed(4)),
          market_median: market.median,
        });
      } catch (err) {
        errors += 1;
        results.push({
          id: row.ml_item_id,
          status: 'erro',
          error: formatMlError(err),
        });
      }
      await new Promise((resolve) => setTimeout(resolve, 250));
    }

    res.json({
      dry_run: dryRun,
      total: rows.length,
      updated,
      skipped,
      errors,
      results,
    });
  } catch (err) {
    next(err);
  }
});

router.post('/publicar-lote', async (req, res, next) => {
  try {
    const ids = Array.isArray(req.body.ids) ? req.body.ids.map(String) : [];
    const limit = Math.min(Math.max(Number(req.body.max_batch) || 20, 1), 50);
    const params = [];
    let where = "status = 'paused'";
    if (ids.length) {
      params.push(ids);
      where += ` AND (id::text = ANY($${params.length}) OR ml_item_id = ANY($${params.length}))`;
    }
    params.push(limit);
    const { rows } = await query(
      `SELECT id, ml_item_id FROM listings
       WHERE ${where}
       ORDER BY created_at ASC
       LIMIT $${params.length}`,
      params
    );

    const falhas = [];
    let atualizados = 0;
    for (const listing of rows) {
      try {
        await mlFetch(`/items/${encodeURIComponent(listing.ml_item_id)}`, {
          method: 'PUT',
          body: { status: 'active' },
        });
        await query('UPDATE listings SET status = $1 WHERE id = $2', [
          'active',
          listing.id,
        ]);
        atualizados += 1;
      } catch (err) {
        falhas.push({
          id: listing.ml_item_id,
          error: formatMlError(err),
        });
      }
      await new Promise((resolve) => setTimeout(resolve, 250));
    }

    res.json({ total: rows.length, atualizados, falhas });
  } catch (err) {
    next(err);
  }
});

router.delete('/:id', async (req, res, next) => {
  try {
    const { rows } = await query(
      'SELECT * FROM listings WHERE id = $1 OR ml_item_id = $1 LIMIT 1',
      [req.params.id]
    );
    const listing = rows[0];
    if (!listing) return res.status(404).json({ error: 'Anuncio nao encontrado.' });

    try {
      await mlFetch(`/items/${listing.ml_item_id}`, {
        method: 'PUT',
        body: { status: 'closed' },
      });
    } catch (err) {
      if (err.status !== 404) throw err;
    }

    await query('UPDATE listings SET status = $1 WHERE id = $2', ['closed', listing.id]);
    res.json({ ok: true, status: 'closed' });
  } catch (err) {
    next(err);
  }
});

export default router;
