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
ALTER TABLE listings ADD COLUMN IF NOT EXISTS catalogo_id TEXT;
ALTER TABLE listings ADD COLUMN IF NOT EXISTS listing_type_id TEXT;
ALTER TABLE listings ADD COLUMN IF NOT EXISTS last_price_sync_at TIMESTAMPTZ;
ALTER TABLE listings ADD COLUMN IF NOT EXISTS price_floor NUMERIC;
ALTER TABLE listings ADD COLUMN IF NOT EXISTS price_ceiling NUMERIC;
ALTER TABLE listings ADD COLUMN IF NOT EXISTS cost NUMERIC;
ALTER TABLE listings ADD COLUMN IF NOT EXISTS sale_fee NUMERIC;
ALTER TABLE listings ADD COLUMN IF NOT EXISTS taxes NUMERIC;
ALTER TABLE listings ADD COLUMN IF NOT EXISTS shipping_cost NUMERIC;
ALTER TABLE listings ADD COLUMN IF NOT EXISTS packaging_cost NUMERIC;
ALTER TABLE listings ADD COLUMN IF NOT EXISTS net_profit NUMERIC;
ALTER TABLE listings ADD COLUMN IF NOT EXISTS fee_percentage NUMERIC;
ALTER TABLE listings ADD COLUMN IF NOT EXISTS payload JSONB;
ALTER TABLE listings ADD COLUMN IF NOT EXISTS quality_breakdown JSONB;
ALTER TABLE listings ADD COLUMN IF NOT EXISTS supplier_sku TEXT;
ALTER TABLE listings ADD COLUMN IF NOT EXISTS gtin TEXT;
ALTER TABLE listings ADD COLUMN IF NOT EXISTS category_id TEXT;
ALTER TABLE listings ADD COLUMN IF NOT EXISTS description TEXT;
ALTER TABLE listings ADD COLUMN IF NOT EXISTS pictures JSONB;
ALTER TABLE listings ADD COLUMN IF NOT EXISTS attributes JSONB;
ALTER TABLE listings ADD COLUMN IF NOT EXISTS available_quantity INTEGER;
ALTER TABLE listings ADD COLUMN IF NOT EXISTS published_at TIMESTAMPTZ;
ALTER TABLE listings ADD COLUMN IF NOT EXISTS draft_source TEXT;

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
  categoria TEXT,
  url TEXT,
  tara_kg NUMERIC,
  preco_mercado NUMERIC,
  mercado_min NUMERIC,
  mercado_max NUMERIC,
  mercado_ofertas INTEGER,
  mercado_vendedores INTEGER,
  mercado_confianca NUMERIC,
  mercado_multiplo NUMERIC,
  matched_id TEXT,
  matched_name TEXT,
  categoria_ml TEXT,
  atualizado_em TIMESTAMPTZ DEFAULT NOW(),
  UNIQUE (fornecedor_id, sku)
);

ALTER TABLE supplier_products ADD COLUMN IF NOT EXISTS categoria TEXT;
ALTER TABLE supplier_products ADD COLUMN IF NOT EXISTS url TEXT;
ALTER TABLE supplier_products ADD COLUMN IF NOT EXISTS tara_kg NUMERIC;
ALTER TABLE supplier_products ADD COLUMN IF NOT EXISTS preco_mercado NUMERIC;
ALTER TABLE supplier_products ADD COLUMN IF NOT EXISTS mercado_min NUMERIC;
ALTER TABLE supplier_products ADD COLUMN IF NOT EXISTS mercado_max NUMERIC;
ALTER TABLE supplier_products ADD COLUMN IF NOT EXISTS mercado_ofertas INTEGER;
ALTER TABLE supplier_products ADD COLUMN IF NOT EXISTS mercado_vendedores INTEGER;
ALTER TABLE supplier_products ADD COLUMN IF NOT EXISTS mercado_confianca NUMERIC;
ALTER TABLE supplier_products ADD COLUMN IF NOT EXISTS mercado_multiplo NUMERIC;
ALTER TABLE supplier_products ADD COLUMN IF NOT EXISTS matched_id TEXT;
ALTER TABLE supplier_products ADD COLUMN IF NOT EXISTS matched_name TEXT;
ALTER TABLE supplier_products ADD COLUMN IF NOT EXISTS categoria_ml TEXT;
ALTER TABLE supplier_products ADD COLUMN IF NOT EXISTS validado_manual BOOLEAN DEFAULT FALSE;
ALTER TABLE supplier_products ADD COLUMN IF NOT EXISTS validado_manual_nota TEXT;
ALTER TABLE supplier_products ADD COLUMN IF NOT EXISTS validado_manual_em TIMESTAMPTZ;
ALTER TABLE supplier_products ADD COLUMN IF NOT EXISTS mercado_tentado_em TIMESTAMPTZ;
ALTER TABLE supplier_products ADD COLUMN IF NOT EXISTS alto_giro_manual BOOLEAN DEFAULT FALSE;
ALTER TABLE supplier_products ADD COLUMN IF NOT EXISTS fotos JSONB DEFAULT '[]'::jsonb;
ALTER TABLE supplier_products ADD COLUMN IF NOT EXISTS descricao TEXT;
ALTER TABLE supplier_products ADD COLUMN IF NOT EXISTS atributos JSONB DEFAULT '[]'::jsonb;
ALTER TABLE supplier_products ADD COLUMN IF NOT EXISTS supplier_ref TEXT;
ALTER TABLE supplier_products ADD COLUMN IF NOT EXISTS atualizado_fornecedor_em TIMESTAMPTZ;

