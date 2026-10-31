import pg from 'pg';
import { hashPassword } from './password.js';

const { Pool } = pg;

const DEFAULT_SUPPLIERS = [
  {
    id: 1,
    slug: 'aliexpress-brasil',
    nome: 'AliExpress Brasil (Estoque Nacional + Frete Grátis)',
    site: 'https://pt.aliexpress.com',
    descricao:
      'Operação exclusiva com vendedores AliExpress de estoque físico no Brasil (notas 4.8–4.9) e frete grátis. Entrega no Mercado Livre configurada como "Vou enviar por minha conta" para Todo o Brasil a R$ 0,00 (prazo de 5 a 10 dias).',
    nichos: ['eletronicos', 'casa', 'beleza', 'ferramentas', 'acessorios', 'utilidades'],
    pedido_minimo: 0,
    dropshipping: true,
    integracao: 'csv_api',
    ativo: true,
    cnpj: null,
    endereco: 'Armazéns Locais no Brasil (Envio Direto ao Comprador)',
    bairro: null,
    cidade: 'São Paulo',
    uf: 'SP',
    cep: null,
    prazo_postagem: 'Envio imediato — Entrega de 5 a 10 dias',
    custo_embalagem: 0,
    observacoes: 'Sem geração de etiquetas. Rastreamento inserido manualmente no pedido do Mercado Livre.',
    created_at: new Date().toISOString(),
  },
  {
    id: 2,
    slug: 'cssv-shop-store',
    nome: 'CSSV SHOP Store (AliExpress Brasil)',
    site: 'https://pt.aliexpress.com/store/1105400522',
    descricao:
      'Fornecedor principal do catálogo PDF no AliExpress Brasil (Loja 1105400522) com nota 4.8, frete grátis nacional e pronta entrega.',
    nichos: ['casa', 'eletronicos', 'beleza', 'ferramentas', 'acessorios'],
    pedido_minimo: 0,
    dropshipping: true,
    integracao: 'csv_api',
    ativo: true,
    cnpj: null,
    endereco: 'Estoque Nacional Brasil',
    bairro: null,
    cidade: 'São Paulo',
    uf: 'SP',
    cep: null,
    prazo_postagem: '5 a 10 dias (Todo o Brasil)',
    custo_embalagem: 0,
    observacoes: 'Comprar em nome da Melimax - Shop (CNPJ) inserindo o endereço completo do comprador.',
    created_at: new Date().toISOString(),
  },
];

const memory = {
  accounts: [],
  listings: [],
  order_executions: [],
  suppliers: DEFAULT_SUPPLIERS.map((item) => ({ ...item })),
  supplier_products: [],
  price_alerts: [],
  dashboard_users: [],
  app_state: new Map(),
};
let nextIds = { accounts: 1, listings: 1, suppliers: 3, supplier_products: 1, users: 1, executions: 1 };
const RAW_DATABASE_URL = (process.env.DATABASE_URL || '').trim();
const IS_LOCALHOST_DB =
  Boolean(RAW_DATABASE_URL) &&
  /^postgres(ql)?:\/\/([^@]+@)?(localhost|127\.0\.0\.1)(:\d+)?(\/|$)/i.test(RAW_DATABASE_URL);
const DATABASE_URL = IS_LOCALHOST_DB && process.env.K_SERVICE ? '' : RAW_DATABASE_URL;
const IS_VERCEL = Boolean(process.env.VERCEL);
const IS_PRODUCTION = process.env.NODE_ENV === 'production' || IS_VERCEL;
let allowMemoryFallback = !DATABASE_URL || !IS_VERCEL;
const REQUIRES_SSL =
  Boolean(DATABASE_URL) &&
  !IS_LOCALHOST_DB &&
  (IS_PRODUCTION || /sslmode=(require|verify-ca|verify-full)/i.test(DATABASE_URL) || /neon\.tech/i.test(DATABASE_URL));
let pool = null;
let schemaPromise = null;

