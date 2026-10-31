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
const DELAY_MS = Math.max(Number(args.delay) || 1300, 300);
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, '..', '..');
const OUT_DIR = path.join(REPO_ROOT, 'dados');
const BACKUP_DIR = path.join(OUT_DIR, 'backups');
const STAMP = new Date().toISOString().replace(/[:.]/g, '-');
const BASE = 'https://api.mercadolibre.com';

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
const { rows: listingRows } = await pool.query(
  'SELECT id, ml_item_id, title, status FROM listings WHERE ml_item_id IS NOT NULL ORDER BY created_at ASC'
);

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
  const res = await fetch(`${BASE}/oauth/token`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body,
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok || !data.access_token) return false;
  account = { ...account, access_token: data.access_token, refresh_token: data.refresh_token || account.refresh_token };
  await pool.query('UPDATE ml_accounts SET access_token=$1, refresh_token=$2, updated_at=NOW() WHERE user_id=$3', [
    account.access_token,
    account.refresh_token,
    account.user_id,
  ]);
  return true;
}

async function api(pathname, options = {}, attempt = 1) {
  await throttle();
  const res = await fetch(`${BASE}${pathname}`, {
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

const targets = listingRows.slice(0, LIMIT > 0 ? LIMIT : undefined);
console.log(`${APPLY ? 'APPLY' : 'DRY-RUN'} | anuncios: ${targets.length} | delay: ${DELAY_MS}ms`);
fs.mkdirSync(BACKUP_DIR, { recursive: true });

const report = [];
const pausedOk = [];
for (const row of targets) {
  const entry = { id: row.id, ml_item_id: row.ml_item_id, db_status_before: row.status };
  try {
    const before = await api(`/items/${encodeURIComponent(row.ml_item_id)}`);
    entry.status_before = before.status;
    entry.sub_status_before = before.sub_status || [];
    fs.writeFileSync(path.join(BACKUP_DIR, `${row.ml_item_id}-pause-before.json`), JSON.stringify(before, null, 2));
    if (before.status !== 'paused') {
      if (!APPLY) {
        entry.action = 'would_pause';
      } else {
        const put = await api(`/items/${encodeURIComponent(row.ml_item_id)}`, {
          method: 'PUT',
          body: JSON.stringify({ status: 'paused' }),
        });
        entry.put_status = put?.status || null;
        const after = await api(`/items/${encodeURIComponent(row.ml_item_id)}`);
        entry.status_after = after.status;
        entry.sub_status_after = after.sub_status || [];
        entry.action = after.status === 'paused' ? 'paused' : 'pause_not_applied';
        if (after.status === 'paused') pausedOk.push(row.ml_item_id);
      }
    } else {
      entry.action = 'already_paused';
      pausedOk.push(row.ml_item_id);
    }
    report.push(entry);
    console.log(`${row.ml_item_id} | ${entry.status_before} -> ${entry.status_after || entry.action}`);
  } catch (err) {
    entry.error = err.message;
    entry.error_status = err.status || null;
    report.push(entry);
    console.error(`${row.ml_item_id} | ERRO ${err.status || ''}: ${err.message}`);
    if (err.status === 429) break;
  }
}

if (APPLY) {
  for (const id of pausedOk) {
    await pool.query("UPDATE listings SET status='paused' WHERE ml_item_id=$1", [id]);
    await pool.query("UPDATE listings SET payload = COALESCE(payload, '{}'::jsonb) || jsonb_build_object('status','paused') WHERE ml_item_id=$1", [id]);
  }
  const { rows: stateRows } = await pool.query("SELECT value FROM app_state WHERE key='aliexpress_catalog'");
  const raw = stateRows[0]?.value;
  const catalog = typeof raw === 'string' ? JSON.parse(raw) : raw;
  if (Array.isArray(catalog)) {
    const pausedSet = new Set(pausedOk);
    for (const p of catalog) {
      if (p?.ml_item_id && pausedSet.has(p.ml_item_id)) p.status_anuncio = 'paused';
    }
    await pool.query("UPDATE app_state SET value=$1::jsonb, updated_at=NOW() WHERE key='aliexpress_catalog'", [JSON.stringify(catalog)]);
  }
}
await pool.end();

fs.mkdirSync(OUT_DIR, { recursive: true });
const reportPath = path.join(OUT_DIR, `pausar_97_ml_${STAMP}.json`);
fs.writeFileSync(reportPath, JSON.stringify({ generated_at: new Date().toISOString(), apply: APPLY, total: report.length, paused_ok: pausedOk.length, report }, null, 2));
console.log(`\nPausados/confirmados: ${pausedOk.length}/${targets.length}`);
console.log('Relatorio:', reportPath);
