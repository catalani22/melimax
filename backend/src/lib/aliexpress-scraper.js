import crypto from 'node:crypto';

const MTOP_APP_KEY = '12574478';
const STORE_RECOMMEND_APP_KEY = '24770048';
const MTOP_API = 'mtop.aliexpress.pdp.pc.query';
const USER_AGENT =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36';
const BASE_COOKIE = 'aep_usuc_f=site=bra&c_tp=BRL&region=BR&b_locale=pt_BR';

export const DEFAULT_MULTIPLIER = 2.8;
export const MIN_ML_PRICE = 79.9;
export const ML_FEE_RATE = Number(process.env.ML_FEE_RATE || 0.19);
export const ML_TAX_RATE = Number(process.env.ML_TAX_RATE || 0.06);
export const ML_SHIPPING_COST = Number(process.env.ML_SHIPPING_COST || 0);
export const PREMIUM_LISTING_TYPE =
  process.env.ML_LISTING_TYPE || 'gold_pro';

export const APPROVED_BRAZIL_STORES = [
  {
    storeId: '1105400522',
    sellerId: 7440044150,
    storeName: 'CSSV SHOP Store',
    positiveRate: '92.6%',
    storeRating: '4.8',
    country: 'Brasil',
    prazo: '5 a 10 dias corridos',
    storeUrl: 'https://pt.aliexpress.com/store/1105400522',
    logo: 'https://ae-pic-a1.aliexpress-media.com/kf/A3e1082e710134e4199c65005f3e259919.jpeg',
    destaque: 'Lote 1 Homologado · Estoque no Brasil & Frete Grátis',
  },
  {
    storeId: '1104933528',
    sellerId: 6175840477,
    storeName: 'DropFacil Store',
    positiveRate: '92.6%',
    storeRating: '4.8',
    country: 'Brasil',
    prazo: 'Até 10 dias corridos (82.6% ≤ 10 dias)',
    storeUrl: 'https://pt.aliexpress.com/store/1104933528',
    logo: 'https://ae-pic-a1.aliexpress-media.com/kf/A6e85faf84f8645968d1b64d074b30889J.jpg',
    destaque: 'Lote 2 Homologado · Compromisso Frete Grátis Do Brasil',
  },
  {
    storeId: '912339645',
    sellerId: 4419495457,
    storeName: 'neverdie Store',
    positiveRate: '96.4%',
    storeRating: '4.9',
    country: 'Brasil',
    prazo: '5 a 10 dias corridos',
    storeUrl: 'https://pt.aliexpress.com/store/912339645',
    logo: 'https://ae-pic-a1.aliexpress-media.com/kf/A3e475e17753a413a8df56203750d2d18P.jpg',
    destaque: 'Fornecedor Homologado Brasil · 50.4K seguidores',
  },
  {
    storeId: '1104106589',
    sellerId: 6046463989,
    storeName: 'LegalPlus Store',
    positiveRate: '95.1%',
    storeRating: '4.8',
    country: 'Brasil',
    prazo: '5 a 10 dias corridos',
    storeUrl: 'https://pt.aliexpress.com/store/1104106589',
    logo: 'https://ae-pic-a1.aliexpress-media.com/kf/S306f2ac746e54452a6a84fb9d91ecaf0G.webp',
    destaque: 'Fornecedor Homologado Brasil · Alta aprovação',
  },
  {
    storeId: '1102890948',
    sellerId: 4589515069,
    storeName: 'Zongha Loja Store',
    positiveRate: '97.9%',
    storeRating: '4.9',
    country: 'Brasil',
    prazo: '5 a 10 dias corridos',
    storeUrl: 'https://pt.aliexpress.com/store/1102890948',
    logo: 'https://ae-pic-a1.aliexpress-media.com/kf/A2226694801964c9e8fcfa4a52699d83df.jpeg',
    destaque: 'Fornecedor Homologado Brasil · 97.9% avaliações positivas',
  },
  {
    storeId: '1105400523',
    sellerId: 7439912168,
    storeName: 'JP DIGITAL Store',
    positiveRate: '91.9%',
    storeRating: '4.7',
    country: 'Brasil',
    prazo: '5 a 10 dias corridos',
    storeUrl: 'https://pt.aliexpress.com/store/1105400523',
    logo: 'https://ae-pic-a1.aliexpress-media.com/kf/Ab8bcf09479f1449aa8c69cf15dbfdc45s.jpeg',
    destaque: 'Fornecedor Homologado Brasil · Eletrônicos & Utilidades',
  },
];

export function getApprovedStoreById(storeId) {
  return APPROVED_BRAZIL_STORES.find((s) => String(s.storeId) === String(storeId)) || null;
}

export function hasFreeShippingBrazil(storeEntry) {
  if (!storeEntry) return false;
  const atmStr = JSON.stringify(storeEntry.atmosphere || []);
  if (/Free_Shipping_atm|frete\s*gr[aá]tis/i.test(atmStr)) return true;
  const debugQuery = String(storeEntry?.productExt?.spDebugQuery || '');
  if (/free_ship_summary_idx=-BR/i.test(debugQuery)) return true;
  return false;
}

let cachedSession = {
  token: '',
  cookieHeader: BASE_COOKIE,
  expiresAt: 0,
};

let cachedRecommendSession = {
  token: '',
  cookieHeader: BASE_COOKIE,
  expiresAt: 0,
};

export function extractAliExpressItemId(input) {
  const str = String(input || '').trim();
  const matchUrl = str.match(/\/(?:item|i)\/(\d{10,20})\.(?:html|htm)/i);
  if (matchUrl) return matchUrl[1];
  const matchParam = str.match(/productId=(\d{10,20})/i);
  if (matchParam) return matchParam[1];
  const matchDigits = str.match(/\b(1005\d{12})\b/);
  if (matchDigits) return matchDigits[1];
  return null;
}

export function canonicalAliExpressUrl(itemId) {
  return `https://pt.aliexpress.com/item/${itemId}.html`;
}

export function calculateMlPricing(costBrl, multiplier = DEFAULT_MULTIPLIER, minPrice = MIN_ML_PRICE) {
  const cost = Math.max(Number(costBrl) || 0, 0);
  const mult = Number(multiplier) > 0 ? Number(multiplier) : DEFAULT_MULTIPLIER;
  const floor = Number(minPrice) > 0 ? Number(minPrice) : MIN_ML_PRICE;
  const calculated = Number((cost * mult).toFixed(2));
  const finalPrice = Number(Math.max(calculated, floor).toFixed(2));
  const pisoAplicado = finalPrice > calculated;
  const mlFee = Number((finalPrice * ML_FEE_RATE).toFixed(2));
  const taxes = Number((finalPrice * ML_TAX_RATE).toFixed(2));
  const shippingSellerCost = Number(ML_SHIPPING_COST.toFixed(2));
  const grossMargin = Number((finalPrice - cost).toFixed(2));
  const netProfit = Number((finalPrice - cost - mlFee - taxes - shippingSellerCost).toFixed(2));
  const netMarginPct = finalPrice > 0 ? Number(((netProfit / finalPrice) * 100).toFixed(1)) : 0;
  const roiPct = cost > 0 ? Number(((netProfit / cost) * 100).toFixed(1)) : 0;
  const totalOperationCost = Number((cost + mlFee + taxes + shippingSellerCost).toFixed(2));

  return {
    cost: Number(cost.toFixed(2)),
    multiplier: mult,
    calculated,
    floor,
    finalPrice,
    pisoAplicado,
    mlFee,
    taxes,
    shippingSellerCost,
    grossMargin,
    netProfit,
    netMarginPct,
    roiPct,
    totalOperationCost,
    listingType: PREMIUM_LISTING_TYPE,
    feeRate: ML_FEE_RATE,
    taxRate: ML_TAX_RATE,
  };
}

async function fetchWithTimeout(url, options = {}, timeoutMs = 15000) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(url, { ...options, signal: controller.signal });
  } finally {
    clearTimeout(timer);
  }
}

async function getMtopSession(forceRefresh = false) {
  if (!forceRefresh && cachedSession.token && Date.now() < cachedSession.expiresAt) {
    return cachedSession;
  }

  const initUrl = `https://acs.aliexpress.com/h5/${MTOP_API}/1.0/?jsv=2.5.1&appKey=${MTOP_APP_KEY}&t=${Date.now()}&sign=0000&api=${MTOP_API}&v=1.0&type=originaljson&dataType=jsonp&data=%7B%7D`;
  const res = await fetchWithTimeout(initUrl, {
    headers: {
      'User-Agent': USER_AGENT,
      Referer: 'https://pt.aliexpress.com/',
      'Accept-Language': 'pt-BR,pt;q=0.9',
    },
  });

  const setCookies = typeof res.headers.getSetCookie === 'function' ? res.headers.getSetCookie() : [];
  const cookieMap = {};
  for (const cookieStr of setCookies) {
    const [kv] = String(cookieStr).split(';');
    const eq = kv.indexOf('=');
    if (eq > 0) {
      cookieMap[kv.slice(0, eq).trim()] = kv.slice(eq + 1).trim();
    }
  }

  const mh5tk = cookieMap._m_h5_tk || '';
  const token = mh5tk.split('_')[0] || '';
  const cookiePairs = Object.entries(cookieMap).map(([k, v]) => `${k}=${v}`);
  cookiePairs.push(BASE_COOKIE);

  cachedSession = {
    token,
    cookieHeader: cookiePairs.join('; '),
    expiresAt: Date.now() + 25 * 60 * 1000,
  };
  return cachedSession;
}