function switchToMemoryFallback(reason) {
  if (IS_VERCEL) return false;
  if (pool) {
    const oldPool = pool;
    pool = null;
    oldPool.end().catch(() => {});
  }
  allowMemoryFallback = true;
  console.warn(`[db] Postgres local indisponível (${reason}); operando em memória.`);
  return true;
}

if (DATABASE_URL) {
  try {
    pool = new Pool({
      connectionString: DATABASE_URL,
      ...(REQUIRES_SSL ? { ssl: { rejectUnauthorized: false } } : {}),
      max: 5,
      idleTimeoutMillis: 15000,
      connectionTimeoutMillis: IS_LOCALHOST_DB ? 1500 : 5000,
    });
    pool.on('error', (err) => {
      console.error('[db] pool error:', err.message);
    });
  } catch (err) {
    console.error('[db] falha ao criar pool:', err.message);
    pool = null;
  }
}

function mockQuery(text, params = []) {
  try {
    const sql = String(text || '').trim();
    const upper = sql.toUpperCase();

    if (upper.includes('FROM ML_ACCOUNTS')) {
      const sorted = [...memory.accounts].sort(
        (a, b) => new Date(b.updated_at).getTime() - new Date(a.updated_at).getTime()
      );
      return { rows: sorted.slice(0, 1), rowCount: sorted.length ? 1 : 0 };
    }
    if (upper.startsWith('INSERT INTO ML_ACCOUNTS')) {
      const [user_id, nickname, access_token, refresh_token, expires_in, expires_at, scope] = params;
      const existing = memory.accounts.find((a) => String(a.user_id) === String(user_id));
      const now = new Date().toISOString();
      if (existing) {
        Object.assign(existing, { nickname, access_token, refresh_token, expires_in, expires_at, scope, updated_at: now });
        return { rows: [existing], rowCount: 1 };
      }
      const created = {
        id: nextIds.accounts++,
        user_id,
        nickname,
        access_token,
        refresh_token,
        expires_in,
        expires_at,
        scope,
        updated_at: now,
      };
      memory.accounts.push(created);
      return { rows: [created], rowCount: 1 };
    }
    if (upper.startsWith('UPDATE ML_ACCOUNTS')) {
      const [access_token, refresh_token, expires_in, expires_at, scope, user_id] = params;
      const existing = memory.accounts.find((a) => String(a.user_id) === String(user_id));
      if (existing) {
        Object.assign(existing, { access_token, refresh_token, expires_in, expires_at, scope, updated_at: new Date().toISOString() });
        return { rows: [existing], rowCount: 1 };
      }
      return { rows: [], rowCount: 0 };
    }
    if (upper.startsWith('DELETE FROM ML_ACCOUNTS')) {
      const count = memory.accounts.length;
      memory.accounts.length = 0;
      return { rows: [], rowCount: count };
    }
    if (upper === 'SELECT * FROM SUPPLIERS ORDER BY NOME ASC') {
      const rows = [...memory.suppliers].sort((a, b) => String(a.nome).localeCompare(String(b.nome)));
      return { rows, rowCount: rows.length };
    }
    if (upper.startsWith('INSERT INTO LISTINGS')) {
      const [
        ml_item_id,
        title,
        price,
        supplier,
        status,
        score,
        source_item_id,
        source_price,
        supplier_id,
        permalink,
        margin,
        thumbnail,
        listing_type_id,
        cost,
        sale_fee,
        taxes,
        shipping_cost,
        net_profit,
      ] = params;
      const now = new Date().toISOString();
      const existing = memory.listings.find((l) => l.ml_item_id === ml_item_id);
      if (existing) {
        Object.assign(existing, {
          title,
          price,
          supplier,
          status,
          score,
          source_item_id,
          source_price,
          supplier_id,
          permalink,
          margin,
          thumbnail,
          listing_type_id,
          cost,
          sale_fee,
          taxes,
          shipping_cost,
          net_profit,
        });
        return { rows: [existing], rowCount: 1 };
      }
      const created = {
        id: nextIds.listings++,
        ml_item_id,
        title,
        price,
        supplier: supplier || 'aliexpress-brasil',
        status: status || 'paused',
        score: score || 90,
        source_item_id,
        source_price,
        supplier_id: supplier_id || 'aliexpress-brasil',
        permalink,
        margin,
        thumbnail,
        listing_type_id: listing_type_id || 'gold_pro',
        cost,
        sale_fee,
        taxes,
        shipping_cost: shipping_cost ?? 0,
        net_profit,
        created_at: now,
      };
      memory.listings.push(created);
      return { rows: [created], rowCount: 1 };
    }
    if (upper.startsWith('SELECT * FROM LISTINGS')) {
      const rows = [...memory.listings].sort(
        (a, b) => new Date(b.created_at).getTime() - new Date(a.created_at).getTime()
      );
      return { rows: rows.slice(0, 200), rowCount: Math.min(rows.length, 200) };
    }
    if (upper.includes('FROM ORDER_EXECUTIONS')) {
      if (params.length === 1 && typeof params[0] === 'string') {
        const found = memory.order_executions.filter((e) => e.order_id === params[0]);
        return { rows: found, rowCount: found.length };
      }
      const rows = [...memory.order_executions].sort(
        (a, b) => new Date(b.updated_at).getTime() - new Date(a.updated_at).getTime()
      );
      return { rows, rowCount: rows.length };
    }
    if (upper.startsWith('INSERT INTO ORDER_EXECUTIONS')) {
      const [
        order_id,
        sku,
        aliexpress_url,
        aliexpress_order_id,
        tracking_number,
        carrier,
        step,
        buyer_name,
        shipping_address,
        notes,
      ] = params;
      const now = new Date().toISOString();
      const existing = memory.order_executions.find((e) => e.order_id === String(order_id));
      if (existing) {
        Object.assign(existing, {
          sku: sku ?? existing.sku,
          aliexpress_url: aliexpress_url ?? existing.aliexpress_url,
          aliexpress_order_id: aliexpress_order_id ?? existing.aliexpress_order_id,
          tracking_number: tracking_number ?? existing.tracking_number,
          carrier: carrier ?? existing.carrier,
          step: step ?? existing.step,
          buyer_name: buyer_name ?? existing.buyer_name,
          shipping_address: shipping_address ?? existing.shipping_address,
          notes: notes ?? existing.notes,
          updated_at: now,
        });
        return { rows: [existing], rowCount: 1 };
      }
      const created = {
        id: nextIds.executions++,
        order_id: String(order_id),
        sku: sku || '',
        aliexpress_url: aliexpress_url || '',
        aliexpress_order_id: aliexpress_order_id || '',
        tracking_number: tracking_number || '',
        carrier: carrier || 'Transportadora Brasil',
        step: step || 1,
        buyer_name: buyer_name || '',
        shipping_address: shipping_address || '',
        notes: notes || '',
        created_at: now,
        updated_at: now,
      };
      memory.order_executions.push(created);
      return { rows: [created], rowCount: 1 };
    }
    if (upper.includes('COUNT(*)::INT AS TOTAL') && upper.includes('FROM PRICE_ALERTS')) {
      return { rows: [{ total: 0, nao_lidas: 0 }], rowCount: 1 };
    }
    if (upper.includes('FROM APP_STATE')) {
      const key = String(params[0] || '');
      if (memory.app_state.has(key)) {
        return { rows: [{ value: memory.app_state.get(key) }], rowCount: 1 };
      }
      return { rows: [], rowCount: 0 };
    }
    if (upper.startsWith('INSERT INTO APP_STATE')) {
      const key = String(params[0] || '');
      let val = params[1];
      if (typeof val === 'string') {
        try {
          val = JSON.parse(val);
        } catch {}
      }
      memory.app_state.set(key, val);
      return { rows: [{ key, value: val }], rowCount: 1 };
    }
    if (upper.includes('FROM DASHBOARD_USERS')) {
      const activeRows = memory.dashboard_users.filter((u) => u.active !== false);
      return { rows: activeRows, rowCount: activeRows.length };
    }
    if (upper.startsWith('UPDATE DASHBOARD_USERS')) {
      return { rows: [], rowCount: 1 };
    }
  } catch {}
  return { rows: [], rowCount: 0 };
}

