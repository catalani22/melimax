import { query } from './db.js';

export async function findSupplierCost({
  catalogoId,
  itemId,
  gtin,
  fornecedorId,
}) {
  const filters = [];
  const params = [];

  if (fornecedorId) {
    params.push(String(fornecedorId));
    filters.push(`fornecedor_id = $${params.length}`);
  }

  const matches = [];
  if (catalogoId) {
    params.push(String(catalogoId));
    matches.push(`catalogo_id = $${params.length}`);
  }
  if (itemId) {
    params.push(String(itemId));
    matches.push(`item_id = $${params.length}`);
  }
  if (gtin) {
    params.push(String(gtin));
    matches.push(`gtin = $${params.length}`);
  }

  if (!matches.length) return null;

  const where = [
    ...filters,
    `(${matches.join(' OR ')})`,
    'ativo = TRUE',
    'estoque > 0',
  ].join(' AND ');

  const { rows } = await query(
    `SELECT * FROM supplier_products
     WHERE ${where}
     ORDER BY custo ASC
     LIMIT 1`,
    params
  );

  return rows[0] || null;
}