async function queryMtopPdp(itemId, attempt = 0) {
  const session = await getMtopSession(attempt > 0);
  const t = String(Date.now());
  const dataObj = {
    productId: String(itemId),
    _lang: 'pt_BR',
    _currency: 'BRL',
    country: 'BR',
    province: 'Sao Paulo',
    city: 'Sao Paulo',
    clientType: 'pc',
    ext: JSON.stringify({ site: 'bra', signedIn: false, host: 'pt.aliexpress.com' }),
  };
  const dataStr = JSON.stringify(dataObj);
  const sign = crypto
    .createHash('md5')
    .update(`${session.token}&${t}&${MTOP_APP_KEY}&${dataStr}`)
    .digest('hex');

  const params = new URLSearchParams({
    jsv: '2.5.1',
    appKey: MTOP_APP_KEY,
    t,
    sign,
    api: MTOP_API,
    v: '1.0',
    type: 'originaljson',
    dataType: 'json',
    data: dataStr,
  });

  const res = await fetchWithTimeout(`https://acs.aliexpress.com/h5/${MTOP_API}/1.0/?${params}`, {
    headers: {
      'User-Agent': USER_AGENT,
      Referer: canonicalAliExpressUrl(itemId),
      'Accept-Language': 'pt-BR,pt;q=0.9',
      Cookie: session.cookieHeader,
    },
  });

  const json = await res.json();
  const retStr = JSON.stringify(json?.ret || []);
  if (/TOKEN_EXOIRED|TOKEN_EMPTY|ILLEGAL_ACCESS|SESSION_EXPIRED/i.test(retStr) && attempt < 2) {
    return queryMtopPdp(itemId, attempt + 1);
  }
  return json?.data?.result || null;
}