export function usingMemory() {
  return !pool && allowMemoryFallback;
}

function databaseUnavailable(err) {
  const error = new Error(
    err?.message
      ? `Banco de dados indisponível: ${err.message}`
      : 'Banco de dados não configurado. Defina DATABASE_URL.'
  );
  error.code = 'DATABASE_UNAVAILABLE';
  error.cause = err;
  return error;
}

function isLocalConnRefused(err) {
  const msg = String(err?.message || err?.code || '');
  return IS_LOCALHOST_DB && /ECONNREFUSED|ENOTFOUND|timeout/i.test(msg);
}

export async function query(text, params) {
  if (!pool) {
    if (allowMemoryFallback) return mockQuery(text, params);
    throw databaseUnavailable();
  }
  try {
    return await pool.query(text, params);
  } catch (err) {
    if (isLocalConnRefused(err) && switchToMemoryFallback(err.message)) {
      return mockQuery(text, params);
    }
    throw databaseUnavailable(err);
  }
}

export function mem(table) {
  return memory[table] || [];
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
ALTER TABLE suppliers ADD COLUMN IF NOT EXISTS prazo_postagem TEXT;
ALTER TABLE suppliers ADD COLUMN IF NOT EXISTS custo_embalagem NUMERIC DEFAULT 0;
ALTER TABLE suppliers ADD COLUMN IF NOT EXISTS observacoes TEXT;

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
   ARRAY['eletronicos','casa','moda','beleza','esportes','pet','ferramentas','brinquedos','automotivo'], NULL, TRUE, 'csv'),
  ('c7-drop', 'C7 Drop (Cem Tecnologia)',
   'Dropshipping nacional com estoque em Sao Paulo, sem mensalidade e com NF-e.',
   ARRAY['casa','eletronicos','informatica','utilidades'], NULL, TRUE, 'manual'),
  ('atacadum', 'Atacadum',
   'Atacado com estoque em Sao Paulo e dropshipping sem mensalidade nem pedido minimo.',
   ARRAY['casa','eletronicos','utilidades','ferramentas'], NULL, TRUE, 'manual'),
  ('onedrop', 'OneDrop',
   'Hub de dropshipping com multiplos fornecedores e catalogo nacional.',
   ARRAY['eletronicos','casa','moda','beleza','esportes','pet'], NULL, TRUE, 'api'),
  ('smarke', 'Smarke',
   'Fornecedor de produtos de giro com estoque em Sao Paulo e dropshipping nacional.',
   ARRAY['casa','eletronicos','utilidades'], NULL, TRUE, 'manual'),
  ('mirao', 'Mirao Atacado',
   'Atacado tradicional usado como referencia de preco e sortimento. Nao opera dropshipping.',
   ARRAY['ferramentas','casa','eletronicos'], NULL, FALSE, 'manual')
