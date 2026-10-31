import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import dotenv from 'dotenv';
import pg from 'pg';

dotenv.config({ path: '/home/netuno/ml-dropshipping/backend/.env.local', override: true });

const args = {};
for (const arg of process.argv.slice(2)) {
  const match = arg.match(/^--([^=]+)(?:=(.*))?$/);
  if (match) args[match[1]] = match[2] === undefined ? true : match[2];
}
const APPLY = args.apply === true || args.apply === 'true';
const LIMIT = Number(args.limit || 0);
const OFFSET = Math.max(Number(args.offset || 0), 0);
const DELAY_MS = Math.max(Number(args.delay) || 1300, 300);
const ONLY = new Set(String(args.only || '').split(',').map((v) => v.trim().toUpperCase()).filter(Boolean));
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, '..', '..');
const OUT_DIR = path.join(REPO_ROOT, 'dados');
const STAMP = new Date().toISOString().replace(/[:.]/g, '-');

const pool = new pg.Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false },
  max: 2,
  connectionTimeoutMillis: 15000,
});

const { rows: accountRows } = await pool.query(
  'SELECT user_id, access_token, refresh_token, expires_at FROM ml_accounts ORDER BY updated_at DESC LIMIT 1'
);
let account = accountRows[0];
if (!account?.access_token) throw new Error('Conta ML nao conectada no banco.');

const { rows: catalogRows } = await pool.query("SELECT value FROM app_state WHERE key='aliexpress_catalog'");
const rawCatalog = catalogRows[0]?.value;
const catalog = typeof rawCatalog === 'string' ? JSON.parse(rawCatalog) : rawCatalog;
const { rows: listingRows } = await pool.query(
  'SELECT ml_item_id, title, status, source_item_id, thumbnail FROM listings ORDER BY created_at ASC'
);
await pool.end();

const catalogByMl = new Map((catalog || []).filter((p) => p.ml_item_id).map((p) => [p.ml_item_id, p]));
const catalogByAli = new Map((catalog || []).filter((p) => p.aliexpress_item_id).map((p) => [String(p.aliexpress_item_id), p]));

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
let lastAt = 0;
async function throttle() {
  const wait = Math.max(0, lastAt + DELAY_MS - Date.now());
  if (wait) await sleep(wait);
  lastAt = Date.now();
}

async function refreshToken() {
  if (!account?.refresh_token || !process.env.ML_APP_ID || !process.env.ML_CLIENT_SECRET) return false;
  const body = new URLSearchParams({
    grant_type: 'refresh_token',
    client_id: process.env.ML_APP_ID,
    client_secret: process.env.ML_CLIENT_SECRET,
    refresh_token: account.refresh_token,
  });
  const res = await fetch('https://api.mercadolibre.com/oauth/token', { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body });
  const data = await res.json().catch(() => ({}));
  if (!res.ok || !data.access_token) return false;
  account = { ...account, access_token: data.access_token, refresh_token: data.refresh_token || account.refresh_token };
  const p = new pg.Pool({ connectionString: process.env.DATABASE_URL, ssl: { rejectUnauthorized: false }, max: 1 });
  await p.query('UPDATE ml_accounts SET access_token=$1, refresh_token=$2, updated_at=NOW() WHERE user_id=$3', [account.access_token, account.refresh_token, account.user_id]);
  await p.end();
  return true;
}

async function api(pathname, options = {}, attempt = 1) {
  await throttle();
  const res = await fetch(`https://api.mercadolibre.com${pathname}`, {
    ...options,
    signal: AbortSignal.timeout(30000),
    headers: {
      Authorization: `Bearer ${account.access_token}`,
      ...(options.body ? { 'Content-Type': 'application/json' } : {}),
      ...(options.headers || {}),
    },
  });
  const text = await res.text();
  let data = null;
  if (text) { try { data = JSON.parse(text); } catch { data = text; } }
  if (res.status === 401 && attempt === 1 && (await refreshToken())) return api(pathname, options, 2);
  if (!res.ok) {
    if ((res.status === 429 || res.status >= 500) && attempt <= 6) {
      await sleep(Math.min(30000, 3000 * attempt));
      return api(pathname, options, attempt + 1);
    }
    const err = new Error(data?.message || data?.error || `ML ${res.status}`);
    err.status = res.status;
    err.data = data;
    throw err;
  }
  return data;
}

