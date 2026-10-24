import crypto from 'node:crypto';
import express from 'express';
import { mlFetch } from '../lib/ml.js';
import { query } from '../lib/db.js';

const router = express.Router();

const KEYWORD_CACHE_MS = 30 * 60 * 1000;
const DEFAULT_KEYWORDS = [
  'organizador',
  'cozinha',
  'pet',
  'fone bluetooth',
  'smartwatch',
  'led',
  'carregador',
  'suporte celular',
  'mochila',
  'garrafa termica',
  'luminaria',
  'ferramentas',
  'brinquedo educativo',
  'semijoias',
  'perfume',
  'cama pet',
  'aspirador portatil',
  'tapete',
];
let keywordCache = { at: 0, data: [] };
let collecting = null;

function clamp(value, min, max) {
  return Math.min(Math.max(value, min), max);
}

function toNumber(value) {
  if (value == null || value === '') return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function saoPauloDate() {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: 'America/Sao_Paulo',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(new Date());
}

function extractGtin(attributes) {
  const attribute = (attributes || []).find((item) =>
    ['GTIN', 'EAN', 'UPC'].includes(item.id)
  );
  const digits = String(attribute?.value_name || '').replace(/\D/g, '');
  return digits || null;
}

function searchRanking(items) {
  return (items || [])
    .map((item) => Number(item.price))
    .filter((price) => Number.isFinite(price) && price > 0);
}

function keywordUrl(keyword) {
  return `https://lista.mercadolivre.com.br/${encodeURIComponent(keyword)
    .replace(/%20/g, '-')
    .toLowerCase()}`;
}

function mergeKeywords(list) {
  const seen = new Set();
  const merged = [];
  for (const item of [...(list || []), ...DEFAULT_KEYWORDS.map((keyword) => ({ keyword }))]) {
    const keyword = String(item?.keyword || '').trim().toLowerCase();
    if (!keyword || seen.has(keyword)) continue;
    seen.add(keyword);
    merged.push({ keyword, url: item.url || keywordUrl(keyword) });
  }
  return merged;
}

async function trendingKeywords() {
  if (Date.now() - keywordCache.at < KEYWORD_CACHE_MS) {
    return mergeKeywords(keywordCache.data);
  }
  const data = await mlFetch('/trends/MLB');
  keywordCache = {
    at: Date.now(),
    data: Array.isArray(data) ? data.filter((item) => item.keyword) : [],
  };
  return mergeKeywords(keywordCache.data);
}

async function mapLimit(items, limit, worker) {
  const results = new Array(items.length);
  let index = 0;
  const size = Math.min(limit, items.length);

  async function run() {
    while (index < items.length) {
      const current = index;
      index += 1;
      results[current] = await worker(items[current], current);
    }
  }

  await Promise.all(Array.from({ length: size }, () => run()));
  return results;
}

async function collectKeyword(keyword, productLimit, capturedOn) {
  const searchLimit = Math.min(productLimit * 2, 12);
  const params = new URLSearchParams({
    site_id: 'MLB',
    status: 'active',
    q: keyword,
    limit: String(searchLimit),
  });
  const search = await mlFetch(`/products/search?${params.toString()}`);
  const products = search.results || [];
  let saved = 0;

  for (let position = 0; position < products.length; position += 1) {
    if (saved >= productLimit) break;
    const product = products[position];
    try {
      const offersResponse = await mlFetch(
        `/products/${encodeURIComponent(product.id)}/items?limit=10`
      );
      const offers = (offersResponse.results || []).filter(
        (offer) => Number(offer.price) > 0
      );
      if (!offers.length) continue;

      const prices = searchRanking(offers);
      const sellers = new Set(
        offers.map((offer) => offer.seller_id).filter(Boolean)
      );
      const freeShipping = offers.filter(
        (offer) => offer.shipping?.free_shipping
      ).length;
      const official = offers.filter((offer) => offer.official_store_id).length;
      const best = [...offers].sort(
        (a, b) => Number(a.price) - Number(b.price)
      )[0];
      const pictures = (product.pictures || [])
        .map((picture) => picture.url || picture.secure_url)
        .filter(Boolean);
      const thumbnail = pictures[0] || product.thumbnail || null;
      const gtin = extractGtin(product.attributes);

      await query(
        `INSERT INTO trend_product_snapshots
           (keyword, product_id, gtin, name, domain_id, thumbnail, permalink,
            best_item_id, best_seller_id, price_min, price_max, offers_count,
            sellers_count, free_shipping_count, official_count,
            best_listing_type, position, captured_on)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18)
         ON CONFLICT (keyword, product_id, captured_on) DO UPDATE SET
           gtin = EXCLUDED.gtin,
           name = EXCLUDED.name,
           domain_id = EXCLUDED.domain_id,
           thumbnail = EXCLUDED.thumbnail,
           permalink = EXCLUDED.permalink,
           best_item_id = EXCLUDED.best_item_id,
           best_seller_id = EXCLUDED.best_seller_id,
           price_min = EXCLUDED.price_min,
           price_max = EXCLUDED.price_max,
           offers_count = EXCLUDED.offers_count,
           sellers_count = EXCLUDED.sellers_count,
           free_shipping_count = EXCLUDED.free_shipping_count,
           official_count = EXCLUDED.official_count,
           best_listing_type = EXCLUDED.best_listing_type,
           position = EXCLUDED.position,
           captured_at = NOW()`,
        [
          keyword,
          product.id,
          gtin,
          product.name || null,
          product.domain_id || null,
          thumbnail,
          `https://www.mercadolivre.com.br/p/${product.id}`,
          best.item_id || null,
          best.seller_id || null,
          Math.min(...prices),
          Math.max(...prices),
          offers.length,
          sellers.size,
          freeShipping,
          official,
          best.listing_type_id || null,
          position + 1,
          capturedOn,
        ]
      );
      saved += 1;
    } catch (err) {
      if (err?.status !== 404) {
        console.error(
          `[trends] ${keyword} / ${product.id}:`,
          err?.message || err
        );
      }
    }
  }

  return saved;
}

async function collectRadar({ keywordLimit, productLimit }) {
  const capturedOn = saoPauloDate();
  const trends = (await trendingKeywords()).slice(0, keywordLimit);
  const errors = [];

  for (let position = 0; position < trends.length; position += 1) {
    await query(
      `INSERT INTO trend_keyword_snapshots (keyword, position, captured_on)
       VALUES ($1,$2,$3)
       ON CONFLICT (keyword, captured_on) DO UPDATE SET
         position = EXCLUDED.position,
         captured_at = NOW()`,
      [trends[position].keyword, position + 1, capturedOn]
    );
  }

  const counts = await mapLimit(trends, 3, async (trend) => {
    try {
      return await collectKeyword(trend.keyword, productLimit, capturedOn);
    } catch (err) {
      errors.push({
        keyword: trend.keyword,
        error: err?.message || 'Falha ao coletar',
      });
      return 0;
    }
  });

  await query(
    "DELETE FROM trend_product_snapshots WHERE captured_on < CURRENT_DATE - 120"
  );
  await query(
    "DELETE FROM trend_keyword_snapshots WHERE captured_on < CURRENT_DATE - 120"
  );

  return {
    captured_on: capturedOn,
    keywords: trends.length,
    products: counts.reduce((sum, count) => sum + count, 0),
    errors: errors.slice(0, 10),
  };
}

function cronAuthorized(req) {
  const secret = process.env.CRON_SECRET;
  if (!secret) return false;
  const candidate =
    (req.get('authorization') || '').replace(/^Bearer\s+/i, '') ||
    String(req.query.secret || '');
  if (!candidate) return false;
  const hashA = crypto.createHash('sha256').update(String(candidate)).digest();
  const hashB = crypto.createHash('sha256').update(String(secret)).digest();
  return crypto.timingSafeEqual(hashA, hashB);
}

async function runCollection(req, res, next, keywordLimit, productLimit) {
  if (collecting) {
    return res.status(409).json({
      error: 'Já existe uma coleta do radar em andamento.',
      code: 'TREND_COLLECTING',
    });
  }

  try {
    collecting = collectRadar({ keywordLimit, productLimit });
    const result = await collecting;
    res.json(result);
  } catch (err) {
    next(err);
  } finally {
    collecting = null;
  }
}

router.get('/cron', async (req, res, next) => {
  if (!cronAuthorized(req)) {
    return res.status(401).json({ error: 'Cron do radar nao autorizado.' });
  }
  return runCollection(req, res, next, 12, 6);
});

router.get('/palavras', async (req, res, next) => {
  try {
    const trends = await trendingKeywords();
    res.json(trends.slice(0, 50));
  } catch (err) {
    next(err);
  }
});

router.post('/coletar', async (req, res, next) => {
  const keywordLimit = clamp(Number(req.body?.limite_keywords) || 10, 1, 30);
  const productLimit = clamp(Number(req.body?.limite_produtos) || 5, 1, 10);
  return runCollection(req, res, next, keywordLimit, productLimit);
});

router.get('/radar', async (req, res, next) => {
  try {
    const janela = clamp(Number(req.query.janela) || 10, 1, 30);
    const limite = clamp(Number(req.query.limite) || 60, 1, 100);

    const [keywordsResult, productsResult, historyResult] = await Promise.all([
      query(
        `WITH latest AS (
           SELECT DISTINCT ON (keyword) keyword, position, captured_on, captured_at
           FROM trend_keyword_snapshots
           ORDER BY keyword, captured_on DESC
         )
         SELECT l.keyword, l.position, l.captured_on, l.captured_at,
                p.position AS position_then
         FROM latest l
         LEFT JOIN LATERAL (
           SELECT position
           FROM trend_keyword_snapshots s
           WHERE s.keyword = l.keyword
             AND s.captured_on <= l.captured_on - $1::int
           ORDER BY s.captured_on DESC
           LIMIT 1
         ) p ON TRUE
         ORDER BY l.position ASC
         LIMIT 50`,
        [janela]
      ),
      query(
        `WITH latest AS (
           SELECT DISTINCT ON (keyword, product_id) *
           FROM trend_product_snapshots
           ORDER BY keyword, product_id, captured_on DESC
         )
         SELECT l.*,
                p.position AS position_then,
                p.offers_count AS offers_then,
                p.price_min AS price_then,
                sp.fornecedor_id AS supplier_id,
                sp.fornecedor_nome AS supplier_name,
                sp.sku AS supplier_sku,
                sp.custo AS supplier_cost,
                sp.estoque AS supplier_stock,
                sp.peso_kg AS supplier_weight_kg
         FROM latest l
         LEFT JOIN LATERAL (
           SELECT position, offers_count, price_min
           FROM trend_product_snapshots s
           WHERE s.keyword = l.keyword
             AND s.product_id = l.product_id
             AND s.captured_on <= l.captured_on - $1::int
           ORDER BY s.captured_on DESC
           LIMIT 1
         ) p ON TRUE
         LEFT JOIN LATERAL (
           SELECT sp.*
           FROM supplier_products sp
           WHERE sp.ativo
             AND (sp.estoque > 0 OR sp.estoque IS NULL)
             AND (
               (l.gtin IS NOT NULL AND sp.gtin = l.gtin)
               OR sp.catalogo_id = l.product_id
             )
           ORDER BY (sp.catalogo_id = l.product_id) DESC, sp.custo ASC
           LIMIT 1
         ) sp ON TRUE
         WHERE l.captured_on >= (
           SELECT MAX(captured_on) - 2 FROM trend_product_snapshots
         )
         ORDER BY l.sellers_count ASC, l.position ASC, l.captured_on DESC
         LIMIT $2`,
        [janela, limite]
      ),
      query(
        `SELECT COUNT(DISTINCT captured_on)::int AS dias,
                MAX(captured_at) AS ultima_coleta
         FROM trend_product_snapshots
         WHERE captured_on >= CURRENT_DATE - $1::int`,
        [janela]
      ),
    ]);

    const keywords = keywordsResult.rows.map((row) => {
      const positionThen = toNumber(row.position_then);
      const position = toNumber(row.position);
      return {
        keyword: row.keyword,
        posicao: position,
        posicao_antes: positionThen,
        posicao_delta:
          positionThen == null ? null : positionThen - position,
        capturado_em: row.captured_at,
      };
    });

    const keywordsByName = new Map(
      keywords.map((item) => [item.keyword, item])
    );

    const produtos = productsResult.rows
      .map((row) => {
        const price = toNumber(row.price_min);
        const priceThen = toNumber(row.price_then);
        const offers = toNumber(row.offers_count) || 0;
        const offersThen = toNumber(row.offers_then);
        const sellers = toNumber(row.sellers_count) || 0;
        const position = toNumber(row.position) || 50;
        const positionThen = toNumber(row.position_then);
        const supplierCost = toNumber(row.supplier_cost);
        const keyword = keywordsByName.get(row.keyword);
        const keywordDelta = keyword?.posicao_delta;
        const offerDelta = offersThen == null ? null : offers - offersThen;
        const priceDeltaPct =
          price && priceThen
            ? Math.round(((price - priceThen) / priceThen) * 1000) / 10
            : null;
        const grossMarginPct =
          price && supplierCost && supplierCost > 0
            ? Math.round(((price - supplierCost) / price) * 1000) / 10
            : null;

        let score = 50;
        if (keywordDelta != null) score += clamp(keywordDelta * 2, -25, 25);
        if (offerDelta != null) score += clamp(offerDelta * 2, -10, 10);
        score += clamp(15 - sellers, -15, 15);
        score += clamp(10 - position, -10, 10);
        score += offers >= 3 ? 5 : offers === 2 ? 0 : -8;
        if (grossMarginPct != null) {
          score += clamp(Math.round(grossMarginPct / 4), 0, 15);
        }
        score = clamp(Math.round(score), 0, 100);

        return {
          keyword: row.keyword,
          product_id: row.product_id,
          gtin: row.gtin,
          nome: row.name,
          dominio: row.domain_id,
          thumbnail: row.thumbnail,
          permalink: row.permalink,
          item_id: row.best_item_id,
          seller_id: row.best_seller_id,
          posicao: position,
          posicao_antes: positionThen,
          posicao_delta:
            positionThen == null ? null : positionThen - position,
          preco: price,
          preco_antes: priceThen,
          preco_delta_pct: priceDeltaPct,
          ofertas: offers,
          ofertas_antes: offersThen,
          ofertas_delta: offerDelta,
          vendedores: sellers,
          frete_gratis: toNumber(row.free_shipping_count) || 0,
          ofertas_oficiais: toNumber(row.official_count) || 0,
          tipo_anuncio: row.best_listing_type,
          fornecedor_id: row.supplier_id,
          fornecedor_nome: row.supplier_name,
          fornecedor_sku: row.supplier_sku,
          custo: supplierCost,
          estoque: toNumber(row.supplier_stock),
          peso_kg: toNumber(row.supplier_weight_kg),
          margem_bruta_pct: grossMarginPct,
          score,
          capturado_em: row.captured_at,
        };
      })
      .sort((a, b) => b.score - a.score || a.vendedores - b.vendedores)
      .slice(0, limite);

    res.json({
      janela,
      dias_historico: historyResult.rows[0]?.dias || 0,
      ultima_coleta: historyResult.rows[0]?.ultima_coleta || null,
      keywords,
      produtos,
    });
  } catch (err) {
    next(err);
  }
});

export default router;
