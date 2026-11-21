import crypto from 'node:crypto';
import { HttpError } from '../middleware/errors.js';

const GOOGLE_ISSUERS = new Set(['accounts.google.com', 'https://accounts.google.com']);
const GOOGLE_JWKS_URL = 'https://www.googleapis.com/oauth2/v3/certs';
const DEFAULT_JWKS_TTL_MS = 60 * 60 * 1000;
const CLOCK_SKEW_MS = 30 * 1000;

let customVerifier = null;
let jwksCache = { keys: null, expiresAt: 0 };

export function setGoogleTokenVerifier(fn) {
  customVerifier = typeof fn === 'function' ? fn : null;
}

export function clearGoogleJwksCache() {
  jwksCache = { keys: null, expiresAt: 0 };
}

function decodeBase64UrlJson(segment) {
  try {
    const json = Buffer.from(segment, 'base64url').toString('utf8');
    const parsed = JSON.parse(json);
    return parsed && typeof parsed === 'object' ? parsed : null;
  } catch {
    return null;
  }
}

function parseMaxAgeMs(cacheControl) {
  const match = String(cacheControl || '').match(/max-age=(\d+)/i);
  if (!match) return DEFAULT_JWKS_TTL_MS;
  const seconds = Number(match[1]);
  if (!Number.isFinite(seconds) || seconds <= 0) return DEFAULT_JWKS_TTL_MS;
  return Math.min(seconds * 1000, 24 * 60 * 60 * 1000);
}

async function fetchGoogleJwks(forceRefresh = false) {
  if (!forceRefresh && jwksCache.keys && Date.now() < jwksCache.expiresAt) {
    return jwksCache.keys;
  }
  let res;
  try {
    res = await fetch(GOOGLE_JWKS_URL, { signal: AbortSignal.timeout(8000) });
  } catch {
    if (jwksCache.keys) return jwksCache.keys;
    throw new HttpError(502, 'Gagal menghubungi layanan kunci publik Google.', { code: 'GOOGLE_VERIFY_UNREACHABLE' });
  }
  if (!res.ok) {
    if (jwksCache.keys) return jwksCache.keys;
    throw new HttpError(502, 'Layanan kunci publik Google sedang bermasalah.', { code: 'GOOGLE_VERIFY_UNREACHABLE' });
  }
  const body = await res.json().catch(() => null);
  const keys = Array.isArray(body?.keys) ? body.keys : null;
  if (!keys || !keys.length) {
    throw new HttpError(502, 'Respons kunci publik Google tidak valid.', { code: 'GOOGLE_VERIFY_UNREACHABLE' });
  }
  jwksCache = {
    keys,
    expiresAt: Date.now() + parseMaxAgeMs(res.headers.get('cache-control')),
  };
  return keys;
}

async function verifyJwtWithGoogleJwks(token) {
  const parts = token.split('.');
  if (parts.length !== 3 || parts.some((p) => !p)) {
    throw new HttpError(401, 'Format token Google tidak valid.', { code: 'GOOGLE_TOKEN_INVALID' });
  }
  const [headerB64, payloadB64, sigB64] = parts;
  const header = decodeBase64UrlJson(headerB64);
  const payload = decodeBase64UrlJson(payloadB64);
  if (!header || !payload || header.alg !== 'RS256' || typeof header.kid !== 'string' || !header.kid) {
    throw new HttpError(401, 'Header token Google tidak valid.', { code: 'GOOGLE_TOKEN_INVALID' });
  }

  let keys = await fetchGoogleJwks(false);
  let jwk = keys.find((k) => k.kid === header.kid && k.kty === 'RSA');
  if (!jwk) {
    // Kunci Google bisa berotasi: segarkan cache sekali bila kid belum ditemukan.
    keys = await fetchGoogleJwks(true);
    jwk = keys.find((k) => k.kid === header.kid && k.kty === 'RSA');
  }
  if (!jwk) {
    throw new HttpError(401, 'Kunci tanda tangan token Google tidak dikenal.', { code: 'GOOGLE_TOKEN_INVALID' });
  }

  let signature;
  let publicKey;
  try {
    signature = Buffer.from(sigB64, 'base64url');
    publicKey = crypto.createPublicKey({ key: jwk, format: 'jwk' });
  } catch {
    throw new HttpError(401, 'Token Google tidak valid.', { code: 'GOOGLE_TOKEN_INVALID' });
  }

  const signingInput = Buffer.from(`${headerB64}.${payloadB64}`, 'utf8');
  const validSig = crypto.verify('RSA-SHA256', signingInput, publicKey, signature);
  if (!validSig) {
    throw new HttpError(401, 'Tanda tangan token Google tidak valid.', { code: 'GOOGLE_TOKEN_INVALID' });
  }

  return payload;
}

