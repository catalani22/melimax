import express from 'express';
import querystring from 'node:querystring';
import fetch from 'node-fetch';
import { query, memPush, memFind } from './db.js';

const router = express.Router();

const APP_ID = process.env.ML_APP_ID;
const CLIENT_SECRET = process.env.ML_CLIENT_SECRET;
const REDIRECT_URI = process.env.ML_REDIRECT_URI;

router.get('/login', (req, res) => {
  const params = querystring.stringify({
    response_type: 'code',
    client_id: APP_ID,
    redirect_uri: REDIRECT_URI,
    scope: 'read write',
  });
  res.redirect(`https://auth.mercadolivre.com.br/authorization?${params}`);
});

router.get('/callback', async (req, res) => {
  const { code } = req.query;
  if (!code) return res.status(400).json({ error: 'code nao fornecido' });

  try {
    const tokenRes = await fetch('https://api.mercadolibre.com/oauth/token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: querystring.stringify({
        grant_type: 'authorization_code',
        client_id: APP_ID,
        client_secret: CLIENT_SECRET,
        code,
        redirect_uri: REDIRECT_URI,
      }),
    });
    const data = await tokenRes.json();
    if (!tokenRes.ok) return res.status(400).json({ error: data });

    const account = {
      id: Date.now(),
      user_id: data.user_id,
      nickname: data.nickname,
      access_token: data.access_token,
      refresh_token: data.refresh_token,
      expires_in: data.expires_in,
      updated_at: new Date().toISOString(),
    };
    const existing = memFind('accounts', a => a.user_id === data.user_id);
    if (existing) Object.assign(existing, account);
    else memPush('accounts', account);

    await query(
      `INSERT INTO ml_accounts (user_id, nickname, access_token, refresh_token, expires_in, updated_at)
       VALUES ($1,$2,$3,$4,$5,NOW()) ON CONFLICT (user_id) DO UPDATE SET access_token=EXCLUDED.access_token, refresh_token=EXCLUDED.refresh_token, expires_in=EXCLUDED.expires_in, updated_at=NOW()`,
      [data.user_id, data.nickname, data.access_token, data.refresh_token, data.expires_in]
    ).catch(() => {});

    res.redirect(`${process.env.CORS_ORIGIN || 'http://localhost:5173'}/dashboard?ml_connected=1&user_id=${data.user_id}`);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

router.get('/me', async (req, res) => {
  const rows = (await query('SELECT user_id, nickname, updated_at FROM ml_accounts ORDER BY updated_at DESC LIMIT 1')).rows;
  const acc = rows[0] || (mem('accounts').slice(-1)[0] || null);
  res.json(acc || { connected: false });
});

export default router;
