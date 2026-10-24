import express from 'express';
import { query } from '../lib/db.js';
import { mlFetch } from '../lib/ml.js';

const router = express.Router();

const LISTING_TYPE = process.env.ML_LISTING_TYPE || 'gold_special';
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
  if (!Number.isFinite(margin)) return 0.18;
  return Math.min(Math.max(margin, 0.05), 0.6);
}

function buildAttributes(attributes) {
  const seen = new Set();
  return (attributes || [])
    .filter((attr) => attr.id && !SKIP_ATTRIBUTES.has(attr.id))
    .filter((attr) => attr.value_id || attr.value_name)
    .filter((attr) => {
      if (seen.has(attr.id)) return false;
      seen.add(attr.id);
      return true;
    })
    .map((attr) =>
      attr.value_id
        ? { id: attr.id, value_id: String(attr.value_id) }
        : { id: attr.id, value_name: String(attr.value_name) }
    );
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

function scoreListing(payload, descriptionText) {
  let score = 0;
  if (payload.title && payload.title.length >= 20) score += 20;
  if (payload.pictures && payload.pictures.length >= 3) score += 20;
  if (String(descriptionText || '').length > 100) score += 20;
  if (payload.price >= 80) score += 15;
  if (payload.shipping?.free_shipping) score += 10;
  if (payload.attributes && payload.attributes.length > 5) score += 10;
  if (payload.accepts_mercadopago) score += 5;
  return Math.min(score, 100);
}

function formatMlError(err) {
  const causes = err?.details?.cause;
  if (Array.isArray(causes) && causes.length) {
    return causes
      .map((cause) => cause.description || cause.message || cause.code)
      .filter(Boolean)
      .join(' | ');
  }
  return err?.message || 'Falha ao criar anuncio no Mercado Livre';
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

async function resolveSource(body) {
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
  };
}

function buildDescription(source, title) {
  const custom = normalizeText(source.description);
  if (custom.length > 60) return custom;
  const brand = (source.attributes || []).find((attr) => attr.id === 'BRAND');
  const brandText = brand?.value_name ? ` Marca: ${brand.value_name}.` : '';
  return `${title}. Produto novo e pronto para envio.${brandText}`;
}

function buildPayloads(source, body, margin, freeShipping, descriptionText) {
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

  const price = Math.round(sourcePrice / (1 - margin));
  const title = sanitizeTitle(body.titulo || source.title);

  const base = {
    title,
    category_id: source.categoryId,
    price,
    currency_id: source.currencyId,
    available_quantity: Math.max(Number(body.available_quantity) || 1, 1),
    buying_mode: 'buy_it_now',
    condition: source.condition,
    listing_type_id: body.listing_type_id || LISTING_TYPE,
    pictures,
    accepts_mercadopago: true,
    shipping: {
      mode: 'me2',
      local_pick_up: false,
      free_shipping: Boolean(freeShipping),
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
        family_name: sanitizeTitle(source.product.name),
      },
    });
  }

  payloads.push({ variant: 'normal', payload: base });

  if (base.listing_type_id !== 'free') {
    payloads.push({
      variant: 'free',
      payload: { ...base, listing_type_id: 'free' },
    });
  }

  return {
    payloads,
    price,
    margin,
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

router.post('/validar', async (req, res, next) => {
  try {
    const margin = clampMargin(req.body.margem ?? req.body.margin);
    const source = await resolveSource(req.body);
    const descriptionText = buildDescription(source, source.title);
    const built = buildPayloads(
      source,
      req.body,
      margin,
      req.body.free_shipping,
      descriptionText
    );

    const results = [];
    for (const { variant, payload } of built.payloads) {
      try {
        const result = await mlFetch('/items/validate', {
          method: 'POST',
          body: payload,
        });
        results.push({ variant, ok: true, result });
      } catch (err) {
        results.push({
          variant,
          ok: false,
          error: formatMlError(err),
          details: err.details || null,
        });
      }
    }

    res.json({
      source: {
        catalogo_id: source.product?.id || null,
        item_id: source.itemId,
        title: built.title,
        source_price: built.sourcePrice,
        price: built.price,
        category_id: source.categoryId,
        seller_id: source.sellerId,
      },
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
    const descriptionText = buildDescription(source, source.title);
    const built = buildPayloads(
      source,
      req.body,
      margin,
      req.body.free_shipping,
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
      (source.sellerId ? `Vendedor ${source.sellerId}` : 'Mercado Livre');
    const supplierId =
      req.body.fornecedor_id ||
      (typeof supplierInput === 'object' ? supplierInput?.id : null) ||
      source.sellerId ||
      null;

    const score = scoreListing(built.payloads[0].payload, descriptionText);
    const permalink =
      created.permalink ||
      `https://www.mercadolivre.com.br/p/${source.product?.id || source.itemId}`;

    await query(
      `INSERT INTO listings
         (ml_item_id, title, price, supplier, status, score, source_item_id,
          source_price, supplier_id, permalink, margin, thumbnail, created_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,NOW())
       ON CONFLICT (ml_item_id) DO UPDATE SET
         title = EXCLUDED.title,
         price = EXCLUDED.price,
         status = EXCLUDED.status,
         score = EXCLUDED.score`,
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
