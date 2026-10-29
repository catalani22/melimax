function firstHttpUrl(value, fallback) {
  if (!value) return fallback;
  const candidate = String(value)
    .split(',')
    .map((item) => item.trim())
    .find((item) => item.startsWith('http://') || item.startsWith('https://'));
  return (candidate || fallback).replace(/\/+$/, '');
}

function nonLocalIfAppUrl(value) {
  if (!value) return '';
  if (process.env.APP_URL && /^http:\/\/(localhost|127\.0\.0\.1)(:\d+)?(\/|$)/i.test(String(value).trim())) {
    return '';
  }
  return value;
}

export const FRONTEND_URL = firstHttpUrl(
  nonLocalIfAppUrl(process.env.FRONTEND_URL) || process.env.APP_URL || process.env.CORS_ORIGIN,
  'http://localhost:3000'
);

const VERCEL_BACKEND_URL = process.env.VERCEL_PROJECT_PRODUCTION_URL
  ? `https://${process.env.VERCEL_PROJECT_PRODUCTION_URL}`
  : null;

export const BACKEND_URL = firstHttpUrl(
  nonLocalIfAppUrl(process.env.BACKEND_URL) || process.env.APP_URL || VERCEL_BACKEND_URL,
  'http://localhost:3000'
);

export const REDIRECT_URI =
  nonLocalIfAppUrl(process.env.ML_REDIRECT_URI) || `${BACKEND_URL}/api/auth/callback`;

export const CORS_ORIGINS = Array.from(
  new Set([
    FRONTEND_URL,
    ...(process.env.CORS_ORIGIN || '')
      .split(',')
      .map((item) => item.trim())
      .filter((item) => item.startsWith('http://') || item.startsWith('https://')),
  ])
);

export function frontendUrl(path = '/', params = {}) {
  const url = new URL(path, `${FRONTEND_URL}/`);
  for (const [key, value] of Object.entries(params)) {
    if (value !== undefined && value !== null && value !== '') {
      url.searchParams.set(key, String(value));
    }
  }
  return url.toString();
}
