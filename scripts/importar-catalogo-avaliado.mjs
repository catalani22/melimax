import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { createRequire } from 'node:module';

const require = createRequire(new URL('../backend/package.json', import.meta.url));
const pg = require('pg');
const { parse } = require('csv-parse/sync');

const ROOT = path.resolve(new URL('..', import.meta.url).pathname);
const AVALIADOS = path.join(ROOT, 'dados', 'produtos_avaliados.csv');
const CATALOGO = path.join(ROOT, 'dados', 'catalogo_unificado.csv');

const SUPPLIERS = {
  C7: { id: 'c7-drop', name: 'C7 Drop (Cem Tecnologia)' },
  OneDrop: { id: 'onedrop', name: 'OneDrop' },
  Smarke: { id: 'smarke', name: 'Smarke' },
  'Mirão': { id: 'mirao', name: 'Mirao Atacado' },
};

function readCsv(file) {
  return parse(fs.readFileSync(file), {
    columns: true,
    delimiter: ';',
    bom: true,
    skip_empty_lines: true,
    relax_column_count: true,
  });
}

function number(value) {
  if (value == null || String(value).trim() === '') return null;
  const parsed = Number(String(value).replace(',', '.'));
  return Number.isFinite(parsed) ? parsed : null;
}

function normalize(value) {
  return String(value || '')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .trim();
}

function keyOf(row) {
  return `${row.source}\u0000${row.title}\u0000${row.url || ''}`;
}

const catalogRows = readCsv(CATALOGO);
const productIds = new Map(
  catalogRows.map((row) => [keyOf(row), String(row.product_id || '').trim()])
);

const rows = readCsv(AVALIADOS);
const items = [];
const seen = new Set();
const errors = [];

for (const row of rows) {
  const supplier = SUPPLIERS[row.source];
  if (!supplier) {
    errors.push({ source: row.source, title: row.title, error: 'fornecedor sem mapa' });
    continue;
  }
  const cost = number(row.cost);
  if (!cost || cost <= 0) {
    errors.push({ source: row.source, title: row.title, error: 'custo invalido' });
    continue;
  }
  const productId =
    productIds.get(keyOf(row)) ||
    crypto
      .createHash('sha1')
      .update(`${row.source}|${row.title}|${row.url || ''}`)
      .digest('hex')
      .slice(0, 16);
  const sku = productId;
  const uniqueKey = `${supplier.id}\u0000${sku}`;
  if (seen.has(uniqueKey)) continue;
  seen.add(uniqueKey);

  const stock = number(row.stock);
  const gtin = String(row.gtin || '').replace(/[^0-9]/g, '') || null;
  const matchedId = String(row.matched_id || '').trim() || null;
  const confidence = number(row.confidence);
  items.push({
    fornecedor_id: supplier.id,
    fornecedor_nome: supplier.name,
    catalogo_id: matchedId && matchedId.startsWith('MLB') ? matchedId : null,
    item_id: null,
    sku,
    gtin,
    titulo: row.title || sku,
    custo: cost,
    estoque: stock == null ? 0 : Math.max(Math.trunc(stock), 0),
    peso_kg: number(row.weight),
    altura_cm: null,
    largura_cm: null,
    comprimento_cm: null,
    tara_kg: null,
    categoria: row.category_path || null,
    url: row.url || null,
    preco_mercado: number(row.market_price_calc),
    mercado_min: null,
    mercado_max: null,
    mercado_ofertas: number(row.offers),
    mercado_vendedores: number(row.sellers),
    mercado_confianca: confidence,
    mercado_multiplo: number(row.market_multiple),
    matched_id: matchedId,
    matched_name: row.matched_name || null,
    categoria_ml: row.category_path || null,
    ativo: stock == null ? true : stock > 0,
  });
}

if (!process.env.DATABASE_URL) {
  console.error('DATABASE_URL ausente.');
  process.exit(1);
}

const pool = new pg.Pool({
  connectionString: process.env.DATABASE_URL,
  max: 3,
  connectionTimeoutMillis: 10000,
});

