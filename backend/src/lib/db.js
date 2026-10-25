import pg from 'pg';
import { hashPassword } from './password.js';

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

CREATE TABLE IF NOT EXISTS supplier_products (
  id SERIAL PRIMARY KEY,
  fornecedor_id TEXT NOT NULL,
  fornecedor_nome TEXT,
  catalogo_id TEXT,
  item_id TEXT,
  sku TEXT NOT NULL,
  gtin TEXT,
  titulo TEXT,
  custo NUMERIC NOT NULL,
  estoque INTEGER DEFAULT 0,
  peso_kg NUMERIC,
  altura_cm NUMERIC,
  largura_cm NUMERIC,
  comprimento_cm NUMERIC,
  ativo BOOLEAN DEFAULT TRUE,
  atualizado_em TIMESTAMPTZ DEFAULT NOW(),
  UNIQUE (fornecedor_id, sku)
);

CREATE INDEX IF NOT EXISTS idx_supplier_products_catalogo
  ON supplier_products (catalogo_id);
CREATE INDEX IF NOT EXISTS idx_supplier_products_gtin
  ON supplier_products (gtin);
CREATE INDEX IF NOT EXISTS idx_supplier_products_item
  ON supplier_products (item_id);

CREATE TABLE IF NOT EXISTS trend_keyword_snapshots (
  id BIGSERIAL PRIMARY KEY,
  keyword TEXT NOT NULL,
  position INTEGER NOT NULL,
  captured_on DATE NOT NULL,
  captured_at TIMESTAMPTZ DEFAULT NOW(),
  UNIQUE (keyword, captured_on)
);

CREATE INDEX IF NOT EXISTS idx_trend_keywords_date
  ON trend_keyword_snapshots (captured_on DESC, position ASC);

CREATE TABLE IF NOT EXISTS trend_product_snapshots (
  id BIGSERIAL PRIMARY KEY,
  keyword TEXT NOT NULL,
  product_id TEXT NOT NULL,
  gtin TEXT,
  name TEXT,
  domain_id TEXT,
  thumbnail TEXT,
  permalink TEXT,
  best_item_id TEXT,
  best_seller_id BIGINT,
  price_min NUMERIC,
  price_max NUMERIC,
  offers_count INTEGER DEFAULT 0,
  sellers_count INTEGER DEFAULT 0,
  free_shipping_count INTEGER DEFAULT 0,
  official_count INTEGER DEFAULT 0,
  best_listing_type TEXT,
  position INTEGER,
  captured_on DATE NOT NULL,
  captured_at TIMESTAMPTZ DEFAULT NOW(),
  UNIQUE (keyword, product_id, captured_on)
);

CREATE INDEX IF NOT EXISTS idx_trend_products_date
  ON trend_product_snapshots (captured_on DESC, keyword, position ASC);
CREATE INDEX IF NOT EXISTS idx_trend_products_product
  ON trend_product_snapshots (product_id, captured_on DESC);

CREATE TABLE IF NOT EXISTS dashboard_users (
  id SERIAL PRIMARY KEY,
  username TEXT UNIQUE NOT NULL,
  name TEXT,
  password_hash TEXT NOT NULL,
  role TEXT NOT NULL DEFAULT 'operator',
  active BOOLEAN NOT NULL DEFAULT TRUE,
  token_version INTEGER NOT NULL DEFAULT 0,
  last_login_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_dashboard_users_username
  ON dashboard_users (username);

CREATE TABLE IF NOT EXISTS suppliers (
  id SERIAL PRIMARY KEY,
  slug TEXT UNIQUE NOT NULL,
  nome TEXT NOT NULL,
  site TEXT,
  descricao TEXT,
  nichos TEXT[] DEFAULT '{}',
  pedido_minimo NUMERIC,
  dropshipping BOOLEAN DEFAULT FALSE,
  integracao TEXT DEFAULT 'manual',
  ativo BOOLEAN DEFAULT TRUE,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

INSERT INTO suppliers (slug, nome, descricao, nichos, pedido_minimo, dropshipping, integracao)
VALUES
  ('plb-importadora', 'PLB Importadora',
   'Importadora de aco inoxidavel: correntes, aliancas, brincos, pulseiras e acessorios antialergicos. Regiao da 25 de Marco/Bras, Sao Paulo.',
   ARRAY['moda','acessorios','joias'], NULL, FALSE, 'manual'),
  ('lb-eletronicos', 'LB Eletronicos',
   'Importadora e distribuidora na Galeria Page do Bras. Fones Bluetooth, carregadores, caixas de som, smartwatches e suportes veiculares.',
   ARRAY['eletronicos','informatica','celulares','games'], 500, FALSE, 'manual'),
  ('adjuntos-acessorios', 'ADJuntos Acessorios (Junto Acessorios)',
   'Importadora de acessorios de informatica, som e carregadores rapidos. Cabos, power banks, adaptadores e pequenos eletroportateis.',
   ARRAY['informatica','eletronicos'], NULL, FALSE, 'manual'),
  ('ultimix-atacado', 'Ultimix Atacado',
   'Atacadista de utilidades domesticas e organizacao. Utensilios de cozinha em silicone/inox, potes e organizadores.',
   ARRAY['casa','eletrodomesticos'], NULL, FALSE, 'manual'),
  ('vinha-costa', 'Vinha Costa (Costa.Tech)',
   'Fornecedor de smartwatches e wearables de marcas asiaticas de alto giro, com chamadas, ilha dinamica e telas AMOLED.',
   ARRAY['relogios','eletronicos'], NULL, FALSE, 'manual'),
  ('fforder', 'FFOrder',
   'Catalogo global com dropshipping e fulfillment. Sem integracao nativa com Mercado Livre: importar CSV/API e validar prazo, estoque e nota fiscal por SKU.',
   ARRAY['eletronicos','casa','moda','beleza','esportes','pet','ferramentas','brinquedos','automotivo'], NULL, TRUE, 'csv')
ON CONFLICT (slug) DO NOTHING;
`;

async function seedAdminUser() {
  const password = process.env.DASHBOARD_PASSWORD;
  if (!password) return;
  await pool.query(
    `INSERT INTO dashboard_users (username, name, password_hash, role, active)
     VALUES ('admin', 'Administrador', $1, 'admin', TRUE)
     ON CONFLICT (username) DO NOTHING`,
    [hashPassword(password)]
  );
}

export async function ensureSchema() {
  if (!pool) return false;
  if (!schemaPromise) {
    schemaPromise = pool
      .query(SCHEMA)
      .then(async () => {
        await seedAdminUser();
        return true;
      })
      .catch((err) => {
        schemaPromise = null;
        throw err;
      });
  }
  return schemaPromise;
}

export async function dashboardUserCount() {
  if (!pool) return 0;
  const { rows } = await pool.query('SELECT COUNT(*)::int AS count FROM dashboard_users');
  return Number(rows[0]?.count) || 0;
}

export async function dbStatus() {
  if (!pool) return { driver: 'memory', ok: false };
  const started = Date.now();
  await pool.query('SELECT 1');
  return { driver: 'postgres', ok: true, latency_ms: Date.now() - started };
}