function detectionsOf(payload) {
  const list = Array.isArray(payload?.diagnostics)
    ? payload.diagnostics.flatMap((d) => d.detections || [])
    : [];
  return [...new Set(list.map((d) => String(d?.name || d?.id || '').toLowerCase()).filter(Boolean))];
}

const BLOCKERS = new Set(['text_logo', 'watermark', 'logo', 'text']);
const categoryAttrCache = new Map();
async function categoryRequirements(categoryId) {
  if (categoryAttrCache.has(categoryId)) return categoryAttrCache.get(categoryId);
  const attrs = await api(`/categories/${encodeURIComponent(categoryId)}/attributes`);
  const required = (Array.isArray(attrs) ? attrs : [])
    .filter((a) => a?.tags?.required || a?.tags?.catalog_required || a?.tags?.new_required)
    .map((a) => a.id);
  categoryAttrCache.set(categoryId, required);
  return required;
}

const targets = listingRows.filter((row) => {
  if (!ONLY.size) return true;
  const p = catalogByMl.get(row.ml_item_id) || catalogByAli.get(String(row.source_item_id));
  return ONLY.has(String(row.ml_item_id).toUpperCase()) || ONLY.has(String(p?.sku || '').toUpperCase());
}).slice(OFFSET, LIMIT > 0 ? OFFSET + LIMIT : undefined);

console.log(`Auditoria read-only | anuncios: ${targets.length} | offset: ${OFFSET} | delay: ${DELAY_MS}ms`);