ON CONFLICT (slug) DO NOTHING;

UPDATE suppliers SET
  bairro = COALESCE(bairro, 'Centro'),
  cidade = COALESCE(cidade, 'Sao Paulo'),
  uf = COALESCE(uf, 'SP'),
  cep = COALESCE(cep, '01022-050'),
  prazo_postagem = COALESCE(prazo_postagem, 'Confirmar com o fornecedor'),
  custo_embalagem = 2.50,
  observacoes = COALESCE(observacoes, 'Endereco completo nao informado; confirmar antes da primeira coleta.')
WHERE slug = 'c7-drop'
  AND cep IS NULL;

UPDATE suppliers SET
  bairro = COALESCE(bairro, 'Centro'),
  cidade = COALESCE(cidade, 'Sao Paulo'),
  uf = COALESCE(uf, 'SP'),
  cep = COALESCE(cep, '01012-001'),
  prazo_postagem = COALESCE(prazo_postagem, 'Corte diario as 13h'),
  custo_embalagem = COALESCE(custo_embalagem, 0),
  observacoes = COALESCE(observacoes, 'Endereco completo nao informado; confirmar antes da primeira coleta.')
WHERE slug = 'atacadum'
  AND cep IS NULL;

UPDATE suppliers SET
  prazo_postagem = COALESCE(prazo_postagem, 'Confirmar com o fornecedor'),
  custo_embalagem = COALESCE(custo_embalagem, 0),
  observacoes = COALESCE(observacoes, 'CEP e endereco de coleta nao informados pela plataforma.')
