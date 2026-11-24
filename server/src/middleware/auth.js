import jwt from 'jsonwebtoken';
import { config } from '../config.js';
import { users } from '../repositories/index.js';
import { HttpError } from './errors.js';

export const REFRESH_COOKIE = '__Secure-runut_refresh';
export const LEGACY_REFRESH_COOKIE = 'runut_rt';
export const JWT_ISSUER = 'runut-api';
export const JWT_AUDIENCE = 'runut-web';
export const REFRESH_MAX_AGE_SECONDS = 2592000; // 30 days

export function signAccessToken(user) {
  return jwt.sign(
    { sub: user.id, email: user.email, tv: Number(user.token_version || 0) },
    config.jwt.accessSecret,
    {
      algorithm: 'HS256',
      issuer: JWT_ISSUER,
      audience: JWT_AUDIENCE,
      expiresIn: config.jwt.accessTtl,
    },
  );
}

// Refresh token disimpan di cookie HttpOnly persisten (__Secure-runut_refresh),
// bukan di localStorage/sessionStorage, sehingga JavaScript tidak dapat membacanya.
// Melalui same-origin API proxy Cloudflare Pages (/api/*), cookie memakai SameSite=Lax,
// Secure, HttpOnly, Path=/api/auth, Max-Age=2592000 + Expires, tanpa atribut Domain.
export function resolveRefreshCookieOptions(env = process.env) {
  const rawSameSite = String(env.COOKIE_SAME_SITE || 'lax').trim().toLowerCase();
  const sameSite = ['lax', 'none', 'strict'].includes(rawSameSite) ? rawSameSite : 'lax';
  const explicitSecure = String(env.COOKIE_SECURE || '').trim().toLowerCase();
  const isProd = (env.NODE_ENV || config.env) === 'production';
  const secure = explicitSecure === 'true'
    ? true
    : (explicitSecure === 'false' && sameSite !== 'none' ? false : (sameSite === 'none' || isProd));
  return {
    httpOnly: true,
    sameSite,
    secure,
    path: '/api/auth',
  };
}

export function setRefreshCookie(res, token, env = process.env) {
  const maxAgeSeconds = Math.max(60, Number(config.jwt.refreshDays || 30) * 24 * 3600);
  const maxAgeMs = maxAgeSeconds * 1000;
  const expires = new Date(Date.now() + maxAgeMs);
  res.cookie(REFRESH_COOKIE, token, {
    ...resolveRefreshCookieOptions(env),
    maxAge: maxAgeMs,
    expires,
  });
}

export function clearRefreshCookie(res, env = process.env) {
  const opts = resolveRefreshCookieOptions(env);
  res.clearCookie(REFRESH_COOKIE, opts);
  res.clearCookie(LEGACY_REFRESH_COOKIE, opts);
}

export function readRefreshToken(req) {
  return (req.cookies && (req.cookies[REFRESH_COOKIE] || req.cookies[LEGACY_REFRESH_COOKIE])) || null;
}

export async function requireAuth(req, _res, next) {
  try {
    const header = req.headers.authorization || '';
    const [scheme, token] = header.split(' ');
    if (scheme !== 'Bearer' || !token) throw new HttpError(401, 'Token akses tidak ditemukan. Silakan masuk kembali.', { code: 'NO_TOKEN' });
    let payload;
    try {
      payload = jwt.verify(token, config.jwt.accessSecret, {
        algorithms: ['HS256'],
        issuer: JWT_ISSUER,
        audience: JWT_AUDIENCE,
      });
    } catch {
      throw new HttpError(401, 'Sesi kedaluwarsa atau tidak valid. Silakan masuk kembali.', { code: 'INVALID_TOKEN' });
    }
    const user = await users.findById(payload.sub);
    if (!user) throw new HttpError(401, 'Akun tidak ditemukan.', { code: 'NO_USER' });
    if (Number(payload.tv || 0) !== Number(user.token_version || 0)) {
      throw new HttpError(401, 'Sesi sudah tidak berlaku. Silakan masuk kembali.', { code: 'TOKEN_REVOKED' });
    }
    user.token_balance = Math.max(0, Number(user.token_balance) || 0);
    req.user = user;
    next();
  } catch (err) {
    next(err);
  }
}
