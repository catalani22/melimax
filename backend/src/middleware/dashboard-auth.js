import crypto from 'node:crypto';

const PUBLIC_PATHS = new Set([
  '/health',
  '/auth/painel',
  '/auth/callback',
  '/auth/ml/callback',
  '/trends/cron',
]);

function dashboardPassword() {
  return process.env.DASHBOARD_PASSWORD || process.env.DASHBOARD_KEY || '';
}

function safeEqual(a, b) {
  const hashA = crypto.createHash('sha256').update(String(a)).digest();
  const hashB = crypto.createHash('sha256').update(String(b)).digest();
  return crypto.timingSafeEqual(hashA, hashB);
}

export function dashboardProtectionEnabled() {
  return Boolean(dashboardPassword());
}

export function verifyDashboardKey(candidate) {
  const password = dashboardPassword();
  if (!password) return true;
  if (!candidate) return false;
  return safeEqual(candidate, password);
}

let warnedOpen = false;

export function dashboardAuth(req, res, next) {
  if (PUBLIC_PATHS.has(req.path)) return next();

  if (!dashboardProtectionEnabled()) {
    if (!warnedOpen) {
      console.warn('[auth] DASHBOARD_PASSWORD ausente: painel sem protecao.');
      warnedOpen = true;
    }
    return next();
  }

  const key =
    req.get('x-dashboard-key') ||
    (req.get('authorization') || '').replace(/^Bearer\s+/i, '');

  if (!verifyDashboardKey(key)) {
    return res.status(401).json({
      error: 'Painel bloqueado. Informe a senha de acesso.',
      code: 'DASHBOARD_LOCKED',
    });
  }

  return next();
}
