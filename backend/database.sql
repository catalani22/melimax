-- Tabela de contas Mercado Livre (OAuth)
CREATE TABLE IF NOT EXISTS ml_accounts (
  id SERIAL PRIMARY KEY,
  user_id BIGINT UNIQUE NOT NULL,
  nickname TEXT,
  access_token TEXT NOT NULL,
  refresh_token TEXT NOT NULL,
  expires_in INTEGER,
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

-- Tabela de anúncios criados
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

-- Tabela de etiquetas de remessa
CREATE TABLE IF NOT EXISTS labels (
  id SERIAL PRIMARY KEY,
  order_id TEXT NOT NULL,
  supplier TEXT NOT NULL,
  shipping_data JSONB DEFAULT '{}',
  status TEXT DEFAULT 'gerada',
  created_at TIMESTAMPTZ DEFAULT NOW()
);
