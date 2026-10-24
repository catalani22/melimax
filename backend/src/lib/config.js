function firstHttpUrl(value, fallback) {
  if (!value) return fallback;
  const candidate = String(value)
    .split(',')
    .map((item) => item.trim())
    .find((item) => item.startsWith('http://') || item.startsWith('https://'));
  return (candidate || fallback).replace(/\/+$/, '');
}

export const FRONTEND_URL = firstHttpUrl(
  process.env.FRONTEND_URL || process.env.CORS_ORIGIN,
  'http://localhost:5173'
);

const VERCEL_BACKEND_URL = process.env.VERCEL_PROJECT_PRODUCTION_URL
  ? `https://${process.env.VERCEL_PROJECT_PRODUCTION_URL}`
  : null;

export const BACKEND_URL = firstHttpUrl(
  process.env.BACKEND_URL || VERCEL_BACKEND_URL,
  'http://localhost:3001'
);

export const REDIRECT_URI =
  process.env.ML_REDIRECT_URI || `${BACKEND_URL}/api/auth/callback`;

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
