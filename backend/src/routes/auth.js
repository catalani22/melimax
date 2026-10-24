import express from 'express';
import crypto from 'node:crypto';
import fetch from 'node-fetch';
import rateLimit from 'express-rate-limit';
import { query } from '../lib/db.js';
import { getAccount } from '../lib/ml.js';
import { FRONTEND_URL, REDIRECT_URI, frontendUrl } from '../lib/config.js';
import {
  dashboardProtectionEnabled,
  verifyDashboardKey,
} from '../middleware/dashboard-auth.js';

const router = express.Router();

const ML_APP_ID = process.env.ML_APP_ID;
const ML_CLIENT_SECRET = process.env.ML_CLIENT_SECRET;
const STATE_TTL_MS = 10 * 60 * 1000;

const painelLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 10,
  skipSuccessfulRequests: true,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Muitas tentativas de senha. Aguarde 15 minutos.' },
});

router.get('/painel', (req, res) => {
  res.json({ protected: dashboardProtectionEnabled() });
});

router.post('/painel', painelLimiter, (req, res) => {
  if (!dashboardProtectionEnabled()) {
    return res.json({ ok: true, protected: false });
  }
  const { password } = req.body || {};
  if (!verifyDashboardKey(password)) {
    return res.status(401).json({
      error: 'Senha do painel inválida.',
      code: 'DASHBOARD_LOCKED',
    });
  }
  return res.json({ ok: true, protected: true });
});

function buildAuthUrl() {
  if (!ML_APP_ID || !ML_CLIENT_SECRET) {
    throw new Error('ML_APP_ID/ML_CLIENT_SECRET nao configurados no backend.');
  }
  const params = new URLSearchParams({
    response_type: 'code',
    client_id: ML_APP_ID,
    redirect_uri: REDIRECT_URI,
    scope: 'offline_access read write',
    state: signState(),
  });
  return `https://auth.mercadolivre.com.br/authorization?${params.toString()}`;
}

function signState() {
  const payload = `${Date.now()}.${crypto.randomBytes(16).toString('hex')}`;
  const signature = crypto
    .createHmac('sha256', ML_CLIENT_SECRET || '')
    .update(payload)
    .digest('base64url');
  return `${payload}.${signature}`;
}

function verifyState(state) {
  if (!state || !ML_CLIENT_SECRET) return false;
  const parts = String(state).split('.');
  if (parts.length !== 3) return false;
  const [timestamp, nonce, signature] = parts;
  const expected = crypto
    .createHmac('sha256', ML_CLIENT_SECRET)
    .update(`${timestamp}.${nonce}`)
    .digest('base64url');
  const a = Buffer.from(signature);
  const b = Buffer.from(expected);
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return false;
  return Date.now() - Number(timestamp) < STATE_TTL_MS;
}

function redirectError(res, message) {
  return res.redirect(frontendUrl('/', { ml_error: String(message).slice(0, 300) }));
}

function redirectConnected(res) {
  return res.redirect(frontendUrl('/', { ml_connected: '1' }));
}

async function exchangeCode(code) {
  const body = new URLSearchParams({
    grant_type: 'authorization_code',
    client_id: ML_APP_ID,
    client_secret: ML_CLIENT_SECRET,
    code,
    redirect_uri: REDIRECT_URI,
  });

  const res = await fetch('https://api.mercadolibre.com/oauth/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body,
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok || !data.access_token) {
    const message = data.message || data.error_description || data.error || 'Falha ao trocar o code por token';
    throw new Error(message);
  }
  return data;
}

router.get(['/login', '/ml/login'], (req, res, next) => {
  try {
    res.set('Cache-Control', 'no-store');
    res.redirect(buildAuthUrl());
  } catch (err) {
    next(err);
  }
});

router.get(['/ml/url', '/login-url'], (req, res, next) => {
  try {
    res.set('Cache-Control', 'no-store');
    res.json({ url: buildAuthUrl() });
  } catch (err) {
    next(err);
  }
});

const callbackHandler = async (req, res) => {
  const { code, state, error, error_description } = req.query;

  if (error) {
    return redirectError(res, error_description || error);
  }
  if (!code) {
    return redirectError(res, 'Codigo de autorizacao ausente.');
  }
  if (!verifyState(state)) {
    return redirectError(res, 'State invalido ou expirado. Tente conectar novamente.');
  }

  try {
    const token = await exchangeCode(code);

    let nickname = token.nickname || null;
    try {
      const userRes = await fetch(`https://api.mercadolibre.com/users/${token.user_id}`, {
        headers: { Authorization: `Bearer ${token.access_token}` },
      });
      if (userRes.ok) {
        const user = await userRes.json();
        nickname = user.nickname || nickname;
      }
    } catch {}

    const expiresIn = Number(token.expires_in) || 21600;
    const expiresAt = new Date(Date.now() + expiresIn * 1000).toISOString();

    await query(
      `INSERT INTO ml_accounts
         (user_id, nickname, access_token, refresh_token, expires_in, expires_at, scope, updated_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,NOW())
       ON CONFLICT (user_id) DO UPDATE SET
         nickname = EXCLUDED.nickname,
         access_token = EXCLUDED.access_token,
         refresh_token = EXCLUDED.refresh_token,
         expires_in = EXCLUDED.expires_in,
         expires_at = EXCLUDED.expires_at,
         scope = EXCLUDED.scope,
         updated_at = NOW()`,
      [
        token.user_id,
        nickname,
        token.access_token,
        token.refresh_token,
        expiresIn,
        expiresAt,
        token.scope || null,
      ]
    );

    return redirectConnected(res);
  } catch (err) {
    console.error('[auth] callback error:', err.message);
    return redirectError(res, err.message);
  }
};

router.get('/callback', callbackHandler);
router.get('/ml/callback', callbackHandler);

router.get('/me', async (req, res, next) => {
  try {
    const account = await getAccount();
    if (!account) {
      return res.json({ connected: false });
    }
    res.json({
      connected: true,
      user_id: String(account.user_id),
      nickname: account.nickname || `Usuario ${account.user_id}`,
      expires_at: account.expires_at || null,
      needs_reauth: Boolean(account.needs_reauth),
    });
  } catch (err) {
    next(err);
  }
});

router.post('/logout', async (req, res, next) => {
  try {
    await query('DELETE FROM ml_accounts');
    res.json({ ok: true });
  } catch (err) {
    next(err);
  }
});

router.get('/config', (req, res) => {
  res.json({
    configured: Boolean(ML_APP_ID && ML_CLIENT_SECRET),
    redirect_uri: REDIRECT_URI,
    frontend_url: FRONTEND_URL,
  });
});

export default router;