CREATE INDEX IF NOT EXISTS idx_supplier_products_catalogo
  ON supplier_products (catalogo_id);
CREATE INDEX IF NOT EXISTS idx_supplier_products_gtin
  ON supplier_products (gtin);
CREATE INDEX IF NOT EXISTS idx_supplier_products_item
  ON supplier_products (item_id);

CREATE TABLE IF NOT EXISTS price_alerts (
  id BIGSERIAL PRIMARY KEY,
  tipo TEXT NOT NULL DEFAULT 'preco',
  produto TEXT,
  fornecedor_id TEXT,
  sku TEXT,
  listing_id INTEGER,
  ml_item_id TEXT,
  custo_anterior NUMERIC,
  custo_novo NUMERIC,
  preco_anterior NUMERIC,
  preco_novo NUMERIC,
  margem_anterior NUMERIC,
  margem_nova NUMERIC,
  lucro_anterior NUMERIC,
  lucro_novo NUMERIC,
  mensagem TEXT,
  lido BOOLEAN DEFAULT FALSE,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_price_alerts_created
  ON price_alerts (created_at DESC);
CREATE INDEX IF NOT EXISTS idx_price_alerts_unread
  ON price_alerts (lido, created_at DESC);

CREATE OR REPLACE FUNCTION log_supplier_cost_change() RETURNS trigger AS $$
BEGIN
  IF TG_OP = 'UPDATE' AND NEW.custo IS DISTINCT FROM OLD.custo THEN
    INSERT INTO price_alerts
      (tipo, produto, fornecedor_id, sku, custo_anterior, custo_novo, mensagem)
    VALUES
      ('custo', COALESCE(NEW.titulo, NEW.sku), NEW.fornecedor_id, NEW.sku,
       OLD.custo, NEW.custo,
       'Custo de ' || COALESCE(NEW.titulo, NEW.sku) || ' mudou de R$ ' ||
       OLD.custo::text || ' para R$ ' || NEW.custo::text ||
       '. Revise o preço de venda para preservar a margem.');
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_supplier_cost_change ON supplier_products;
CREATE TRIGGER trg_supplier_cost_change
  AFTER UPDATE OF custo ON supplier_products
  FOR EACH ROW EXECUTE FUNCTION log_supplier_cost_change();

CREATE OR REPLACE FUNCTION log_listing_price_change() RETURNS trigger AS $$
BEGIN
  IF TG_OP = 'UPDATE' AND NEW.price IS DISTINCT FROM OLD.price THEN
    INSERT INTO price_alerts
      (tipo, produto, fornecedor_id, sku, listing_id, ml_item_id,
       custo_anterior, custo_novo, preco_anterior, preco_novo,
       margem_anterior, margem_nova, lucro_anterior, lucro_novo, mensagem)
    VALUES
      ('preco', NEW.title, NEW.supplier, NULL, NEW.id, NEW.ml_item_id,
       OLD.cost, NEW.cost, OLD.price, NEW.price, OLD.margin, NEW.margin,
       OLD.net_profit, NEW.net_profit,
       'Preço de ' || NEW.title || ' ajustado de R$ ' || OLD.price::text ||
       ' para R$ ' || NEW.price::text || ', margem de ' ||
       COALESCE(replace(round(OLD.margin * 100, 1)::text, '.', ','), '?') ||
       '% para ' ||
       COALESCE(replace(round(NEW.margin * 100, 1)::text, '.', ','), '?') ||
       '%.');
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_listing_price_change ON listings;
CREATE TRIGGER trg_listing_price_change
  AFTER UPDATE OF price ON listings
  FOR EACH ROW EXECUTE FUNCTION log_listing_price_change();

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
  cnpj TEXT,
  endereco TEXT,
  bairro TEXT,
  cidade TEXT,
  uf TEXT,
  cep TEXT,
  cep_distribuicao TEXT,
  endereco_distribuicao TEXT,
  prazo_postagem TEXT,
  custo_embalagem NUMERIC DEFAULT 0,
  observacoes TEXT,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

ALTER TABLE suppliers ADD COLUMN IF NOT EXISTS cnpj TEXT;
ALTER TABLE suppliers ADD COLUMN IF NOT EXISTS endereco TEXT;
ALTER TABLE suppliers ADD COLUMN IF NOT EXISTS bairro TEXT;
ALTER TABLE suppliers ADD COLUMN IF NOT EXISTS cidade TEXT;
ALTER TABLE suppliers ADD COLUMN IF NOT EXISTS uf TEXT;
ALTER TABLE suppliers ADD COLUMN IF NOT EXISTS cep TEXT;
ALTER TABLE suppliers ADD COLUMN IF NOT EXISTS cep_distribuicao TEXT;
ALTER TABLE suppliers ADD COLUMN IF NOT EXISTS endereco_distribuicao TEXT;
ALTER TABLE suppliers ADD COLUMN IF NOT EXISTS prazo_postagem TEXT;
ALTER TABLE suppliers ADD COLUMN IF NOT EXISTS custo_embalagem NUMERIC DEFAULT 0;
ALTER TABLE suppliers ADD COLUMN IF NOT EXISTS observacoes TEXT;

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
