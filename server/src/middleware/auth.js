import jwt from 'jsonwebtoken';
import { config } from '../config.js';
import { users } from '../repositories/index.js';
import { HttpError } from './errors.js';

export const REFRESH_COOKIE = 'runut_rt';

export function signAccessToken(user) {
  return jwt.sign(
    { sub: user.id, email: user.email },
    config.jwt.accessSecret,
    { expiresIn: config.jwt.accessTtl },
  );
}

// Refresh token disimpan di cookie HttpOnly, bukan di localStorage, sehingga
// JavaScript halaman tidak dapat membacanya.
export function setRefreshCookie(res, token) {
  res.cookie(REFRESH_COOKIE, token, {
    httpOnly: true,
    sameSite: 'lax',
    secure: config.env === 'production',
    path: '/api/auth',
    maxAge: config.jwt.refreshDays * 24 * 3600 * 1000,
  });
}

export function clearRefreshCookie(res) {
  res.clearCookie(REFRESH_COOKIE, { path: '/api/auth' });
}

export function readRefreshToken(req) {
  return (req.cookies && req.cookies[REFRESH_COOKIE]) || null;
}

export async function requireAuth(req, _res, next) {
  try {
    const header = req.headers.authorization || '';
    const [scheme, token] = header.split(' ');
    if (scheme !== 'Bearer' || !token) throw new HttpError(401, 'Token akses tidak ditemukan. Silakan masuk kembali.', { code: 'NO_TOKEN' });
    let payload;
    try {
      payload = jwt.verify(token, config.jwt.accessSecret);
    } catch {
      throw new HttpError(401, 'Sesi kedaluwarsa atau tidak valid. Silakan masuk kembali.', { code: 'INVALID_TOKEN' });
    }
    const user = await users.findById(payload.sub);
    if (!user) throw new HttpError(401, 'Akun tidak ditemukan.', { code: 'NO_USER' });
    user.token_balance = Math.max(0, Number(user.token_balance) || 0);
    req.user = user;
    next();
  } catch (err) {
    next(err);
  }
}
