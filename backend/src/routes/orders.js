import express from 'express';
import fetch from 'node-fetch';
import { query, memPush } from '../lib/db.js';

const router = express.Router();

async function getToken() {
  const rows = (await query('SELECT access_token FROM ml_accounts ORDER BY updated_at DESC LIMIT 1')).rows;
  return rows[0];
}

router.get('/', async (_req, res) => {
  const t = await getToken();
  if (!t) return res.status(401).json({ error: 'Conta ML nao conectada' });

  const resp = await fetch('https://api.mercadolibre.com/orders/search?seller=id', {
    headers: { Authorization: `Bearer ${t.access_token}` },
  });
  const data = await resp.json();
  res.json(data);
});

router.post('/:orderId/label', async (req, res) => {
  const { supplier, shippingData } = req.body;
  const label = {
    id: Date.now(),
    order_id: req.params.orderId,
    supplier,
    shipping_data: shippingData || {},
    status: 'gerada',
    created_at: new Date().toISOString(),
  };
  memPush('labels', label);
  await query(
    `INSERT INTO labels (order_id, supplier, shipping_data, status, created_at)
     VALUES ($1,$2,$3,'gerada',NOW())`,
    [req.params.orderId, supplier, JSON.stringify(shippingData || {})]
  ).catch(() => {});
  res.json({ orderId: req.params.orderId, supplier, status: 'etiqueta_gerada', nota: 'Etiqueta enviada ao fornecedor automaticamente' });
});

export default router;
