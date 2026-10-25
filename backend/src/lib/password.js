import crypto from 'node:crypto';

const KEY_LENGTH = 64;

export function normalizePassword(value) {
  return String(value ?? '')
    .normalize('NFKC')
    .trim();
}

export function hashPassword(value) {
  const password = normalizePassword(value);
  if (!password) throw new Error('Senha vazia.');
  const salt = crypto.randomBytes(16).toString('base64url');
  const hash = crypto.scryptSync(password, salt, KEY_LENGTH).toString('base64url');
  return `scrypt$${salt}$${hash}`;
}

export function verifyPassword(value, stored) {
  const password = normalizePassword(value);
  if (!password || !stored) return false;
  const parts = String(stored).split('$');
  if (parts.length !== 3 || parts[0] !== 'scrypt') return false;
  const [, salt, expected] = parts;
  try {
    const actual = crypto.scryptSync(password, salt, KEY_LENGTH);
    const expectedBuffer = Buffer.from(expected, 'base64url');
    if (actual.length !== expectedBuffer.length) return false;
    return crypto.timingSafeEqual(actual, expectedBuffer);
  } catch {
    return false;
  }
}
