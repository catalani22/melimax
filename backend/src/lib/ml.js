import fetch from 'node-fetch';
import { query } from './db.js';

export const ML_API = 'https://api.mercadolibre.com';
export const ML_AUTH_URL = 'https://auth.mercadolivre.com.br/authorization';
const TOKEN_URL = `${ML_API}/oauth/token`;

const CLIENT_ID = process.env.ML_APP_ID;
const CLIENT_SECRET = process.env.ML_CLIENT_SECRET;

let refreshInFlight = null;

export function mlConfigured() {
  return Boolean(CLIENT_ID && CLIENT_SECRET);
}

function expiryMs(account) {
  if (account.expires_at) return new Date(account.expires_at).getTime();
  const base = account.updated_at ? new Date(account.updated_at).getTime() : Date.now();
  return base + (Number(account.expires_in) || 0) * 1000;
}

export async function getAccount({ forceRefresh = false } = {}) {
  const { rows } = await query(
    'SELECT * FROM ml_accounts ORDER BY updated_at DESC LIMIT 1'
  );
  const account = rows[0];
  if (!account) return null;

  const needsRefresh = forceRefresh || expiryMs(account) - Date.now() < 60_000;
  if (!needsRefresh) return account;

  const refreshed = await refreshAccount(account);
  if (refreshed) return refreshed;

  return { ...account, needs_reauth: true };
}

export async function refreshAccount(account) {
  if (!account?.refresh_token) return null;
  if (!mlConfigured()) {
    console.error('[ml] ML_APP_ID/ML_CLIENT_SECRET ausentes: nao e possivel renovar o token');
    return null;
  }

  if (refreshInFlight) return refreshInFlight;

  refreshInFlight = (async () => {
    try {
      const body = new URLSearchParams({
        grant_type: 'refresh_token',
        client_id: CLIENT_ID,
        client_secret: CLIENT_SECRET,
        refresh_token: account.refresh_token,
      });

      const res = await fetch(TOKEN_URL, {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body,
      });
      const data = await res.json().catch(() => ({}));

      if (!res.ok || !data.access_token) {
        console.error('[ml] falha ao renovar token:', res.status, data.message || data.error || '');
        return null;
      }

      const expiresIn = Number(data.expires_in) || 21600;
      const expiresAt = new Date(Date.now() + expiresIn * 1000).toISOString();
      const refreshToken = data.refresh_token || account.refresh_token;

      await query(
        `UPDATE ml_accounts
            SET access_token = $1,
                refresh_token = $2,
                expires_in = $3,
                expires_at = $4,
                scope = $5,
                updated_at = NOW()
          WHERE user_id = $6`,
        [data.access_token, refreshToken, expiresIn, expiresAt, data.scope || account.scope || null, account.user_id]
      );

      return {
        ...account,
        access_token: data.access_token,
        refresh_token: refreshToken,
        expires_in: expiresIn,
        expires_at: expiresAt,
        scope: data.scope || account.scope,
        needs_reauth: false,
      };
    } catch (err) {
      console.error('[ml] erro ao renovar token:', err.message);
      return null;
    } finally {
      refreshInFlight = null;
    }
  })();

  return refreshInFlight;
}

function mlError(status, data) {
  const message =
    data?.message ||
    data?.error_description ||
    data?.error ||
    `Mercado Livre respondeu ${status}`;
  const err = new Error(message);
  err.status = status;
  err.code = data?.code || data?.error;
  err.details = data;
  return err;
}

async function buildHeaders(accessToken, body, extra) {
  const headers = { Authorization: `Bearer ${accessToken}`, ...extra };
  if (body !== undefined && !(body instanceof Buffer)) {
    headers['Content-Type'] = 'application/json';
  }
  return headers;
}

async function rawRequest(path, { method = 'GET', body, headers } = {}) {
  const account = await getAccount();
  if (!account) {
    const err = new Error('Conta Mercado Livre nao conectada.');
    err.status = 401;
    err.code = 'ML_NOT_CONNECTED';
    throw err;
  }
  if (account.needs_reauth) {
    const err = new Error('Sessao do Mercado Livre expirada. Reconecte sua conta.');
    err.status = 401;
    err.code = 'ML_REAUTH';
    throw err;
  }

  const url = path.startsWith('http') ? path : `${ML_API}${path}`;
  const res = await fetch(url, {
    method,
    headers: await buildHeaders(account.access_token, body, headers),
    body: body === undefined ? undefined : body instanceof Buffer ? body : JSON.stringify(body),
  });

  if (res.status === 401) {
    const refreshed = await refreshAccount(account);
    if (refreshed) {
      return fetch(url, {
        method,
        headers: await buildHeaders(refreshed.access_token, body, headers),
        body: body === undefined ? undefined : body instanceof Buffer ? body : JSON.stringify(body),
      });
    }
  }

  return res;
}

export async function mlFetch(path, options = {}) {
  const res = await rawRequest(path, options);
  const text = await res.text();
  let data = null;
  if (text) {
    try {
      data = JSON.parse(text);
    } catch {
      data = text;
    }
  }
  if (!res.ok) throw mlError(res.status, data);
  return data;
}

export async function mlFetchRaw(path, options = {}) {
  const res = await rawRequest(path, options);
  if (!res.ok) {
    const text = await res.text();
    let data = text;
    try {
      data = JSON.parse(text);
    } catch {}
    throw mlError(res.status, data);
  }
  return {
    buffer: Buffer.from(await res.arrayBuffer()),
    contentType: res.headers.get('content-type') || 'application/octet-stream',
    disposition: res.headers.get('content-disposition') || null,
  };
}

export async function getUser(userId) {
  return mlFetch(`/users/${userId}`);
}

export async function getUserId(account) {
  if (account?.user_id) return account.user_id;
  const me = await mlFetch('/users/me');
  return me.id;
}
