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
const TARGET_STOCK = Math.min(Math.max(Number(args.stock) || 3, 1), 3);
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
  'SELECT user_id, access_token, refresh_token FROM ml_accounts ORDER BY updated_at DESC LIMIT 1'
);
const account = accountRows[0];
if (!account?.access_token) throw new Error('Conta ML nao conectada no banco.');
const { rows: listingRows } = await pool.query(
  'SELECT ml_item_id FROM listings WHERE ml_item_id IS NOT NULL ORDER BY created_at ASC'
);

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
let lastAt = 0;
async function throttle() {
  const wait = Math.max(0, lastAt + DELAY_MS - Date.now());
  if (wait) await sleep(wait);
  lastAt = Date.now();
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
console.log(`${APPLY ? 'APPLY' : 'DRY-RUN'} | estoque alvo: ${TARGET_STOCK} | anuncios: ${targets.length} | delay: ${DELAY_MS}ms`);
fs.mkdirSync(BACKUP_DIR, { recursive: true });

const report = [];
const updatedIds = [];
for (const row of targets) {
  const entry = { ml_item_id: row.ml_item_id };
  try {
    const before = await api(`/items/${encodeURIComponent(row.ml_item_id)}`);
    entry.quantity_before = before.available_quantity;
    entry.status_before = before.status;
    fs.writeFileSync(path.join(BACKUP_DIR, `${row.ml_item_id}-stock-before.json`), JSON.stringify(before, null, 2));
    if (Number(before.available_quantity) === TARGET_STOCK) {
      entry.action = 'already_target';
      updatedIds.push(row.ml_item_id);
    } else if (!APPLY) {
      entry.action = 'would_set';
    } else {
      await api(`/items/${encodeURIComponent(row.ml_item_id)}`, {
        method: 'PUT',
        body: JSON.stringify({ available_quantity: TARGET_STOCK }),
      });
      let after = await api(`/items/${encodeURIComponent(row.ml_item_id)}`);
      if (after.status === 'active') {
        await api(`/items/${encodeURIComponent(row.ml_item_id)}`, {
          method: 'PUT',
          body: JSON.stringify({ status: 'paused' }),
        });
        after = await api(`/items/${encodeURIComponent(row.ml_item_id)}`);
        entry.paused_again = true;
      }
      entry.quantity_after = after.available_quantity;
      entry.status_after = after.status;
      entry.action = after.status === 'paused' || after.status === 'under_review' ? 'updated' : 'updated_not_paused';
      updatedIds.push(row.ml_item_id);
    }
    report.push(entry);
    console.log(`${row.ml_item_id} | ${entry.quantity_before} -> ${entry.quantity_after ?? entry.action} | ${entry.status_before} -> ${entry.status_after || ''}`);
  } catch (err) {
    entry.error = err.message;
    entry.error_status = err.status || null;
    report.push(entry);
    console.error(`${row.ml_item_id} | ERRO ${err.status || ''}: ${err.message}`);
    if (err.status === 429) break;
  }
}

if (APPLY) {
  const { rows: stateRows } = await pool.query("SELECT value FROM app_state WHERE key='aliexpress_catalog'");
  const raw = stateRows[0]?.value;
  const catalog = typeof raw === 'string' ? JSON.parse(raw) : raw;
  const ids = new Set(updatedIds);
  if (Array.isArray(catalog)) {
    for (const p of catalog) {
      if (p?.ml_item_id && ids.has(p.ml_item_id)) p.estoque_disponivel = TARGET_STOCK;
    }
    await pool.query("UPDATE app_state SET value=$1::jsonb, updated_at=NOW() WHERE key='aliexpress_catalog'", [JSON.stringify(catalog)]);
  }
}
await pool.end();
fs.mkdirSync(OUT_DIR, { recursive: true });
const reportPath = path.join(OUT_DIR, `estoque_97_ml_${STAMP}.json`);
fs.writeFileSync(reportPath, JSON.stringify({ generated_at: new Date().toISOString(), apply: APPLY, target: TARGET_STOCK, total: report.length, updated: updatedIds.length, report }, null, 2));
console.log(`\nAtualizados/confirmados: ${updatedIds.length}/${targets.length}`);
console.log('Relatorio:', reportPath);
