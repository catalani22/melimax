import crypto from 'node:crypto';

const TOKEN_TTL_SECONDS = 7 * 24 * 60 * 60;

function sessionSecret() {
  return (
    process.env.DASHBOARD_SESSION_SECRET ||
    process.env.DASHBOARD_PASSWORD ||
    process.env.CRON_SECRET ||
    'melimax-local-session'
  );
}

function signature(payload) {
  return crypto
    .createHmac('sha256', sessionSecret())
    .update(payload)
    .digest('base64url');
}

export function signSession(user) {
  const now = Math.floor(Date.now() / 1000);
  const payload = Buffer.from(
    JSON.stringify({
      uid: Number(user.id) || 0,
      username: user.username,
      role: user.role,
      tv: Number(user.token_version) || 0,
      iat: now,
      exp: now + TOKEN_TTL_SECONDS,
    })
  ).toString('base64url');
  return `v1.${payload}.${signature(payload)}`;
}

export function verifySession(token) {
  if (!token || typeof token !== 'string') return null;
  const parts = token.split('.');
  if (parts.length !== 3 || parts[0] !== 'v1') return null;
  const [, payload, received] = parts;
  const expected = signature(payload);
  const a = Buffer.from(received);
  const b = Buffer.from(expected);
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return null;
  try {
    const data = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8'));
    if (!data?.exp || data.exp < Math.floor(Date.now() / 1000)) return null;
    return data;
  } catch {
    return null;
  }
}
