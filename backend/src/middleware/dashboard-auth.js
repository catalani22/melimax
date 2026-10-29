import crypto from 'node:crypto';
import { dashboardUserCount, query } from '../lib/db.js';
import { verifySession } from '../lib/session.js';

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

function authExplicitlyEnabled() {
  return String(process.env.DASHBOARD_AUTH_ENABLED || '').toLowerCase() === 'true';
}

function authDisabled() {
  if (!authExplicitlyEnabled()) return true;
  return String(process.env.DASHBOARD_AUTH_DISABLED || '').toLowerCase() === 'true';
}

export async function dashboardProtectionEnabled() {
  if (authDisabled()) return false;
  if (dashboardPassword()) return true;
  return (await dashboardUserCount()) > 0;
}

export function verifyDashboardKey(candidate) {
  const password = dashboardPassword();
  if (!password) return false;
  if (!candidate) return false;
  return safeEqual(String(candidate).trim(), password);
}

function extractKey(req) {
  return (
    req.get('x-dashboard-key') ||
    (req.get('authorization') || '').replace(/^Bearer\s+/i, '')
  );
}

let warnedOpen = false;

export async function dashboardAuth(req, res, next) {
  if (PUBLIC_PATHS.has(req.path)) return next();
  if (authDisabled()) return next();

  try {
    const enabled = await dashboardProtectionEnabled();
    if (!enabled) {
      if (!warnedOpen) {
        console.warn('[auth] DASHBOARD_PASSWORD ausente: painel sem protecao.');
        warnedOpen = true;
      }
      return next();
    }

    const key = extractKey(req);

    if (key?.startsWith('v1.')) {
      const payload = verifySession(key);
      if (payload) {
        if (payload.uid === 0) {
          const count = await dashboardUserCount();
          if (count === 0) {
            req.dashboardUser = {
              id: 0,
              username: 'admin',
              name: 'Administrador',
              role: 'admin',
              active: true,
              legacy: true,
            };
            return next();
          }
        } else {
          const { rows } = await query(
            `SELECT id, username, name, role, active, token_version
             FROM dashboard_users
             WHERE id = $1
             LIMIT 1`,
            [payload.uid]
          );
          const user = rows[0];
          if (
            user &&
            user.active &&
            Number(user.token_version) === Number(payload.tv)
          ) {
            req.dashboardUser = {
              id: user.id,
              username: user.username,
              name: user.name,
              role: user.role,
              active: true,
              legacy: false,
            };
            return next();
          }
        }
      }
      return res.status(401).json({
        error: 'Sessão expirada. Informe a senha novamente.',
        code: 'DASHBOARD_LOCKED',
      });
    }

    const count = await dashboardUserCount();
    if (count === 0 && verifyDashboardKey(key)) {
      req.dashboardUser = {
        id: 0,
        username: 'admin',
        name: 'Administrador',
        role: 'admin',
        active: true,
        legacy: true,
      };
      return next();
    }

    return res.status(401).json({
      error: 'Painel bloqueado. Informe a senha de acesso.',
      code: 'DASHBOARD_LOCKED',
    });
  } catch (err) {
    return next(err);
  }
}