WHERE slug = 'onedrop'
  AND cep IS NULL;

UPDATE suppliers SET
  cnpj = COALESCE(cnpj, '37.776.426/0001-41'),
  endereco = COALESCE(endereco, 'Av. dos Metalurgicos, 1597, sala 1'),
  bairro = COALESCE(bairro, 'Cidade Tiradentes'),
  cidade = COALESCE(cidade, 'Sao Paulo'),
  uf = COALESCE(uf, 'SP'),
  cep = COALESCE(cep, '08471-000'),
  prazo_postagem = COALESCE(prazo_postagem, 'Confirmar com o fornecedor'),
  custo_embalagem = COALESCE(custo_embalagem, 0),
  observacoes = COALESCE(observacoes, 'Estoque fisico em Sao Paulo; confirmar prazo de postagem.')
WHERE slug = 'smarke'
  AND cep IS NULL;

UPDATE suppliers SET
  prazo_postagem = COALESCE(prazo_postagem, 'Nao opera dropshipping'),
  custo_embalagem = COALESCE(custo_embalagem, 0),
  observacoes = COALESCE(observacoes, 'Usado como benchmark de preco; nao e fornecedor de dropshipping.')
WHERE slug = 'mirao'
  AND cidade IS NULL;

CREATE TABLE IF NOT EXISTS order_executions (
  id SERIAL PRIMARY KEY,
  order_id TEXT UNIQUE NOT NULL,
  sku TEXT,
  aliexpress_url TEXT,
  aliexpress_order_id TEXT,
  tracking_number TEXT,
  carrier TEXT,
  step INTEGER DEFAULT 1,
  buyer_name TEXT,
  shipping_address TEXT,
  notes TEXT,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_order_executions_updated
  ON order_executions (updated_at DESC);

CREATE TABLE IF NOT EXISTS app_state (
  key TEXT PRIMARY KEY,
  value JSONB NOT NULL,
  updated_at TIMESTAMPTZ DEFAULT NOW()
);
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
        if (isLocalConnRefused(err)) {
          switchToMemoryFallback(err.message);
        } else {
          console.error('[db] falha ao garantir schema:', err.message);
        }
        return false;
      });
  }
  return schemaPromise;
}

export async function dashboardUserCount() {
  if (!pool) {
    if (allowMemoryFallback) return memory.dashboard_users.length;
    throw databaseUnavailable();
  }
  try {
    const { rows } = await pool.query('SELECT COUNT(*)::int AS count FROM dashboard_users');
    return Number(rows[0]?.count) || 0;
  } catch (err) {
    if (isLocalConnRefused(err) && switchToMemoryFallback(err.message)) {
      return memory.dashboard_users.length;
    }
    throw databaseUnavailable(err);
  }
}

export async function dbStatus() {
  if (!pool) {
    if (allowMemoryFallback) return { driver: 'memory', ok: true };
    return { driver: 'postgres', ok: false, error: 'DATABASE_URL ausente ou pool inválido.' };
  }
  try {
    const started = Date.now();
    await pool.query('SELECT 1');
    return { driver: 'postgres', ok: true, latency_ms: Date.now() - started };
  } catch (err) {
    if (isLocalConnRefused(err) && switchToMemoryFallback(err.message)) {
      return { driver: 'memory', ok: true };
    }
    return { driver: 'postgres', ok: false, error: err.message };
  }
}