const INSERT = `
INSERT INTO supplier_products
  (fornecedor_id, fornecedor_nome, catalogo_id, item_id, sku, gtin,
   titulo, custo, estoque, peso_kg, altura_cm, largura_cm,
   comprimento_cm, tara_kg, categoria, url, preco_mercado, mercado_min,
   mercado_max, mercado_ofertas, mercado_vendedores, mercado_confianca,
   mercado_multiplo, matched_id, matched_name, categoria_ml, ativo,
   atualizado_em)
SELECT fornecedor_id, fornecedor_nome, catalogo_id, item_id, sku, gtin,
   titulo, custo, estoque, peso_kg, altura_cm, largura_cm,
   comprimento_cm, tara_kg, categoria, url, preco_mercado, mercado_min,
   mercado_max, mercado_ofertas, mercado_vendedores, mercado_confianca,
   mercado_multiplo, matched_id, matched_name, categoria_ml, ativo, NOW()
FROM jsonb_to_recordset($1::jsonb) AS x(
   fornecedor_id text, fornecedor_nome text, catalogo_id text,
   item_id text, sku text, gtin text, titulo text, custo numeric,
   estoque integer, peso_kg numeric, altura_cm numeric,
   largura_cm numeric, comprimento_cm numeric, tara_kg numeric,
   categoria text, url text, preco_mercado numeric, mercado_min numeric,
   mercado_max numeric, mercado_ofertas integer,
   mercado_vendedores integer, mercado_confianca numeric,
   mercado_multiplo numeric, matched_id text, matched_name text,
   categoria_ml text, ativo boolean
)
ON CONFLICT (fornecedor_id, sku) DO UPDATE SET
  fornecedor_nome = EXCLUDED.fornecedor_nome,
  catalogo_id = EXCLUDED.catalogo_id,
  item_id = EXCLUDED.item_id,
  gtin = EXCLUDED.gtin,
  titulo = EXCLUDED.titulo,
  custo = EXCLUDED.custo,
  estoque = EXCLUDED.estoque,
  peso_kg = EXCLUDED.peso_kg,
  altura_cm = EXCLUDED.altura_cm,
  largura_cm = EXCLUDED.largura_cm,
  comprimento_cm = EXCLUDED.comprimento_cm,
  tara_kg = EXCLUDED.tara_kg,
  categoria = EXCLUDED.categoria,
  url = EXCLUDED.url,
  preco_mercado = EXCLUDED.preco_mercado,
  mercado_min = EXCLUDED.mercado_min,
  mercado_max = EXCLUDED.mercado_max,
  mercado_ofertas = EXCLUDED.mercado_ofertas,
  mercado_vendedores = EXCLUDED.mercado_vendedores,
  mercado_confianca = EXCLUDED.mercado_confianca,
  mercado_multiplo = EXCLUDED.mercado_multiplo,
  matched_id = EXCLUDED.matched_id,
  matched_name = EXCLUDED.matched_name,
  categoria_ml = EXCLUDED.categoria_ml,
  ativo = EXCLUDED.ativo,
  atualizado_em = NOW()`;

const client = await pool.connect();
let imported = 0;
try {
  await client.query('BEGIN');
  for (let index = 0; index < items.length; index += 400) {
    const chunk = items.slice(index, index + 400);
    await client.query(INSERT, [JSON.stringify(chunk)]);
    imported += chunk.length;
    process.stdout.write(`\r${imported}/${items.length}`);
  }
  await client.query('COMMIT');
  process.stdout.write('\n');
} catch (error) {
  await client.query('ROLLBACK');
  console.error(error);
  process.exitCode = 1;
} finally {
  client.release();
  await pool.end();
}

console.log(
  JSON.stringify(
    {
      recebidos: rows.length,
      validos: items.length,
      importados: imported,
      ignorados: rows.length - items.length,
      erros: errors.slice(0, 20),
    },
    null,
    2
  )
);