const report = [];
for (const row of targets) {
  const product = catalogByMl.get(row.ml_item_id) || catalogByAli.get(String(row.source_item_id)) || null;
  const entry = {
    ml_item_id: row.ml_item_id,
    sku: product?.sku || null,
    db_status: row.status,
    catalog_title: product?.titulo_ml || null,
    issues: [],
    checks: {},
  };
  try {
    const item = await api(`/items/${encodeURIComponent(row.ml_item_id)}`);
    entry.item = {
      title: item.title,
      status: item.status,
      sub_status: item.sub_status || [],
      category_id: item.category_id,
      listing_type_id: item.listing_type_id,
      price: item.price,
      currency_id: item.currency_id,
      condition: item.condition,
      available_quantity: item.available_quantity,
      sold_quantity: item.sold_quantity,
      domain_id: item.domain_id,
      catalog_listing: item.catalog_listing ?? null,
      catalog_product_id: item.catalog_product_id || null,
      tags: item.tags || [],
      pictures: (item.pictures || []).map((p) => ({ id: p.id, source: p.source || null })),
      shipping: {
        mode: item.shipping?.mode || null,
        logistic_type: item.shipping?.logistic_type || null,
        free_shipping: item.shipping?.free_shipping ?? null,
        local_pick_up: item.shipping?.local_pick_up ?? null,
        store_pick_up: item.shipping?.store_pick_up ?? null,
        tags: item.shipping?.tags || [],
      },
      attributes: (item.attributes || []).map((a) => ({ id: a.id, value_name: a.value_name, value_id: a.value_id })),
    };
    entry.checks.status_paused = item.status === 'paused';
    const blockingSubStatus = (item.sub_status || []).filter((s) => s !== 'paused_by_seller');
    entry.checks.sub_status_empty = blockingSubStatus.length === 0;
    entry.checks.premium = item.listing_type_id === 'gold_pro';
    entry.checks.title_length = typeof item.title === 'string' && item.title.length <= 60;
    entry.checks.pictures_4plus = (item.pictures || []).length >= 4;
    entry.checks.price_floor = Number(item.price) >= 79.9;
    entry.checks.free_shipping = item.shipping?.free_shipping === true;
    entry.checks.sem_etiqueta = item.shipping?.mode === 'not_specified';
    entry.checks.sem_retirada = item.shipping?.local_pick_up === false && item.shipping?.store_pick_up === false;
    entry.checks.estoque_1_a_3 = Number(item.available_quantity) >= 1 && Number(item.available_quantity) <= 3;
    entry.checks.title_matches_catalog = !product?.titulo_ml || item.title === product.titulo_ml;
    entry.checks.category_matches_catalog = !product?.categoria_ml_id || item.category_id === product.categoria_ml_id;

    if (!entry.checks.status_paused) entry.issues.push(`status=${item.status}`);
    if (!entry.checks.sub_status_empty) entry.issues.push(`sub_status=${blockingSubStatus.join(',')}`);
    if (!entry.checks.premium) entry.issues.push(`listing_type=${item.listing_type_id}`);
    if (!entry.checks.title_length) entry.issues.push(`titulo_${item.title.length}_caracteres`);
    if (!entry.checks.pictures_4plus) entry.issues.push(`fotos_${(item.pictures || []).length}`);
    if (!entry.checks.price_floor) entry.issues.push(`preco_${item.price}`);
    if (!entry.checks.free_shipping) entry.issues.push('frete_nao_gratis');
    if (!entry.checks.sem_etiqueta) entry.issues.push(`frete_modo_${item.shipping?.mode || 'ausente'}`);
    if (!entry.checks.sem_retirada) entry.issues.push('retirada_local_ou_loja_ativa');
    if (!entry.checks.estoque_1_a_3) entry.issues.push(`estoque_${item.available_quantity}`);
    if (!entry.checks.title_matches_catalog) entry.issues.push('titulo_diverge_catalogo');
    if (!entry.checks.category_matches_catalog) entry.issues.push(`categoria_${item.category_id}_vs_catalogo_${product?.categoria_ml_id}`);

    try {
      const desc = await api(`/items/${encodeURIComponent(row.ml_item_id)}/description`);
      const plain = String(desc?.plain_text || '').trim();
      entry.description_length = plain.length;
      entry.description_last_updated = desc?.last_updated || null;
      entry.checks.descricao_ok = plain.length >= 100;
      if (!entry.checks.descricao_ok) entry.issues.push(`descricao_${plain.length}_caracteres`);
    } catch (err) {
      entry.checks.descricao_ok = false;
      entry.issues.push(`descricao_erro_${err.status || 'api'}`);
    }

    const required = await categoryRequirements(item.category_id);
    const present = new Set((item.attributes || []).map((a) => a.id));
    const missing = required.filter((id) => !present.has(id));
    entry.checks.required_attributes = missing.length === 0;
    if (missing.length) entry.issues.push(`atributos_faltando_${missing.join('_')}`);

    const cover = item.pictures?.[0];
    if (cover?.id) {
      const diagnostic = await api('/moderations/pictures/diagnostic', {
        method: 'POST',
        body: JSON.stringify({
          element_id: item.id,
          picture_id: cover.id,
          context: { category_id: item.category_id, title: item.title, picture_type: 'thumbnail', language: 'pt' },
        }),
      });
      const detections = detectionsOf(diagnostic);
      entry.cover_detections = detections;
      const blocked = detections.filter((name) => BLOCKERS.has(name));
      entry.checks.cover_clean = blocked.length === 0;
      if (blocked.length) entry.issues.push(`capa_${blocked.join('_')}`);
    } else {
      entry.checks.cover_clean = false;
      entry.issues.push('sem_capa');
    }

    if (!entry.issues.length) entry.issues.push('OK');
    report.push(entry);
    console.log(`${entry.ml_item_id} | ${entry.item.status} | ${entry.issues.join(' ; ')}`);
  } catch (err) {
    entry.error = err.message;
    entry.error_status = err.status || null;
    report.push(entry);
    console.error(`${entry.ml_item_id} | ERRO ${err.status || ''}: ${err.message}`);
    if (err.status === 429) break;
  }
}

fs.mkdirSync(OUT_DIR, { recursive: true });
const reportPath = path.join(OUT_DIR, `auditoria_97_ml_${STAMP}.json`);
fs.writeFileSync(reportPath, JSON.stringify({ generated_at: new Date().toISOString(), mode: APPLY ? 'apply-nao-usado' : 'read-only', total: report.length, report }, null, 2));

const summary = report.reduce((acc, e) => {
  const key = e.error ? 'erro' : e.issues.includes('OK') ? 'OK' : 'com_pendencia';
  acc[key] = (acc[key] || 0) + 1;
  return acc;
}, {});
console.log('\nResumo:', summary);
console.log('Relatorio:', reportPath);