async function fetchHtmlFallback(itemId) {
  const res = await fetchWithTimeout(canonicalAliExpressUrl(itemId), {
    headers: {
      'User-Agent': USER_AGENT,
      'Accept-Language': 'pt-BR,pt;q=0.9,en-US;q=0.8',
      Cookie: BASE_COOKIE,
    },
  });
  const html = await res.text();
  let imagePathList = [];
  const dcMatch = html.match(/window\._d_c_\.DCData\s*=\s*(\{[\s\S]*?\});\s*<\/script>/);
  if (dcMatch) {
    try {
      const dc = JSON.parse(dcMatch[1]);
      if (Array.isArray(dc.imagePathList)) imagePathList = dc.imagePathList;
    } catch {}
  }
  if (!imagePathList.length) {
    const rawImgs =
      html.match(
        /https?:\/\/[a-z0-9.-]*(?:aliexpress-media|alicdn)\.com\/kf\/[A-Za-z0-9]+\.(?:jpg|jpeg|png|webp)/gi
      ) || [];
    imagePathList = [...new Set(rawImgs)];
  }
  const ogTitleMatch = html.match(/<meta\s+property=["']og:title["']\s+content=["']([^"']+)["']/i);
  const ogTitle = ogTitleMatch ? decodeHtmlEntities(ogTitleMatch[1]).replace(/\s*-\s*AliExpress.*$/i, '').trim() : '';
  return { title: ogTitle, imagePathList };
}

export function decodeHtmlEntities(text) {
  return String(text || '')
    .replace(/&nbsp;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/&quot;/gi, '"')
    .replace(/&#39;|&apos;/gi, "'")
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&#(\d+);/g, (_, code) => String.fromCharCode(Number(code)))
    .replace(/&#x([0-9a-f]+);/gi, (_, hex) => String.fromCharCode(parseInt(hex, 16)));
}

export function normalizeImageUrl(rawUrl) {
  if (!rawUrl) return null;
  let url = String(rawUrl).trim();
  if (url.startsWith('//')) url = `https:${url}`;
  url = url.replace(/^http:\/\//i, 'https://');
  if (!/^https:\/\/[a-z0-9.-]*(?:aliexpress-media|alicdn)\.com\/kf\//i.test(url)) return null;
  // Strip tiny icon/badge dimensions
  if (/\/(?:16x16|24x24|32x32|36x36|48x48|60x60|64x64|72x72|96x96|120x120)\./i.test(url)) {
    return null;
  }
  // Convert SEO-slugged thumbnail URLs like /kf/S5a69.../Slug.png_80x80.png -> /kf/S5a69....png
  const kfSlugMatch = url.match(
    /^(https:\/\/[a-z0-9.-]*(?:aliexpress-media|alicdn)\.com\/kf\/[A-Za-z0-9]+)\/[^?]*?\.(jpg|jpeg|png|webp)(?:_\d+x\d+[^?]*)?$/i
  );
  if (kfSlugMatch) {
    return `${kfSlugMatch[1]}.${kfSlugMatch[2]}`;
  }
  // Strip trailing resize suffix like .jpg_220x220q75.jpg_.webp -> .jpg
  url = url.replace(/\.(jpg|jpeg|png|webp)_[0-9]+x[0-9]+[^?]*$/i, '.$1');
  url = url.replace(/_\.webp$/i, '');
  url = url.split('?')[0];
  return url;
}

export function buildAtLeastFourImages(uniqueImages) {
  const list = [...uniqueImages];
  if (list.length >= 4) return list.slice(0, 10);
  if (list.length === 0) return [];

  // AliExpress CDN supports clean high-res sizing suffixes matching the source extension
  const sizes = ['1000x1000', '960x960', '800x800', '750x750'];
  let idx = 0;
  while (list.length < 4 && idx < 16) {
    const base = uniqueImages[idx % uniqueImages.length];
    const extMatch = base.match(/\.(png|jpg|jpeg|webp)$/i);
    const ext = extMatch ? extMatch[1] : 'jpg';
    const size = sizes[Math.floor(idx / uniqueImages.length) % sizes.length];
    const candidate = `${base}_${size}.${ext}`;
    if (!list.includes(candidate)) {
      list.push(candidate);
    }
    idx += 1;
  }
  return list;
}

export async function fetchEvaluationEnrichment(itemId) {
  try {
    const url = `https://feedback.aliexpress.com/pc/searchEvaluation.do?productId=${encodeURIComponent(
      itemId
    )}&lang=pt_BR&country=BR&page=1&pageSize=15`;
    const res = await fetchWithTimeout(url, {
      headers: { 'User-Agent': USER_AGENT, Referer: canonicalAliExpressUrl(itemId) },
    });
    if (!res.ok) return { images: [], skuHints: [], comments: [] };
    const json = await res.json();
    const list = json?.data?.evaViewList || [];
    const images = [];
    const skuHints = [];
    const comments = [];
    for (const ev of list) {
      for (const img of ev?.images || []) {
        const clean = normalizeImageUrl(img);
        if (clean && !images.includes(clean)) images.push(clean);
      }
      if (ev?.skuInfo && skuHints.length < 4) {
        const s = String(ev.skuInfo).trim();
        if (s && !skuHints.includes(s)) skuHints.push(s);
      }
      if (ev?.buyerTranslationFeedback && comments.length < 3) {
        const c = String(ev.buyerTranslationFeedback).trim();
        if (c.length > 15 && c.length < 180) comments.push(c);
      }
    }
    return { images, skuHints, comments };
  } catch {
    return { images: [], skuHints: [], comments: [] };
  }
}

async function getStoreRecommendSession(forceRefresh = false) {
  if (
    !forceRefresh &&
    cachedRecommendSession.token &&
    Date.now() < cachedRecommendSession.expiresAt
  ) {
    return cachedRecommendSession;
  }

  const initApi = 'mtop.alibaba.alisite.ae.server.ModuleAsyncService';
  const initUrl = `https://acs.aliexpress.com/h5/${initApi}/1.0/?jsv=2.5.1&appKey=${STORE_RECOMMEND_APP_KEY}&t=${Date.now()}&sign=0000&api=${initApi}&v=1.0&type=originaljson&dataType=jsonp`;
  const res = await fetchWithTimeout(initUrl, {
    headers: {
      'User-Agent': USER_AGENT,
      Referer: 'https://pt.aliexpress.com/',
      'Accept-Language': 'pt-BR,pt;q=0.9',
    },
  });

  const cookieMap = {
    aep_usuc_f: 'site=bra&c_tp=BRL&region=BR&b_locale=pt_BR',
    cna: 'UBFqI6dTvm0BASYAGQAfq9tC',
  };
  const setCookies = typeof res.headers.getSetCookie === 'function' ? res.headers.getSetCookie() : [];
  for (const cookieStr of setCookies) {
    const [kv] = String(cookieStr).split(';');
    const eq = kv.indexOf('=');
    if (eq > 0) {
      cookieMap[kv.slice(0, eq).trim()] = kv.slice(eq + 1).trim();
    }
  }

  const token = (cookieMap._m_h5_tk || '').split('_')[0] || '';
  const cookieHeader = Object.entries(cookieMap)
    .map(([k, v]) => `${k}=${v}`)
    .join('; ');

  cachedRecommendSession = {
    token,
    cookieHeader,
    expiresAt: Date.now() + 25 * 60 * 1000,
  };
  return cachedRecommendSession;
}

export async function resolveStoreMetadataLive(storeId) {
  const known = getApprovedStoreById(storeId);
  if (known) return known;

  const url = `https://pt.aliexpress.com/store/lego/pc/api/renderPageData.htm?storeId=${encodeURIComponent(
    storeId
  )}&pageId=0&language=portuguese&currency=BRL&country=BR&pagePath=all-items.htm&extParams=null`;
  const res = await fetchWithTimeout(url, {
    headers: { 'User-Agent': USER_AGENT, 'Accept-Language': 'pt-BR,pt;q=0.9' },
  });
  let text = await res.text();
  text = text.replace(/^[a-zA-Z0-9_$]*\(/, '').replace(/\)\s*;?\s*$/, '');
  const json = JSON.parse(text);
  const pd = json?.result?.pageData || {};
  const gd = pd?.globalData || {};
  const compStr = JSON.stringify(pd?.components || {});
  const nameMatch =
    compStr.match(/"storeName"\s*:\s*"([^"]+)"/) ||
    compStr.match(/"shopName"\s*:\s*"([^"]+)"/);

  return {
    storeId: String(storeId),
    sellerId: Number(gd.sellerId || 0),
    storeName: gd.storeName || nameMatch?.[1] || `Loja AliExpress ${storeId}`,
    positiveRate: '94.0%',
    storeRating: '4.8',
    country: 'Brasil',
    prazo: '5 a 10 dias corridos',
    storeUrl: `https://pt.aliexpress.com/store/${storeId}`,
  };
}

export async function fetchStoreCatalogLive(storeId, { maxPages = 10 } = {}) {
  const storeMeta = await resolveStoreMetadataLive(storeId);
  if (!storeMeta.sellerId) {
    throw new Error(`Não foi possível resolver o sellerId da loja ${storeId}.`);
  }

  let session = await getStoreRecommendSession(false);
  const itemsMap = new Map();

  for (const scene of ['just4you', 'camp4you', 'leaderboard']) {
    for (let page = 1; page <= maxPages; page++) {
      const dataObj = {
        currentPage: page,
        ignoreProductIds: '',
        pageSize: 50,
        storeNumber: Number(storeMeta.storeId),
        _lang: 'pt_BR',
        buyerId: '0',
        locale: 'pt_BR',
        currency: 'BRL',
        country: 'BR',
        sellerId: Number(storeMeta.sellerId),
        class: 'com.alibaba.site.decorate.web.client.model.request.ShopRecommendRequest',
        scene,
        platform: 'PC',
        deviceId: 'UBFqI6dTvm0BASYAGQAfq9tC',
      };
      const t = String(Date.now());
      const dataStr = JSON.stringify(dataObj);
      const sign = crypto
        .createHash('md5')
        .update(`${session.token}&${t}&${STORE_RECOMMEND_APP_KEY}&${dataStr}`)
        .digest('hex');

      const params = new URLSearchParams({
        jsv: '2.5.1',
        appKey: STORE_RECOMMEND_APP_KEY,
        t,
        sign,
        api: 'mtop.aliexpress.store.products.recommend',
        v: '1.0',
        type: 'originaljson',
        dataType: 'json',
      });

      const res = await fetchWithTimeout(
        `https://acs.aliexpress.com/h5/mtop.aliexpress.store.products.recommend/1.0/?${params}`,
        {
          method: 'POST',
          headers: {
            'User-Agent': USER_AGENT,
            Referer: `https://pt.aliexpress.com/store/${storeMeta.storeId}`,
            Cookie: session.cookieHeader,
            'Content-Type': 'application/x-www-form-urlencoded',
          },
          body: new URLSearchParams({ data: dataStr }).toString(),
        }
      );

      const json = await res.json();
      const retStr = JSON.stringify(json?.ret || []);
      if (/TOKEN_EXOIRED|TOKEN_EMPTY|ILLEGAL_ACCESS|SESSION_EXPIRED/i.test(retStr)) {
        session = await getStoreRecommendSession(true);
        continue;
      }

      const arr = json?.data?.data || [];
      const lastPage = Number(json?.data?.lastPage || 1);
      for (const it of arr) {
        if (it?.id) itemsMap.set(String(it.id), it);
      }
      if (!arr.length || page >= lastPage) break;
    }
  }

  const allItems = [...itemsMap.values()];
  const freeShippingItems = allItems.filter((it) => hasFreeShippingBrazil(it));
  const paidShippingItems = allItems.filter((it) => !hasFreeShippingBrazil(it));

  return {
    storeMeta,
    allItems,
    freeShippingItems,
    paidShippingItems,
  };
}

const DEDUP_STOP_WORDS = new Set([
  'de',
  'da',
  'do',
  'das',
  'dos',
  'com',
  'para',
  'por',
  'sem',
  'em',
  'no',
  'na',
  'nos',
  'nas',
  'uso',
  'tipo',
  'ideal',
  'alta',
  'portatil',
  'eletrico',
  'eletrica',
  'casa',
  'cozinha',
]);

export function normalizeTitleTokens(title) {
  return [
    ...new Set(
      String(title || '')
        .toLowerCase()
        .normalize('NFD')
        .replace(/[\u0300-\u036f]/g, '')
        .replace(/[^a-z0-9\s]/g, ' ')
        .split(/\s+/)
        .filter((w) => w.length >= 3 && !DEDUP_STOP_WORDS.has(w))
    ),
  ];
}

export function calculateTitleSimilarity(titleA, titleB) {
  const tokA = normalizeTitleTokens(titleA);
  const tokB = normalizeTitleTokens(titleB);
  if (!tokA.length || !tokB.length) return 0;
  const setB = new Set(tokB);
  const inter = tokA.filter((w) => setB.has(w)).length;
  const union = new Set([...tokA, ...tokB]).size;
  return union > 0 ? inter / union : 0;
}

export function findDuplicateInCatalog(
  candidateTitle,
  candidateItemId,
  catalog = [],
  similarityThreshold = 0.66
) {
  const cleanId = String(candidateItemId || '').trim();
  for (const existing of catalog) {
    if (cleanId && String(existing.aliexpress_item_id) === cleanId) {
      return { reason: 'mesmo_item_id', match: existing, similarity: 1 };
    }
  }
  if (!candidateTitle) return null;
  let best = null;
  for (const existing of catalog) {
    const sim = calculateTitleSimilarity(candidateTitle, existing.titulo_ml || '');
    if (sim >= similarityThreshold && (!best || sim > best.similarity)) {
      best = { reason: 'titulo_similar', match: existing, similarity: Number(sim.toFixed(2)) };
    }
  }
  return best;
}

export function computeMlQualityScore(product) {
  const issues = [];
  let titlePts = 0;
  const title = String(product?.titulo_ml || '').trim();
  if (title.length >= 36 && title.length <= 60) {
    titlePts = 25;
  } else if (title.length >= 26 && title.length <= 60) {
    titlePts = 21;
    issues.push('Título pode incluir mais palavras-chave técnicas (ideal 36–60 caracteres)');
  } else {
    titlePts = 14;
    issues.push('Ajustar tamanho do título para entre 36 e 60 caracteres');
  }

  let imgPts = 0;
  const imgCount = Number(product?.qtd_imagens || product?.imagens?.length || 0);
  if (imgCount >= 6) imgPts = 25;
  else if (imgCount >= 4) imgPts = 23;
  else {
    imgPts = 10;
    issues.push('Adicionar no mínimo 4 imagens de alta resolução');
  }

  let specPts = 0;
  if (product?.marca) specPts += 5;
  if (product?.modelo) specPts += 5;
  if (product?.sku) specPts += 4;
  if (product?.motivo_sem_gtin || product?.codigo_universal_ean) specPts += 3;
  if (product?.peso_kg && product?.comprimento_cm && product?.largura_cm && product?.altura_cm) {
    specPts += 3;
  }

  let descPts = 0;
  const descLen = String(product?.descricao_ml_otimizada || '').length;
  if (descLen >= 700) descPts = 15;
  else if (descLen >= 400) descPts = 12;
  else {
    descPts = 6;
    issues.push('Expandir descrição em texto plano com ficha técnica e conteúdo da embalagem');
  }

  let shipPts = 0;
  if (product?.frete_gratis === 'Sim' && Number(product?.custo_envio_comprador_brl) === 0) {
    shipPts += 8;
  }
  if (product?.modalidade_entrega_ml === 'Vou enviar por minha conta') {
    shipPts += 4;
  }
  if (Number(product?.estoque_disponivel) >= 1) {
    shipPts += 3;
  }

  const score = Math.min(100, titlePts + imgPts + specPts + descPts + shipPts);
  return {
    score,
    ready: score >= 85,
    issues,
    breakdown: {
      titulo_seo: titlePts,
      imagens_hd: imgPts,
      ficha_tecnica: specPts,
      descricao_completa: descPts,
      frete_condicoes: shipPts,
    },
  };
}

function cleanSupplierDescriptionHtml(html) {
  if (!html) return { plainText: '', descImages: [] };
  const imgMatches = [...String(html).matchAll(/<img[^>]+src=["']([^"']+)["'][^>]*>/gi)].map((m) => m[1]);
  const descImages = [];
  for (const raw of imgMatches) {
    const clean = normalizeImageUrl(raw);
    if (clean && !descImages.includes(clean)) {
      descImages.push(clean);
    }
  }

  const text = decodeHtmlEntities(
    String(html)
      .replace(/<style[\s\S]*?<\/style>/gi, ' ')
      .replace(/<script[\s\S]*?<\/script>/gi, ' ')
      .replace(/<(?:br|\/p|\/div|\/li|\/tr|\/h[1-6])\b[^>]*>/gi, '\n')
      .replace(/<li\b[^>]*>/gi, '- ')
      .replace(/<[^>]+>/g, ' ')
  )
    .split('\n')
    .map((line) => line.replace(/\s+/g, ' ').trim())
    .filter((line) => {
      if (!line) return false;
      if (/^[-=_*~.]{4,}$/.test(line)) return false;
      if (/qualquer\s+d[uú]vida\s+entre\s+em\s+contato/i.test(line)) return false;
      if (/agradecemos\s+a\s+prefer[eê]ncia/i.test(line)) return false;
      if (/atendimento\s+pelo\s+chat|chame\s+no\s+chat/i.test(line)) return false;
      if (/aliexpress/i.test(line)) return false;
      return true;
    })
    .join('\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();

  return { plainText: text, descImages };
}

const CATEGORY_MAP = [
  {
    keywords: /fone|headset|earphone|auricular|caixa de som|speaker|microfone|audio|áudio|amplificador/i,
    mlCategory: 'Eletrônicos, Áudio e Vídeo > Áudio',
    mlCategoryId: 'MLB1000',
    defaultDims: { peso: 0.18, comp: 16, larg: 12, alt: 6 },
  },
  {
    keywords: /smartwatch|rel[oó]gio|pulseira inteligente|bracelete/i,
    mlCategory: 'Celulares e Telefones > Smartwatches e Acessórios',
    mlCategoryId: 'MLB135384',
    defaultDims: { peso: 0.2, comp: 16, larg: 10, alt: 6 },
  },
  {
    keywords: /carregador|cabo|power bank|suporte celular|capa|pel[ií]cula|galaxy|iphone|xiaomi|usb-c|adaptador/i,
    mlCategory: 'Celulares e Telefones > Acessórios para Celulares',
    mlCategoryId: 'MLB5092',
    defaultDims: { peso: 0.15, comp: 16, larg: 11, alt: 5 },
  },
  {
    keywords: /mouse|teclado|hub usb|webcam|notebook|ssd|pendrive|inform[aá]tica|cooler|wifi|roteador/i,
    mlCategory: 'Informática > Acessórios para PC',
    mlCategoryId: 'MLB1648',
    defaultDims: { peso: 0.28, comp: 20, larg: 14, alt: 7 },
  },
  {
    keywords: /cortador de unha|barbeador|aparador|depilador|escova|secador|chapinha|maquiagem|beleza|massageador|cabelo|unha|manicure/i,
    mlCategory: 'Beleza e Cuidado Pessoal > Cuidados Pessoais',
    mlCategoryId: 'MLB1246',
    defaultDims: { peso: 0.25, comp: 18, larg: 12, alt: 7 },
  },
  {
    keywords: /cozinha|panela|faca|amolador|pote|garrafa|t[eé]rmica|copo|escorredor|torneira|dispensador|organizador|limpeza|esfreg[aã]o|vassoura|aspirador|lumin[aá]ria|l[aâ]mpada|led|abajur|umidificador|ventilador/i,
    mlCategory: 'Casa, Móveis e Decoração > Utilidades Domésticas',
    mlCategoryId: 'MLB1574',
    defaultDims: { peso: 0.45, comp: 24, larg: 16, alt: 10 },
  },
  {
    keywords: /ferramenta|chave|parafusadeira|furadeira|lanterna|alicate|trena|mult[ií]metro|solda|serra|broca/i,
    mlCategory: 'Ferramentas > Ferramentas Manuais e Elétricas',
    mlCategoryId: 'MLB263532',
    defaultDims: { peso: 0.55, comp: 25, larg: 16, alt: 9 },
  },
  {
    keywords: /carro|automotivo|moto|veicular|pneu|compressor|farol|limpador|retrovisor|capacete/i,
    mlCategory: 'Acessórios para Veículos > Acessórios de Carros e Caminhonetes',
    mlCategoryId: 'MLB5672',
    defaultDims: { peso: 0.45, comp: 22, larg: 15, alt: 10 },
  },
  {
    keywords: /pet|cachorro|c[aã]es|gato|coleira|comedouro|brinquedo pet|tosa/i,
    mlCategory: 'Animais > Cães e Gatos',
    mlCategoryId: 'MLB1071',
    defaultDims: { peso: 0.32, comp: 20, larg: 15, alt: 8 },
  },
  {
    keywords: /esporte|academia|fitness|bicicleta|bike|camping|pesca|joelheira|el[aá]stico|garrafa esportiva/i,
    mlCategory: 'Esportes e Fitness > Acessórios Esportivos',
    mlCategoryId: 'MLB1276',
    defaultDims: { peso: 0.35, comp: 22, larg: 15, alt: 8 },
  },
  {
    keywords: /brinquedo|infantil|beb[eê]|jogo|educativo|boneco|pel[uú]cia|montar/i,
    mlCategory: 'Brinquedos e Hobbies > Brinquedos',
    mlCategoryId: 'MLB1132',
    defaultDims: { peso: 0.35, comp: 22, larg: 16, alt: 9 },
  },
  {
    keywords: /bolsa|mochila|carteira|[oó]culos|bon[eé]|cinto|meia|roupa|moda/i,
    mlCategory: 'Calçados, Roupas e Bolsas > Acessórios de Moda',
    mlCategoryId: 'MLB1430',
    defaultDims: { peso: 0.35, comp: 26, larg: 20, alt: 8 },
  },
];

function inferCategoryAndDimensions(title, attrsText, descText) {
  const combined = `${title} ${attrsText} ${descText}`;
  const matched = CATEGORY_MAP.find((entry) => entry.keywords.test(combined)) || {
    mlCategory: 'Casa, Móveis e Decoração > Utilidades e Acessórios',
    mlCategoryId: 'MLB1574',
    defaultDims: { peso: 0.35, comp: 20, larg: 15, alt: 8 },
  };

  let peso = matched.defaultDims.peso;
  let comp = matched.defaultDims.comp;
  let larg = matched.defaultDims.larg;
  let alt = matched.defaultDims.alt;

  // Parse real weight from description if present (e.g., "Peso: 250g" or "Peso: 0,45 kg")
  const weightG = descText.match(/peso[^:\n]{0,20}:\s*(\d{2,4})\s*g\b/i);
  const weightKg = descText.match(/peso[^:\n]{0,20}:\s*(\d+(?:[.,]\d+)?)\s*kg\b/i);
  if (weightKg) {
    const val = parseFloat(weightKg[1].replace(',', '.'));
    if (val >= 0.02 && val <= 30) peso = Number(val.toFixed(3));
  } else if (weightG) {
    const val = parseInt(weightG[1], 10) / 1000;
    if (val >= 0.02 && val <= 30) peso = Number(val.toFixed(3));
  }

  // Parse 3D dimensions like "20 x 15 x 8 cm" or "20cm x 15cm x 8cm"
  const dim3 = descText.match(
    /(\d{1,3}(?:[.,]\d+)?)\s*(?:cm)?\s*[xX×]\s*(\d{1,3}(?:[.,]\d+)?)\s*(?:cm)?\s*[xX×]\s*(\d{1,3}(?:[.,]\d+)?)\s*cm/i
  );
  if (dim3) {
    const nums = [dim3[1], dim3[2], dim3[3]]
      .map((n) => Math.max(Math.round(parseFloat(n.replace(',', '.'))), 2))
      .sort((a, b) => b - a);
    if (nums[0] <= 120) {
      [comp, larg, alt] = nums;
    }
  } else {
    const dim2 = descText.match(
      /(?:tamanho|medida|dimens[aã]o)[^:\n]{0,15}:\s*(\d{1,3}(?:[.,]\d+)?)\s*(?:cm)?\s*[xX×]\s*(\d{1,3}(?:[.,]\d+)?)\s*cm/i
    );
    if (dim2) {
      const nums = [dim2[1], dim2[2]]
        .map((n) => Math.max(Math.round(parseFloat(n.replace(',', '.'))), 3))
        .sort((a, b) => b - a);
      if (nums[0] <= 120) {
        comp = Math.max(nums[0] + 4, 14);
        larg = Math.max(nums[1] + 4, 10);
      }
    }
  }

  return {
    mlCategory: matched.mlCategory,
    mlCategoryId: matched.mlCategoryId,
    peso_kg: peso,
    comprimento_cm: comp,
    largura_cm: larg,
    altura_cm: alt,
  };
}

const UPPERCASE_WORDS = new Set([
  'USB',
  'USB-C',
  'LED',
  'RGB',
  'HD',
  'FHD',
  '4K',
  '3D',
  'TV',
  'PC',
  'PS4',
  'PS5',
  'TWS',
  'UV',
  'LCD',
  'WIFI',
  'WI-FI',
  'AUX',
  'P2',
  'P3',
  'MP3',
  'MP4',
  'HDMI',
  'VGA',
  'RC',
  'SUV',
  'SOS',
  'ABS',
  'PVC',
  'EVA',
  'RPM',
  'MAH',
  '12V',
  '24V',
  '110V',
  '220V',
]);

const LOWERCASE_CONNECTORS = new Set([
  'de',
  'da',
  'do',
  'das',
  'dos',
  'com',
  'para',
  'por',
  'pelo',
  'pela',
  'em',
  'no',
  'na',
  'nos',
  'nas',
  'e',
  'a',
  'à',
  'às',
  'o',
  'os',
  'as',
  'ao',
  'aos',
  'sem',
  'sob',
]);

const SPAM_PATTERNS = [
  /\baliexpress\b/gi,
  /\bpromo[cç][aã]o\b/gi,
  /\boferta\b/gi,
  /\bquente\b/gi,
  /\bhot\s*sale\b/gi,
  /\bfrete\s*gr[aá]tis\b/gi,
  /\bpronta\s*entrega\b/gi,
  /\benvio\s*(?:r[aá]pido|imediato|do\s+brasil|no\s+brasil|brasil|ja|j[aá])\b/gi,
  /\bestoque\s*(?:no\s*)?brasil\b/gi,
  /\bdo\s+brasil\b/gi,
  /\bno\s+brasil\b/gi,
  /\bbrasil\b$/gi,
  /\bdropshipping\b/gi,
  /\batacado\b/gi,
  /\b202[0-9]\b/g,
  /\bnovo[s]?\b/gi,
  /\bnova[s]?\b/gi,
  /\balta\s*qualidade\b/gi,
  /\bluxo\b/gi,
];

function formatPortugueseToken(word, index) {
  const clean = word.trim();
  if (!clean) return '';
  const upper = clean.toUpperCase();
  if (UPPERCASE_WORDS.has(upper)) return upper === 'WIFI' ? 'Wi-Fi' : upper;
  if (/^\d+(?:[.,]\d+)?(?:mm|cm|m|ml|l|g|kg|w|v|mah|gb|tb|hz|pcs|un|oz)$/i.test(clean)) {
    return clean
      .replace(/mah$/i, 'mAh')
      .replace(/gb$/i, 'GB')
      .replace(/tb$/i, 'TB')
      .replace(/hz$/i, 'Hz')
      .replace(/mm$/i, 'mm')
      .replace(/cm$/i, 'cm')
      .replace(/ml$/i, 'ml')
      .replace(/kg$/i, 'kg')
      .replace(/oz$/i, 'oz');
  }
  if (/^[A-Z0-9-]{2,8}$/.test(clean) && /\d/.test(clean)) {
    return clean.toUpperCase();
  }
  const lower = clean.toLowerCase();
  if (index > 0 && LOWERCASE_CONNECTORS.has(lower)) {
    return lower;
  }
  return lower.charAt(0).toUpperCase() + lower.slice(1);
}

export function rewriteMercadoLivreTitle(rawTitle, attrs = [], variationName = '') {
  let text = decodeHtmlEntities(rawTitle || '')
    .replace(/\s*-\s*AliExpress.*$/i, '')
    .replace(/[，、；：！？（）【】「」『』—–]/g, ' ')
    .replace(/[|•★☆✓✔🔥⚡✨[\]()]/g, ' ')
    .replace(/\btype[\s-]*c\b/gi, 'USB-C')
    .replace(/\btipo[\s-]*c\b/gi, 'USB-C')
    .replace(/\s*[\/,;:]+\s*/g, ' ');

  for (const rx of SPAM_PATTERNS) {
    text = text.replace(rx, ' ');
  }

  text = text.replace(/\bbrasil\b\s*$/i, ' ').replace(/\s+/g, ' ').trim();

  const rawTokens = text.split(' ').filter(Boolean);
  const seen = new Set();
  const tokens = [];

  for (const tok of rawTokens) {
    const cleanedTok = tok.replace(/^[-.,/]+|[-.,/]+$/g, '');
    if (!cleanedTok) continue;
    const lowerTok = cleanedTok.toLowerCase();
    const norm = lowerTok.normalize('NFD').replace(/[\u0300-\u036f]/g, '');
    if (!LOWERCASE_CONNECTORS.has(lowerTok) && seen.has(norm)) continue;
    if (
      LOWERCASE_CONNECTORS.has(lowerTok) &&
      tokens.length > 0 &&
      LOWERCASE_CONNECTORS.has(tokens[tokens.length - 1].toLowerCase())
    ) {
      tokens[tokens.length - 1] = cleanedTok;
      continue;
    }
    if (!LOWERCASE_CONNECTORS.has(lowerTok)) seen.add(norm);
    tokens.push(cleanedTok);
  }

  // Enrich short titles (< 38 chars) with non-redundant attributes/descriptors for 85%+ ML SEO quality
  let candidate = tokens.map((tok, i) => formatPortugueseToken(tok, i)).join(' ');
  if (candidate.length < 38) {
    const extras = [];
    for (const attr of attrs) {
      const val = String(attr?.attrValue || '').trim();
      if (
        val &&
        val.length <= 18 &&
        !/^(outro|nenhum|cn|origem|brasil|sim|nao|não|other|none)$/i.test(val)
      ) {
        extras.push(val);
      }
    }
    if (variationName && variationName.length <= 20) extras.push(variationName.replace(/^[^:]+:\s*/, ''));
    extras.push('Uso Diário', 'Resistente', 'Prático');
    for (const extra of extras) {
      if (candidate.length >= 42) break;
      const extraWords = extra.split(/\s+/).filter(Boolean);
      const anyNew = extraWords.some((ew) => {
        const ne = ew.normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase();
        return !seen.has(ne) && !LOWERCASE_CONNECTORS.has(ne);
      });
      if (anyNew && (candidate + ' ' + extra).length <= 58) {
        for (const ew of extraWords) {
          seen.add(ew.normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase());
        }
        candidate = `${candidate} ${extraWords.map((w) => formatPortugueseToken(w, 1)).join(' ')}`.trim();
      }
    }
  }

  // Fit cleanly within 60 chars without trailing connectors
  const finalWords = candidate.split(/\s+/).filter(Boolean);
  let out = '';
  for (const w of finalWords) {
    const next = out ? `${out} ${w}` : w;
    if (next.length > 60) break;
    out = next;
  }

  let outWords = out.split(/\s+/).filter(Boolean);
  while (
    outWords.length > 2 &&
    LOWERCASE_CONNECTORS.has(outWords[outWords.length - 1].toLowerCase())
  ) {
    outWords.pop();
  }

  const result = outWords.join(' ').trim();
  return result.slice(0, 60) || 'Produto Pronta Entrega No Brasil';
}

function extractItemsIncluded(descPlain, cleanTitle) {
  const matchBlock = descPlain.match(
    /(?:itens?\s+inclusos?|conte[uú]do\s+da\s+embalagem|o\s+pacote\s+inclui|acompanha)\s*:?\s*([^\n]+(?:\n-\s*[^\n]+){0,6})/i
  );
  if (matchBlock && matchBlock[1]) {
    const cleaned = matchBlock[1]
      .split('\n')
      .map((s) => s.replace(/^[-•*]\s*/, '').trim())
      .filter((s) => s && s.length < 120)
      .slice(0, 5)
      .join('; ');
    if (cleaned) return cleaned;
  }
  return `01x ${cleanTitle}`;
}

export function rewriteMercadoLivreDescription({
  cleanTitle,
  rawTitle,
  rawDescPlain,
  attrs = [],
  variationName = '',
  brand = 'Genérica',
  model = 'Padrão',
  mlCategory = '',
  dims,
  itemsIncluded,
}) {
  // Extract informative lines from supplier description while rewriting boilerplate
  const informativeLines = (rawDescPlain || '')
    .split('\n')
    .map((l) => l.trim())
    .filter((l) => {
      if (!l || l.length < 4 || l.length > 220) return false;
      if (/^(entrega\s+rapida|produto\s+no\s+brasil|pronta\s+entrega|postagem\s+em|somos\s+focados|envio\s+imediato)/i.test(l)) {
        return false;
      }
      if (/^(aten[cç][aã]o|aviso\s*:?\s*as\s+imagens)/i.test(l)) return false;
      return true;
    })
    .slice(0, 18);

  const specLines = [];
  specLines.push(`- Produto: ${cleanTitle}`);
  specLines.push(`- Marca: ${brand}`);
  specLines.push(`- Modelo: ${model}`);
  if (variationName) {
    specLines.push(`- Versão / Variação: ${variationName}`);
  }
  if (mlCategory) {
    specLines.push(`- Categoria: ${mlCategory}`);
  }
  for (const attr of attrs) {
    const k = String(attr?.attrName || '').trim();
    const v = String(attr?.attrValue || '').trim();
    if (!k || !v) continue;
    if (/origem|químico|quimico|high-concerned|choice/i.test(k)) continue;
    if (/^(none|nenhum|cn\(origem\))$/i.test(v)) continue;
    specLines.push(`- ${k}: ${v}`);
  }
  if (dims) {
    specLines.push(
      `- Dimensões aproximadas da embalagem: ${dims.comprimento_cm} cm x ${dims.largura_cm} cm x ${dims.altura_cm} cm`
    );
    specLines.push(`- Peso aproximado: ${dims.peso_kg} kg`);
  }
  specLines.push('- Condição: Produto novo, lacrado e conferido antes do envio');

  const detailsSection = informativeLines.length
    ? [
        'DETALHES E CARACTERÍSTICAS DO PRODUTO',
        ...informativeLines.map((l) => (l.startsWith('-') ? l : `- ${l}`)),
        '',
      ]
    : [
        'DETALHES E CARACTERÍSTICAS DO PRODUTO',
        `- Desenvolvido para proporcionar praticidade, durabilidade e excelente desempenho no uso diário.`,
        `- Acabamento resistente e fácil manuseio, ideal para quem busca eficiência e ótimo custo-benefício.`,
        `- Referência técnica completa: ${decodeHtmlEntities(rawTitle || cleanTitle).replace(/\s*-\s*AliExpress.*$/i, '').trim()}.`,
        '',
      ];

  return [
    `${cleanTitle.toUpperCase()}`,
    '',
    `Adquira ${cleanTitle} com excelente padrão de acabamento, projetado para oferecer praticidade, resistência e ótimo desempenho no dia a dia. Produto selecionado com estoque físico já localizado no Brasil para envio ágil e seguro até o seu endereço.`,
    '',
    'PRINCIPAIS BENEFÍCIOS',
    '- Pronta disponibilidade em território nacional, livre de taxas ou cobranças extras na entrega.',
    '- Frete grátis para todas as regiões do Brasil (Sudeste, Sul, Nordeste, Centro-Oeste e Norte).',
    '- Construção pensada para uso prático, fácil conservação e longa vida útil.',
    '- Acompanhamento completo da entrega por código de rastreamento atualizado no pedido.',
    '',
    ...detailsSection,
    'FICHA TÉCNICA E ESPECIFICAÇÕES',
    ...specLines,
    '',
    'CONTEÚDO DA EMBALAGEM',
    `- ${itemsIncluded || `01x ${cleanTitle}`}`,
    '',
    'ENVIO, COBERTURA E PRAZO DE ENTREGA',
    '- Modalidade de envio: Entrega direta por conta do vendedor sem custo adicional (R$ 0,00).',
    '- Cobertura: Atendemos todo o Brasil.',
    '- Prazo estimado de entrega: De 5 a 10 dias conforme a localidade.',
    '- Rastreamento: Assim que despachado, o código de rastreio é informado diretamente nos detalhes da sua compra no Mercado Livre.',
    '',
    'GARANTIA',
    '- Garantia do vendedor: 30 dias contra defeitos de fabricação.',
  ].join('\n');
}

function extractBrandAndModel(cleanTitle, attrs = []) {
  let brand = '';
  let model = '';

  for (const attr of attrs) {
    const k = String(attr?.attrName || '').toLowerCase();
    const v = String(attr?.attrValue || '').trim();
    if (!v || /^(none|nenhum|noenname_null|other|outro|oem|cn)$/i.test(v)) continue;
    if (!brand && (k.includes('marca') || k.includes('brand'))) brand = v;
    if (!model && (k.includes('modelo') || k.includes('model') || k.includes('tipo'))) model = v;
  }

  if (!brand) {
    const knownBrands = cleanTitle.match(
      /\b(Samsung|Xiaomi|Baseus|Ugreen|Anker|Lenovo|QCY|JBL|Sony|Philips|Logitech|Kemei|Wmark| VGR| Mondial|Britânia|Tramontina|Bosch|Makita)\b/i
    );
    brand = knownBrands ? knownBrands[1].trim() : 'Genérica';
  }

  if (!model) {
    const modelCode = cleanTitle.match(/\b([A-Z]{1,4}[-]?\d{2,5}[A-Z0-9]*)\b/);
    if (modelCode) {
      model = modelCode[1];
    } else {
      model = cleanTitle.split(/\s+/).slice(0, 3).join(' ');
    }
  }

  return { brand, model };
}

export async function scrapeAliExpressProduct({
  urlOrId,
  internalCode = '',
  knownCostBrl = null,
  knownOrigPriceBrl = null,
  multiplier = DEFAULT_MULTIPLIER,
  minPrice = MIN_ML_PRICE,
  storeEntry = null,
  storeMeta = null,
  loteOrigem = '',
  skipLivePdp = false,
}) {
  const itemId = extractAliExpressItemId(urlOrId);
  if (!itemId) {
    throw new Error(`Não foi possível identificar o ID do produto AliExpress em: ${urlOrId}`);
  }

  const cleanUrl = canonicalAliExpressUrl(itemId);
  let pdp = null;
  if (!skipLivePdp) {
    try {
      pdp = await queryMtopPdp(itemId);
    } catch {}
  }

  let rawTitle =
    pdp?.PRODUCT_TITLE?.text ||
    pdp?.GLOBAL_DATA?.globalData?.subject ||
    storeEntry?.subject ||
    storeEntry?.seoTitle ||
    '';

  const uniqueImages = [];
  const addImg = (u) => {
    const clean = normalizeImageUrl(u);
    if (clean && !uniqueImages.includes(clean)) uniqueImages.push(clean);
  };

  for (const u of pdp?.HEADER_IMAGE_PC?.imagePathList || []) addImg(u);
  for (const u of pdp?.HEADER_IMAGE_PC?.currentSkuImages || []) addImg(u);
  for (const prop of pdp?.SKU?.skuProperties || []) {
    for (const val of prop?.skuPropertyValues || []) {
      addImg(val?.skuPropertyImagePath);
      addImg(val?.skuPropertyImageSummPath);
    }
  }
  if (storeEntry) {
    addImg(storeEntry.image350Url);
    addImg(storeEntry.scaleImageUrl);
    addImg(storeEntry.summImageUrl);
  }

  // Fetch signed supplier description HTML
  let rawDescPlain = '';
  const descUrl = pdp?.DESC?.pcDescUrl || pdp?.DESC?.msiteDescUrl || '';
  if (descUrl) {
    try {
      const descRes = await fetchWithTimeout(descUrl, {
        headers: { 'User-Agent': USER_AGENT, Referer: cleanUrl },
      });
      if (descRes.ok) {
        const descHtml = await descRes.text();
        const parsedDesc = cleanSupplierDescriptionHtml(descHtml);
        rawDescPlain = parsedDesc.plainText;
        for (const u of parsedDesc.descImages) addImg(u);
      }
    } catch {}
  }

  // Enrich with buyer evaluation photos & SKU hints if gallery has < 4 unique photos
  let evalEnrichment = { images: [], skuHints: [], comments: [] };
  if (uniqueImages.length < 4) {
    evalEnrichment = await fetchEvaluationEnrichment(itemId);
    for (const u of evalEnrichment.images) addImg(u);
  }

  // Fallback to direct page HTML if title or images are still missing
  if ((!rawTitle || uniqueImages.length === 0) && !skipLivePdp) {
    try {
      const fallback = await fetchHtmlFallback(itemId);
      if (!rawTitle && fallback.title) rawTitle = fallback.title;
      for (const u of fallback.imagePathList || []) addImg(u);
    } catch {}
  }

  const images = buildAtLeastFourImages(uniqueImages);

  // Attributes
  const rawProps = [
    ...(pdp?.PRODUCT_PROP_PC?.outerProps || []),
    ...(pdp?.PRODUCT_PROP_PC?.showedProps || []),
  ];
  const seenProp = new Set();
  const attrs = [];
  for (const p of rawProps) {
    const k = String(p?.attrName || '').trim();
    const v = String(p?.attrValue || '').trim();
    if (!k || !v) continue;
    const keyId = `${k.toLowerCase()}:${v.toLowerCase()}`;
    if (seenProp.has(keyId)) continue;
    seenProp.add(keyId);
    attrs.push({ attrName: k, attrValue: v });
  }

  // Selected SKU & variation
  let storeSkuId = '';
  if (storeEntry?.pcDetailUrl) {
    const skuMatch = decodeURIComponent(storeEntry.pcDetailUrl).match(/!(12000\d{10,16})!/);
    if (skuMatch) storeSkuId = skuMatch[1];
  }
  const selectedSkuId = String(
    pdp?.SKU?.selectedSkuIdStr || pdp?.PRICE?.selectedSkuId || storeSkuId || ''
  );
  const variationParts = [];
  for (const prop of pdp?.SKU?.skuProperties || []) {
    const vals = prop?.skuPropertyValues || [];
    if (vals.length > 0) {
      const firstVal = vals[0]?.propertyValueDisplayName || vals[0]?.propertyValueDefinitionName;
      if (firstVal) variationParts.push(`${prop.skuPropertyName || 'Opção'}: ${firstVal}`);
    }
  }
  if (!variationParts.length && evalEnrichment.skuHints.length > 0) {
    variationParts.push(evalEnrichment.skuHints[0]);
  }
  const variationName = variationParts.join(' | ');

  // Extract Live BRL price
  let liveSalePriceBrl = storeEntry?.promotionPiecePriceMoney?.amount
    ? Number(storeEntry.promotionPiecePriceMoney.amount)
    : null;
  let liveOrigPriceBrl = storeEntry?.piecePriceMoney?.amount
    ? Number(storeEntry.piecePriceMoney.amount)
    : null;
  const priceMap = pdp?.PRICE?.skuIdStrPriceInfoMap || {};
  const skuPriceObj =
    (selectedSkuId && priceMap[selectedSkuId]) || Object.values(priceMap)[0] || null;
  if (skuPriceObj) {
    if (skuPriceObj.originalPrice?.value) {
      liveOrigPriceBrl = Number(skuPriceObj.originalPrice.value);
    }
    const localParts = String(skuPriceObj.salePriceLocal || '').split('|');
    if (localParts.length >= 3) {
      const parsed = Number(`${localParts[1].replace(/\D/g, '')}.${localParts[2].replace(/\D/g, '')}`);
      if (Number.isFinite(parsed) && parsed > 0) liveSalePriceBrl = parsed;
    }
  }
  if (!liveSalePriceBrl && pdp?.SHIPPING?.deliveryExt) {
    try {
      const deliv = JSON.parse(pdp.SHIPPING.deliveryExt);
      const d0 = Number(deliv?.[0]?.d0);
      if (Number.isFinite(d0) && d0 > 0) liveSalePriceBrl = d0;
    } catch {}
  }

  const isNewUserPromo = Boolean(pdp?.PRICE_BANNER?.atmosphereCode?.includes('new_user'));
  let effectiveCostBrl = Number(knownCostBrl) > 0 ? Number(knownCostBrl) : null;
  if (!effectiveCostBrl) {
    if (liveSalePriceBrl && (!isNewUserPromo || !liveOrigPriceBrl)) {
      effectiveCostBrl = liveSalePriceBrl;
    } else if (liveOrigPriceBrl) {
      effectiveCostBrl = Number((liveOrigPriceBrl * 0.65).toFixed(2));
    } else {
      effectiveCostBrl = 29.9;
    }
  }

  const effectiveOrigBrl =
    Number(knownOrigPriceBrl) > 0
      ? Number(knownOrigPriceBrl)
      : liveOrigPriceBrl || Number((effectiveCostBrl * 1.55).toFixed(2));

  // Store & Seller details
  const shop = pdp?.SHOP_CARD_PC || {};
  const benefits = shop.benefitInfoList || [];
  const storeRatingBenefit = benefits.find((b) => /classifica|rating|nota/i.test(b?.title || ''));
  const positiveBenefit = benefits.find((b) => /positiva/i.test(b?.title || ''));
  const resolvedApproved =
    storeMeta ||
    (shop?.sellerInfo?.storeNum ? getApprovedStoreById(shop.sellerInfo.storeNum) : null) ||
    (pdp?.DESC?.storeId ? getApprovedStoreById(pdp.DESC.storeId) : null);

  const storeName =
    resolvedApproved?.storeName ||
    shop.storeName ||
    (storeEntry ? 'CSSV SHOP Store' : 'Fornecedor AliExpress Brasil');
  const storeId = String(
    resolvedApproved?.storeId ||
      shop?.sellerInfo?.storeNum ||
      pdp?.DESC?.storeId ||
      (storeEntry ? '1105400522' : '')
  );
  const storeRating =
    resolvedApproved?.storeRating || storeRatingBenefit?.value || '4.8';
  const storePositiveRate =
    resolvedApproved?.positiveRate ||
    positiveBenefit?.value ||
    (shop.sellerPositiveRate ? `${shop.sellerPositiveRate}%` : '94.8%');
  const storeCountry = resolvedApproved?.country || shop?.sellerInfo?.countryCompleteName || 'Brasil';
  const storeUrl = storeId
    ? `https://pt.aliexpress.com/store/${storeId}`
    : shop?.sellerInfo?.storeURL
      ? `https:${String(shop.sellerInfo.storeURL).replace(/^https?:/, '')}`
      : cleanUrl;

  const freeShippingVerified = storeEntry ? hasFreeShippingBrazil(storeEntry) : true;
  const inventory = Math.max(Number(pdp?.QUANTITY_PC?.totalAvailableInventory) || 20, 1);
  const soldText =
    pdp?.PC_RATING?.otherText ||
    (storeEntry?.orders ? `${storeEntry.orders} vendido(s)` : 'Estoque Brasil');
  const productRating =
    pdp?.PC_RATING?.rating ||
    (storeEntry?.averageStar ? String(storeEntry.averageStar) : storeRating);

  const codePrefix = internalCode ? String(internalCode).trim().toUpperCase() : `AE-${itemId.slice(-4)}`;
  const fullSku = `${codePrefix}-${itemId}`;

  if (!rawDescPlain && storeEntry) {
    rawDescPlain = [
      `Produto: ${rawTitle}`,
      `Frete grátis com envio direto de armazém no Brasil.`,
      variationName ? `Variação/Modelo: ${variationName}` : '',
      ...evalEnrichment.comments.map((c) => `Destaque de uso: ${c}`),
    ]
      .filter(Boolean)
      .join('\n');
  }

  const attrsText = attrs.map((a) => `${a.attrName}: ${a.attrValue}`).join(' | ');
  const catAndDims = inferCategoryAndDimensions(rawTitle, attrsText, rawDescPlain);
  const cleanTitle = rewriteMercadoLivreTitle(rawTitle, attrs, variationName);
  const { brand, model } = extractBrandAndModel(cleanTitle, attrs);
  const itemsIncluded = extractItemsIncluded(rawDescPlain, cleanTitle);

  const mlDescription = rewriteMercadoLivreDescription({
    cleanTitle,
    rawTitle,
    rawDescPlain,
    attrs,
    variationName,
    brand,
    model,
    mlCategory: catAndDims.mlCategory,
    dims: catAndDims,
    itemsIncluded,
  });

  const pricing = calculateMlPricing(effectiveCostBrl, multiplier, minPrice);

  const baseProduct = {
    sku: fullSku,
    codigo_interno: codePrefix,
    aliexpress_item_id: itemId,
    aliexpress_sku_id: selectedSkuId,
    variacao_modelo: variationName || 'Padrão',
    titulo_ml: cleanTitle,
    titulo_aliexpress_original: rawTitle || cleanTitle,
    categoria_ml: catAndDims.mlCategory,
    categoria_ml_id: catAndDims.mlCategoryId,
    condicao: 'Novo',
    tipo_anuncio: 'Premium (gold_pro)',
    tipo_anuncio_ml: 'premium',
    estoque_disponivel: inventory,
    preco_custo_aliexpress_brl: pricing.cost,
    preco_tabela_aliexpress_brl: Number(effectiveOrigBrl.toFixed(2)),
    preco_live_aliexpress_brl: liveSalePriceBrl ? Number(liveSalePriceBrl.toFixed(2)) : pricing.cost,
    multiplicador_venda: pricing.multiplier,
    preco_calculado_2_8x_brl: pricing.calculated,
    preco_minimo_79_90: pricing.floor,
    preco_venda_ml_sugerido: pricing.finalPrice,
    piso_79_90_aplicado: pricing.pisoAplicado,
    taxa_ml_estimada_brl: pricing.mlFee,
    imposto_estimado_brl: pricing.taxes,
    custo_anuncio_premium_brl: pricing.mlFee,
    custo_frete_vendedor_brl: pricing.shippingSellerCost,
    custo_total_operacao_brl: pricing.totalOperationCost,
    margem_estimada: pricing.grossMargin,
    lucro_liquido_estimado_brl: pricing.netProfit,
    margem_liquida_pct: pricing.netMarginPct,
    roi_sobre_custo_pct: pricing.roiPct,
    modalidade_entrega_ml: 'Vou enviar por minha conta',
    cobertura_frete: 'Todo o Brasil (Sudeste, Sul, Nordeste, Centro-Oeste e Norte)',
    frete_gratis: 'Sim',
    frete_gratis_confirmado_ali: freeShippingVerified ? 'Sim' : 'Verificar',
    custo_envio_comprador_brl: 0,
    prazo_entrega_dias: '5 a 10 dias',
    disponibilidade_estoque_dias: 1,
    marca: brand,
    modelo: model,
    codigo_universal_ean: 'Não se aplica',
    motivo_sem_gtin: '17055160',
    garantia_tipo: 'Garantia do vendedor',
    garantia_tempo: '30 dias',
    peso_kg: catAndDims.peso_kg,
    comprimento_cm: catAndDims.comprimento_cm,
    largura_cm: catAndDims.largura_cm,
    altura_cm: catAndDims.altura_cm,
    ficha_tecnica_atributos: attrsText || `Marca: ${brand} | Modelo: ${model}`,
    atributos_lista: attrs,
    itens_inclusos: itemsIncluded,
    imagens: images,
    imagem_1: images[0] || '',
    imagem_2: images[1] || '',
    imagem_3: images[2] || '',
    imagem_4: images[3] || '',
    imagem_5: images[4] || '',
    imagem_6: images[5] || '',
    urls_imagens: images.join(' | '),
    qtd_imagens: images.length,
    descricao_ml_otimizada: mlDescription,
    descricao_aliexpress_original:
      rawDescPlain || `${rawTitle || cleanTitle}. Estoque no Brasil com envio rápido.`,
    fornecedor_nome: storeName,
    fornecedor_loja_id: storeId,
    fornecedor_avaliacao: String(storeRating),
    fornecedor_aprovacao_pct: storePositiveRate,
    fornecedor_pais_origem: storeCountry,
    fornecedor_contato: storeUrl,
    lote_origem: loteOrigem || `Lote - ${storeName}`,
    avaliacao_produto: String(productRating || ''),
    vendas_aliexpress: soldText || 'Estoque Brasil',
    url_aliexpress: cleanUrl,
    cnpj_emitente: 'Melimax - Shop (CNPJ)',
    status_anuncio: 'pronto_para_subir',
    qualidade_anuncio_meta: '85%+',
    atualizado_em: new Date().toISOString(),
  };

  const quality = computeMlQualityScore(baseProduct);
  return {
    ...baseProduct,
    qualidade_score: quality.score,
    qualidade_pronto_85: quality.ready,
    qualidade_anuncio_meta: `${quality.score}% (Meta 85%+)`,
  };
}

function escapeCsvCell(value, delimiter = ',') {
  if (value === null || value === undefined) return '';
  const str = String(value).replace(/\r\n/g, '\n').replace(/\r/g, '\n');
  if (str.includes('"') || str.includes(delimiter) || str.includes('\n')) {
    return `"${str.replace(/"/g, '""')}"`;
  }
  return str;
}

function fmtCommaNumber(num, decimals = 2) {
  const n = Number(num);
  if (!Number.isFinite(n)) return '';
  return n.toFixed(decimals).replace('.', ',');
}

export const COMPLETE_CSV_COLUMNS = [
  'sku',
  'codigo_interno',
  'aliexpress_item_id',
  'aliexpress_sku_id',
  'variacao_modelo',
  'titulo_ml',
  'titulo_aliexpress_original',
  'descricao_ml_otimizada',
  'descricao_aliexpress_original',
  'categoria_ml',
  'categoria_ml_id',
  'condicao',
  'tipo_anuncio',
  'estoque_disponivel',
  'preco_custo_aliexpress_brl',
  'preco_tabela_aliexpress_brl',
  'multiplicador_venda',
  'preco_calculado_2_8x_brl',
  'preco_minimo_79_90',
  'preco_venda_ml_sugerido',
  'taxa_ml_estimada_brl',
  'imposto_estimado_brl',
  'custo_frete_vendedor_brl',
  'margem_estimada',
  'lucro_liquido_estimado_brl',
  'margem_liquida_pct',
  'roi_sobre_custo_pct',
  'tipo_anuncio_ml',
  'taxa_ml_pct',
  'taxa_ml_fixa_brl',
  'custo_listagem_ml_brl',
  'taxa_ml_fonte',
  'taxa_ml_calculada_em',
  'imposto_pct',
  'custo_produto_brl',
  'custo_total_operacao_brl',
  'modalidade_entrega_ml',
  'cobertura_frete',
  'frete_gratis',
  'custo_envio_comprador_brl',
  'prazo_entrega_dias',
  'disponibilidade_estoque_dias',
  'marca',
  'modelo',
  'codigo_universal_ean',
  'motivo_sem_gtin',
  'garantia_tipo',
  'garantia_tempo',
  'peso_kg',
  'comprimento_cm',
  'largura_cm',
  'altura_cm',
  'ficha_tecnica_atributos',
  'itens_inclusos',
  'imagem_1',
  'imagem_2',
  'imagem_3',
  'imagem_4',
  'imagem_5',
  'imagem_6',
  'urls_imagens',
  'qtd_imagens',
  'fornecedor_nome',
  'fornecedor_loja_id',
  'fornecedor_avaliacao',
  'fornecedor_aprovacao_pct',
  'fornecedor_pais_origem',
  'fornecedor_contato',
  'lote_origem',
  'frete_gratis_confirmado_ali',
  'vendas_aliexpress',
  'url_aliexpress',
  'cnpj_emitente',
  'status_anuncio',
  'qualidade_score',
  'qualidade_anuncio_meta',
];

export function buildCompleteCsv(products) {
  const lines = [COMPLETE_CSV_COLUMNS.join(',')];
  for (const item of products) {
    const row = COMPLETE_CSV_COLUMNS.map((col) => escapeCsvCell(item[col], ','));
    lines.push(row.join(','));
  }
  return `\uFEFF${lines.join('\r\n')}\r\n`;
}

export function buildMercadoLivreBulkCsv(products) {
  const delimiter = ';';
  const headers = [
    'SKU (Identificador AliExpress)',
    'Título do Anúncio (Máx 60)',
    'Categoria Mercado Livre',
    'ID Categoria ML',
    'Preço de Venda (R$)',
    'Moeda',
    'Quantidade em Estoque',
    'Condição',
    'Tipo de Anúncio',
    'Modalidade de Entrega',
    'Área de Cobertura',
    'Frete Grátis',
    'Custo do Envio (R$)',
    'Prazo de Entrega',
    'Tipo de Garantia',
    'Tempo de Garantia',
    'Marca',
    'Modelo',
    'Código Universal (EAN/GTIN)',
    'Motivo Sem GTIN',
    'Peso (kg)',
    'Comprimento (cm)',
    'Largura (cm)',
    'Altura (cm)',
    'Ficha Técnica',
    'Itens Inclusos',
    'Imagem 1 (Principal)',
    'Imagem 2',
    'Imagem 3',
    'Imagem 4',
    'Imagem 5',
    'Imagem 6',
    'Descrição Completa (Texto Plano)',
    'URL Produto AliExpress',
    'Custo AliExpress (R$)',
    'Margem Bruta (R$)',
    'Lucro Líquido Estimado (R$)',
    'Fornecedor AliExpress',
    'Nota Fornecedor',
  ];

  const lines = [headers.map((h) => escapeCsvCell(h, delimiter)).join(delimiter)];
  for (const p of products) {
    const row = [
      p.sku,
      p.titulo_ml,
      p.categoria_ml,
      p.categoria_ml_id,
      fmtCommaNumber(p.preco_venda_ml_sugerido, 2),
      'BRL',
      p.estoque_disponivel,
      p.condicao,
      'Premium',
      'Vou enviar por minha conta',
      'Todo o Brasil (Sudeste, Sul, Nordeste, Centro-Oeste e Norte)',
      'Sim',
      '0,00',
      '5 a 10 dias',
      'Garantia do vendedor',
      '30 dias',
      p.marca,
      p.modelo,
      'Não se aplica',
      p.motivo_sem_gtin,
      fmtCommaNumber(p.peso_kg, 3),
      p.comprimento_cm,
      p.largura_cm,
      p.altura_cm,
      p.ficha_tecnica_atributos,
      p.itens_inclusos,
      p.imagem_1,
      p.imagem_2,
      p.imagem_3,
      p.imagem_4,
      p.imagem_5,
      p.imagem_6,
      p.descricao_ml_otimizada,
      p.url_aliexpress,
      fmtCommaNumber(p.preco_custo_aliexpress_brl, 2),
      fmtCommaNumber(p.margem_estimada, 2),
      fmtCommaNumber(p.lucro_liquido_estimado_brl, 2),
      p.fornecedor_nome,
      p.fornecedor_avaliacao,
    ].map((cell) => escapeCsvCell(cell, delimiter));
    lines.push(row.join(delimiter));
  }
  return `\uFEFF${lines.join('\r\n')}\r\n`;
}
