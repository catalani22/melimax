import express from 'express';
import fetch from 'node-fetch';
import { query, memPush } from './db.js';

const router = express.Router();

async function getToken() {
  const rows = (await query('SELECT access_token FROM ml_accounts ORDER BY updated_at DESC LIMIT 1')).rows;
  return rows[0];
}

router.get('/', async (req, res) => {
  const t = await getToken();
  if (!t) return res.status(401).json({ error: 'Conta ML nao conectada' });

  const resp = await fetch('https://api.mercadolibre.com/users/me', {
    headers: { Authorization: `Bearer ${t.access_token}` },
  });
  const data = await resp.json();
  res.json(data);
});

router.get('/categories', async (req, res) => {
  const t = await getToken();
  if (!t) return res.status(401).json({ error: 'Conta ML nao conectada' });
  const resp = await fetch('https://api.mercadolibre.com/sites/MLB/categories', {
    headers: { Authorization: `Bearer ${t.access_token}` },
  });
  const data = await resp.json();
  res.json(data.slice(0, 50));
});

router.get('/items/:id', async (req, res) => {
  const t = await getToken();
  if (!t) return res.status(401).json({ error: 'Conta ML nao conectada' });
  const resp = await fetch(`https://api.mercadolibre.com/items/${req.params.id}`, {
    headers: { Authorization: `Bearer ${t.access_token}` },
  });
  const data = await resp.json();
  res.json(data);
});

export default router;
