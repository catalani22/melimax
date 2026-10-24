import pg from 'pg';

const { Pool } = pg;

const memory = { accounts: [], listings: [], labels: [] };
let pool = null;
let schemaPromise = null;

if (process.env.DATABASE_URL) {
  pool = new Pool({
    connectionString: process.env.DATABASE_URL,
    max: 5,
    idleTimeoutMillis: 15000,
    connectionTimeoutMillis: 10000,
  });
  pool.on('error', (err) => {
    console.error('[db] pool error:', err.message);
  });
} else {
  console.warn('[db] DATABASE_URL ausente: usando memoria (dados nao persistem)');
}

export function usingMemory() {
  return !pool;
}

export async function query(text, params) {
  if (!pool) return { rows: [] };
  return pool.query(text, params);
}

export function mem(table) {
  return memory[table] || [];
}

export function memPush(table, row) {
  (memory[table] ||= []).push(row);
  return row;
}

export function memFind(table, fn) {
  return (memory[table] || []).find(fn);
}

const SCHEMA = `
CREATE TABLE IF NOT EXISTS ml_accounts (
  id SERIAL PRIMARY KEY,
  user_id BIGINT UNIQUE NOT NULL,
  nickname TEXT,
  access_token TEXT NOT NULL,
  refresh_token TEXT NOT NULL,
  expires_in INTEGER,
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

ALTER TABLE ml_accounts ADD COLUMN IF NOT EXISTS expires_at TIMESTAMPTZ;
ALTER TABLE ml_accounts ADD COLUMN IF NOT EXISTS scope TEXT;

CREATE TABLE IF NOT EXISTS listings (
  id SERIAL PRIMARY KEY,
  ml_item_id TEXT UNIQUE NOT NULL,
  title TEXT NOT NULL,
  price NUMERIC NOT NULL,
  supplier TEXT NOT NULL,
  status TEXT DEFAULT 'active',
  score INTEGER DEFAULT 0,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

ALTER TABLE listings ADD COLUMN IF NOT EXISTS source_item_id TEXT;
ALTER TABLE listings ADD COLUMN IF NOT EXISTS source_price NUMERIC;
ALTER TABLE listings ADD COLUMN IF NOT EXISTS supplier_id TEXT;
ALTER TABLE listings ADD COLUMN IF NOT EXISTS permalink TEXT;
ALTER TABLE listings ADD COLUMN IF NOT EXISTS margin NUMERIC;
ALTER TABLE listings ADD COLUMN IF NOT EXISTS thumbnail TEXT;

CREATE TABLE IF NOT EXISTS labels (
  id SERIAL PRIMARY KEY,
  order_id TEXT NOT NULL,
  supplier TEXT NOT NULL,
  shipping_data JSONB DEFAULT '{}',
  status TEXT DEFAULT 'gerada',
  created_at TIMESTAMPTZ DEFAULT NOW()
);
`;

export async function ensureSchema() {
  if (!pool) return false;
  if (!schemaPromise) {
    schemaPromise = pool
      .query(SCHEMA)
      .then(() => true)
      .catch((err) => {
        schemaPromise = null;
        throw err;
      });
  }
  return schemaPromise;
}

export async function dbStatus() {
  if (!pool) return { driver: 'memory', ok: false };
  const started = Date.now();
  await pool.query('SELECT 1');
  return { driver: 'postgres', ok: true, latency_ms: Date.now() - started };
}
