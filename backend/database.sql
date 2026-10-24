-- Contas Mercado Livre (OAuth)
CREATE TABLE IF NOT EXISTS ml_accounts (
  id SERIAL PRIMARY KEY,
  user_id BIGINT UNIQUE NOT NULL,
  nickname TEXT,
  access_token TEXT NOT NULL,
  refresh_token TEXT NOT NULL,
  expires_in INTEGER,
  expires_at TIMESTAMPTZ,
  scope TEXT,
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

-- Anuncios criados
CREATE TABLE IF NOT EXISTS listings (
  id SERIAL PRIMARY KEY,
  ml_item_id TEXT UNIQUE NOT NULL,
  title TEXT NOT NULL,
  price NUMERIC NOT NULL,
  supplier TEXT NOT NULL,
  status TEXT DEFAULT 'active',
  score INTEGER DEFAULT 0,
  source_item_id TEXT,
  source_price NUMERIC,
  supplier_id TEXT,
  permalink TEXT,
  margin NUMERIC,
  thumbnail TEXT,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

-- Etiquetas/registros de remessa
CREATE TABLE IF NOT EXISTS labels (
  id SERIAL PRIMARY KEY,
  order_id TEXT NOT NULL,
  supplier TEXT NOT NULL,
  shipping_data JSONB DEFAULT '{}',
  status TEXT DEFAULT 'gerada',
  created_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_listings_created_at ON listings (created_at DESC);
CREATE INDEX IF NOT EXISTS idx_labels_order_id ON labels (order_id);