/**
 * Memverifikasi Google ID token secara kriptografis menggunakan JWKS resmi Google
 * (tanpa mengirim token mentah di query string) dan memastikan aud, iss, exp, nbf,
 * serta email_verified sah.
 */
export async function verifyGoogleIdToken(idToken, expectedClientId) {
  if (!expectedClientId) {
    throw new HttpError(503, 'Login Google belum dikonfigurasi di server (GOOGLE_CLIENT_ID).', { code: 'GOOGLE_NOT_CONFIGURED' });
  }
  if (typeof idToken !== 'string') {
    throw new HttpError(400, 'Token Google wajib dikirim.');
  }
  const token = idToken.trim();
  if (!token) {
    throw new HttpError(400, 'Token Google wajib dikirim.');
  }

  const payload = customVerifier
    ? await customVerifier(token, expectedClientId)
    : await verifyJwtWithGoogleJwks(token);

  if (!payload || typeof payload !== 'object') {
    throw new HttpError(401, 'Token Google tidak valid.', { code: 'GOOGLE_TOKEN_INVALID' });
  }

  const audMatch = Array.isArray(payload.aud)
    ? payload.aud.includes(expectedClientId) && payload.azp === expectedClientId
    : payload.aud === expectedClientId;
  if (!audMatch) {
    throw new HttpError(401, 'Token Google tidak cocok untuk aplikasi ini.', { code: 'GOOGLE_AUD_MISMATCH' });
  }

  if (!GOOGLE_ISSUERS.has(payload.iss)) {
    throw new HttpError(401, 'Penerbit token Google tidak valid.', { code: 'GOOGLE_ISS_INVALID' });
  }

  const now = Date.now();
  const expMs = Number(payload.exp) * 1000;
  if (!Number.isFinite(expMs) || expMs <= now - CLOCK_SKEW_MS) {
    throw new HttpError(401, 'Sesi token Google sudah kedaluwarsa. Silakan coba lagi.', { code: 'GOOGLE_TOKEN_EXPIRED' });
  }
  if (payload.nbf !== undefined) {
    const nbfMs = Number(payload.nbf) * 1000;
    if (!Number.isFinite(nbfMs) || nbfMs > now + CLOCK_SKEW_MS) {
      throw new HttpError(401, 'Token Google belum berlaku.', { code: 'GOOGLE_TOKEN_INVALID' });
    }
  }

  const verified = payload.email_verified === true || payload.email_verified === 'true';
  if (!verified || typeof payload.email !== 'string' || !payload.email.trim() || typeof payload.sub !== 'string' || !payload.sub.trim()) {
    throw new HttpError(401, 'Akun Google harus memiliki email yang terverifikasi.', { code: 'GOOGLE_EMAIL_UNVERIFIED' });
  }

  return {
    googleId: payload.sub.trim(),
    email: payload.email.trim().toLowerCase(),
    name: String(payload.name || payload.email.split('@')[0] || 'Pengguna').trim(),
    picture: typeof payload.picture === 'string' && payload.picture ? payload.picture : null,
  };
}
