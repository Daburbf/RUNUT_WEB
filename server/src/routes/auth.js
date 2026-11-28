import crypto from 'node:crypto';
import bcrypt from 'bcryptjs';
import { config } from '../config.js';
import { users, refreshTokens, tokenTransactions } from '../repositories/index.js';
import { HttpError, asyncHandler } from '../middleware/errors.js';
import { signAccessToken, setRefreshCookie, clearRefreshCookie, readRefreshToken } from '../middleware/auth.js';
import { sendMail } from '../services/mailer.js';
import { verifyGoogleIdToken } from '../services/googleAuth.js';
import { logSecurityEvent, recordFailedLogin } from '../services/securityLog.js';
import { getSignupBonusTokens } from '../services/tokens.js';

const BCRYPT_ROUNDS = Number(process.env.BCRYPT_ROUNDS || (process.env.NODE_ENV === 'production' ? 12 : 10));
// Precomputed dummy bcrypt hash to equalize timing when login email does not exist
const DUMMY_BCRYPT_HASH = '$2a$10$N9qo8uLOickgx2ZMRZoMyeIjZAgcfl7p92ldGxad68LJZdL17lhWy';

const EMAIL_RE = /^\S+@\S+\.\S+$/;
const OTP_RE = /^\d{6}$/;
const RESET_TTL_MS = 30 * 60 * 1000;
const OTP_TTL_MS = 10 * 60 * 1000;
const OTP_RESEND_COOLDOWN_MS = 60 * 1000;
const OTP_MAX_ATTEMPTS = 5;

export function publicUser(u, summary = null) {
  const balance = Math.max(0, Number(summary?.balance ?? u.token_balance) || 0);
  return {
    id: u.id,
    name: u.name,
    email: u.email,
    email_verified: u.email_verified !== false,
    has_password: Boolean(u.password_hash),
    auth_provider: u.auth_provider || 'local',
    token_balance: balance,
    total_purchased: Number(summary?.total_purchased || 0),
    total_used: Number(summary?.total_used || 0),
    total_refunded: Number(summary?.total_refunded || 0),
  };
}

const asString = (v) => (typeof v === 'string' ? v : '');
const escapeHtml = (s) => String(s || '')
  .replace(/&/g, '&amp;')
  .replace(/</g, '&lt;')
  .replace(/>/g, '&gt;')
  .replace(/"/g, '&quot;')
  .replace(/'/g, '&#39;');
const sha256 = (s) => crypto.createHash('sha256').update(s).digest('hex');
const otpSecret = () => process.env.OTP_SECRET || config.jwt.accessSecret;
const hashOtp = (userId, purpose, otp) => crypto.createHmac('sha256', otpSecret()).update(`${userId}:${purpose}:${otp}`).digest('hex');
const hashResetToken = (token) => crypto.createHmac('sha256', otpSecret()).update(`reset:${token}`).digest('hex');
const generateOtp = () => String(crypto.randomInt(100000, 1000000));

function safeHexEqual(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string' || a.length !== b.length || a.length === 0) return false;
  try {
    return crypto.timingSafeEqual(Buffer.from(a, 'hex'), Buffer.from(b, 'hex'));
  } catch {
    return false;
  }
}

function mailConfigured() {
  return Boolean(config.mail.configured || (process.env.MAIL_HOST && process.env.MAIL_USER && process.env.MAIL_PASS));
}

function googleClientId() {
  return (config.google.clientId || process.env.GOOGLE_CLIENT_ID || '').trim();
}

async function grantSignupBonus(user) {
  const bonus = getSignupBonusTokens();
  if (!user?.id || bonus <= 0) return user;
  const result = await tokenTransactions.credit({
    user_id: user.id,
    amount: bonus,
    type: 'bonus',
    description: `Bonus pendaftaran akun baru (${bonus} token gratis untuk testing)`,
    reference_type: 'signup_bonus',
    reference_id: user.id,
    idempotency_key: `signup_bonus:${user.id}`,
    meta: { reason: 'new_account_testing_bonus', amount: bonus },
  });
  return result?.user || user;
}

async function issueSession(res, user, userAgent) {
  const accessToken = signAccessToken(user);
  const refreshToken = crypto.randomBytes(48).toString('hex');
  await refreshTokens.create({
    user_id: user.id,
    token_hash: sha256(refreshToken),
    expires_at: new Date(Date.now() + config.jwt.refreshDays * 24 * 3600 * 1000).toISOString(),
    user_agent: userAgent ? String(userAgent).slice(0, 300) : null,
  });
  setRefreshCookie(res, refreshToken);
  const summary = await tokenTransactions.summaryByUser(user.id);
  return { user: publicUser(user, summary), accessToken };
}

async function sendVerificationOtpEmail(user, otp) {
  try {
    await sendMail({
      to: user.email,
      subject: 'Kode OTP Verifikasi Akun Runut (berlaku 10 menit)',
      text: `Halo ${user.name},\n\nKode OTP verifikasi akun Runut Anda adalah: ${otp}\n\nKode ini berlaku selama 10 menit. Jangan bagikan kode ini kepada siapa pun.`,
      html: `<p>Halo ${escapeHtml(user.name)},</p><p>Kode OTP verifikasi akun Runut Anda adalah:</p><p style="font-size:24px;font-weight:bold;letter-spacing:4px;">${escapeHtml(otp)}</p><p>Kode ini berlaku selama 10 menit. Jangan bagikan kode ini kepada siapa pun.</p>`,
    });
  } catch (err) {
    console.error(JSON.stringify({ event: 'mail_failed', reason: err.message }));
    throw new HttpError(502, 'Kode OTP gagal dikirim oleh server email. Coba lagi nanti atau hubungi administrator.', { code: 'MAIL_FAILED' });
  }
}

async function verifyOtpAgainstUser(user, otp, expectedPurpose) {
  const cleanOtp = asString(otp).trim();
  if (!OTP_RE.test(cleanOtp)) {
    throw new HttpError(400, 'Kode OTP harus berupa 6 digit angka.');
  }
  if (!user || !user.otp_code_hash || user.otp_purpose !== expectedPurpose) {
    throw new HttpError(400, 'Kode OTP tidak ditemukan atau sudah tidak berlaku. Silakan minta kode baru.');
  }
  if (!user.otp_expires_at || new Date(user.otp_expires_at) < new Date()) {
    await users.update(user.id, {
      otp_code_hash: null,
      otp_purpose: null,
      otp_expires_at: null,
      otp_attempts: 0,
    });
    throw new HttpError(400, 'Kode OTP sudah kedaluwarsa. Silakan minta kode baru.');
  }
  const attempts = Number(user.otp_attempts || 0);
  if (attempts >= OTP_MAX_ATTEMPTS) {
    await users.update(user.id, {
      otp_code_hash: null,
      otp_purpose: null,
      otp_expires_at: null,
      otp_attempts: 0,
    });
    throw new HttpError(429, 'Terlalu banyak percobaan OTP yang salah. Silakan minta kode OTP baru.');
  }
  const expectedHash = hashOtp(user.id, expectedPurpose, cleanOtp);
  if (!safeHexEqual(expectedHash, user.otp_code_hash)) {
    const nextAttempts = attempts + 1;
    const exhausted = nextAttempts >= OTP_MAX_ATTEMPTS;
    await users.update(user.id, {
      otp_attempts: exhausted ? 0 : nextAttempts,
      ...(exhausted ? { otp_code_hash: null, otp_purpose: null, otp_expires_at: null } : {}),
    });
    throw new HttpError(
      exhausted ? 429 : 400,
      exhausted
        ? 'Terlalu banyak percobaan OTP yang salah. Silakan minta kode OTP baru.'
        : `Kode OTP salah. Sisa percobaan: ${OTP_MAX_ATTEMPTS - nextAttempts}.`,
    );
  }
}

export const register = asyncHandler(async (req, res) => {
  const rawName = asString(req.body?.name);
  const rawEmail = asString(req.body?.email);
  const rawPassword = asString(req.body?.password);

  if (rawName.trim().length < 2 || rawName.trim().length > 100) throw new HttpError(400, 'Nama harus 2 sampai 100 karakter.');
  if (!EMAIL_RE.test(rawEmail.trim())) throw new HttpError(400, 'Format email tidak valid.');
  if (rawPassword.length < 8 || rawPassword.length > 128 || !rawPassword.trim()) {
    throw new HttpError(400, 'Kata sandi harus 8 sampai 128 karakter.');
  }

  const cleanName = rawName.trim();
  const cleanEmail = rawEmail.trim().toLowerCase();
  const existing = await users.findByEmail(cleanEmail);
  const useOtp = mailConfigured();

  if (existing && (existing.email_verified !== false || !useOtp)) {
    throw new HttpError(409, 'Email sudah terdaftar. Silakan masuk atau gunakan email lain.');
  }

  if (existing && existing.otp_sent_at && Date.now() - new Date(existing.otp_sent_at).getTime() < OTP_RESEND_COOLDOWN_MS) {
    throw new HttpError(429, 'Tunggu 60 detik sebelum mengirim ulang kode OTP.', { code: 'OTP_COOLDOWN' });
  }

  const passwordHash = await bcrypt.hash(rawPassword, BCRYPT_ROUNDS);

  if (useOtp) {
    const user = existing
      ? await users.update(existing.id, {
        name: cleanName,
        password_hash: passwordHash,
        email_verified: false,
      })
      : await users.create({
        name: cleanName,
        email: cleanEmail,
        password_hash: passwordHash,
        token_balance: 0,
        email_verified: false,
        auth_provider: 'local',
      });

    const otp = generateOtp();
    await users.update(user.id, {
      otp_code_hash: hashOtp(user.id, 'verify_email', otp),
      otp_purpose: 'verify_email',
      otp_expires_at: new Date(Date.now() + OTP_TTL_MS).toISOString(),
      otp_attempts: 0,
      otp_sent_at: new Date().toISOString(),
    });
    await sendVerificationOtpEmail(user, otp);
    return res.status(201).json({
      requires_verification: true,
      email: user.email,
      message: 'Kode OTP verifikasi telah dikirim ke email Anda (berlaku 10 menit).',
    });
  }

  const created = await users.create({
    name: cleanName,
    email: cleanEmail,
    password_hash: passwordHash,
    token_balance: 0,
    email_verified: true,
    auth_provider: 'local',
  });
  const credited = await grantSignupBonus(created);
  res.status(201).json(await issueSession(res, credited, req.headers['user-agent']));
});

export const verifyOtp = asyncHandler(async (req, res) => {
  const cleanEmail = asString(req.body?.email).trim().toLowerCase();
  const cleanOtp = asString(req.body?.otp).trim();
  if (!EMAIL_RE.test(cleanEmail)) throw new HttpError(400, 'Format email tidak valid.');
  const user = await users.findByEmail(cleanEmail);
  if (!user) throw new HttpError(400, 'Kode OTP tidak valid atau akun tidak ditemukan.');

  await verifyOtpAgainstUser(user, cleanOtp, 'verify_email');

  const updated = await users.update(user.id, {
    email_verified: true,
    otp_code_hash: null,
    otp_purpose: null,
    otp_expires_at: null,
    otp_attempts: 0,
  });
  const credited = await grantSignupBonus(updated);
  res.json(await issueSession(res, credited, req.headers['user-agent']));
});

export const resendOtp = asyncHandler(async (req, res) => {
  if (!mailConfigured()) {
    throw new HttpError(503, 'Layanan email belum dikonfigurasi di server (MAIL_HOST/MAIL_USER/MAIL_PASS).', { code: 'MAIL_NOT_CONFIGURED' });
  }
  const cleanEmail = asString(req.body?.email).trim().toLowerCase();
  if (!EMAIL_RE.test(cleanEmail)) throw new HttpError(400, 'Format email tidak valid.');

  const user = await users.findByEmail(cleanEmail);
  if (user && user.email_verified === false) {
    if (user.otp_sent_at && Date.now() - new Date(user.otp_sent_at).getTime() < OTP_RESEND_COOLDOWN_MS) {
      throw new HttpError(429, 'Tunggu 60 detik sebelum mengirim ulang kode OTP.', { code: 'OTP_COOLDOWN' });
    }
    const otp = generateOtp();
    await users.update(user.id, {
      otp_code_hash: hashOtp(user.id, 'verify_email', otp),
      otp_purpose: 'verify_email',
      otp_expires_at: new Date(Date.now() + OTP_TTL_MS).toISOString(),
      otp_attempts: 0,
      otp_sent_at: new Date().toISOString(),
    });
    await sendVerificationOtpEmail(user, otp);
  }
  res.json({ ok: true, message: 'Jika email terdaftar dan belum terverifikasi, kode OTP baru telah dikirim.' });
});

export const login = asyncHandler(async (req, res) => {
  const cleanEmail = asString(req.body?.email).trim().toLowerCase();
  const rawPassword = asString(req.body?.password);
  if (!cleanEmail || !rawPassword) throw new HttpError(400, 'Email dan kata sandi wajib diisi.');
  const user = await users.findByEmail(cleanEmail);
  const emailHash = sha256(cleanEmail).slice(0, 16);
  if (!user) {
    // Equalize timing to mitigate account enumeration
    await bcrypt.compare(rawPassword, DUMMY_BCRYPT_HASH).catch(() => {});
    recordFailedLogin({ ip: req.ip, emailHash });
    throw new HttpError(401, 'Email atau kata sandi salah.');
  }
  if (!user.password_hash) {
    recordFailedLogin({ ip: req.ip, emailHash });
    throw new HttpError(401, 'Akun ini terdaftar melalui Google. Silakan masuk dengan Google atau gunakan Lupa Kata Sandi untuk membuat kata sandi.');
  }
  if (!(await bcrypt.compare(rawPassword, user.password_hash))) {
    recordFailedLogin({ ip: req.ip, emailHash });
    throw new HttpError(401, 'Email atau kata sandi salah.');
  }
  if (user.email_verified === false && mailConfigured()) {
    throw new HttpError(403, 'Email Anda belum diverifikasi. Masukkan kode OTP yang dikirim ke email Anda.', {
      code: 'EMAIL_NOT_VERIFIED',
      requires_verification: true,
      email: user.email,
    });
  }
  res.json(await issueSession(res, user, req.headers['user-agent']));
});

export const googleLogin = asyncHandler(async (req, res) => {
  const clientId = googleClientId();
  const credential = asString(req.body?.credential);
  const profile = await verifyGoogleIdToken(credential, clientId);

  let user = await users.findByGoogleId(profile.googleId);
  if (!user) {
    user = await users.findByEmail(profile.email);
  }

  if (user) {
    if (user.google_id && user.google_id !== profile.googleId) {
      throw new HttpError(409, 'Email ini sudah terhubung dengan akun Google lain.', { code: 'GOOGLE_ACCOUNT_MISMATCH' });
    }
    const wasUnverified = user.email_verified === false;
    const patch = {
      email_verified: true,
      otp_code_hash: null,
      otp_purpose: null,
      otp_expires_at: null,
      otp_attempts: 0,
    };
    if (!user.google_id) patch.google_id = profile.googleId;
    if (!user.name && profile.name) patch.name = profile.name;
    // Cegah pre-hijacking: jika akun lokal sebelumnya belum terverifikasi,
    // bersihkan password_hash dan reset token agar pendaftar awal tidak bisa mengakses akun Google ini.
    if (wasUnverified) {
      patch.password_hash = null;
      patch.auth_provider = 'google';
      patch.reset_token_hash = null;
      patch.reset_token_expires_at = null;
    }
    user = await users.update(user.id, patch);
    if (wasUnverified) {
      user = await grantSignupBonus(user);
    }
  } else {
    user = await users.create({
      name: profile.name,
      email: profile.email,
      password_hash: null,
      google_id: profile.googleId,
      auth_provider: 'google',
      email_verified: true,
      token_balance: 0,
    });
    user = await grantSignupBonus(user);
  }

  res.json(await issueSession(res, user, req.headers['user-agent']));
});

export const refresh = asyncHandler(async (req, res) => {
  const token = readRefreshToken(req);
  if (!token) throw new HttpError(401, 'Sesi tidak ditemukan. Silakan masuk kembali.', { code: 'NO_REFRESH' });
  const row = await refreshTokens.findByHash(sha256(token));
  if (!row) {
    clearRefreshCookie(res);
    throw new HttpError(401, 'Sesi sudah berakhir. Silakan masuk kembali.', { code: 'REFRESH_INVALID' });
  }
  // Refresh token reuse detection (ASVS V3): if an already-revoked refresh token is replayed,
  // revoke ALL active refresh sessions and bump token_version to invalidate stolen access tokens.
  if (row.revoked_at) {
    await refreshTokens.revokeAllForUser(row.user_id);
    const compromisedUser = await users.findById(row.user_id);
    if (compromisedUser) {
      await users.update(compromisedUser.id, { token_version: Number(compromisedUser.token_version || 0) + 1 });
    }
    logSecurityEvent('auth_refresh_token_reuse_detected', { user_id: row.user_id, ip: req.ip }, { severity: 'high' });
    clearRefreshCookie(res);
    throw new HttpError(401, 'Aktivitas sesi mencurigakan terdeteksi. Semua sesi Anda telah dicabut demi keamanan; silakan masuk kembali.', {
      code: 'REFRESH_REUSE_DETECTED',
    });
  }
  if (new Date(row.expires_at) < new Date()) {
    clearRefreshCookie(res);
    throw new HttpError(401, 'Sesi sudah berakhir. Silakan masuk kembali.', { code: 'REFRESH_INVALID' });
  }
  const user = await users.findById(row.user_id);
  if (!user) throw new HttpError(401, 'Akun tidak ditemukan.', { code: 'NO_USER' });
  await refreshTokens.revokeById(row.id);
  res.json(await issueSession(res, user, req.headers['user-agent']));
});

export const logout = asyncHandler(async (req, res) => {
  const token = readRefreshToken(req);
  if (token) await refreshTokens.revokeByHash(sha256(token));
  clearRefreshCookie(res);
  res.json({ ok: true });
});

export const me = asyncHandler(async (req, res) => {
  const summary = await tokenTransactions.summaryByUser(req.user.id);
  res.json({ user: publicUser(req.user, summary) });
});

export const forgotPassword = asyncHandler(async (req, res) => {
  if (!mailConfigured()) {
    throw new HttpError(503, 'Layanan email belum dikonfigurasi di server (MAIL_HOST/MAIL_USER/MAIL_PASS). Reset password via email belum bisa dipakai.', { code: 'MAIL_NOT_CONFIGURED' });
  }
  const cleanEmail = asString(req.body?.email).trim().toLowerCase();
  if (EMAIL_RE.test(cleanEmail)) {
    const user = await users.findByEmail(cleanEmail);
    if (user) {
      if (user.otp_purpose === 'reset_password' && user.otp_sent_at && Date.now() - new Date(user.otp_sent_at).getTime() < OTP_RESEND_COOLDOWN_MS) {
        throw new HttpError(429, 'Tunggu 60 detik sebelum meminta kode reset lagi.', { code: 'OTP_COOLDOWN' });
      }
      const token = crypto.randomBytes(32).toString('hex');
      const otp = generateOtp();
      await users.update(user.id, {
        reset_token_hash: hashResetToken(token),
        reset_token_expires_at: new Date(Date.now() + RESET_TTL_MS).toISOString(),
        otp_code_hash: hashOtp(user.id, 'reset_password', otp),
        otp_purpose: 'reset_password',
        otp_expires_at: new Date(Date.now() + OTP_TTL_MS).toISOString(),
        otp_attempts: 0,
        otp_sent_at: new Date().toISOString(),
      });
      const link = `${config.frontendUrl}/#/atur-ulang?token=${token}`;
      try {
        await sendMail({
          to: user.email,
          subject: 'Kode OTP & Tautan Reset Kata Sandi Runut',
          text: `Halo ${user.name},\n\nKode OTP reset kata sandi Anda (berlaku 10 menit): ${otp}\n\nAtau gunakan tautan berikut (berlaku 30 menit):\n${link}\n\nJika Anda tidak memintanya, abaikan email ini.`,
          html: `<p>Halo ${escapeHtml(user.name)},</p><p>Kode OTP reset kata sandi Anda (berlaku 10 menit):</p><p style="font-size:24px;font-weight:bold;letter-spacing:4px;">${escapeHtml(otp)}</p><p>Atau klik tautan berikut (berlaku 30 menit):</p><p><a href="${escapeHtml(link)}">${escapeHtml(link)}</a></p><p>Jika Anda tidak memintanya, abaikan email ini.</p>`,
        });
      } catch (err) {
        console.error(JSON.stringify({ event: 'mail_failed', reason: err.message }));
        throw new HttpError(502, 'Tautan reset gagal dikirim oleh server email. Coba lagi nanti atau hubungi administrator.', { code: 'MAIL_FAILED' });
      }
    }
  }
  res.json({ ok: true, message: 'Jika email terdaftar, kode OTP (10 menit) dan tautan reset (30 menit) telah dikirim ke email Anda.' });
});

export const resetPassword = asyncHandler(async (req, res) => {
  const token = asString(req.body?.token).trim();
  const cleanEmail = asString(req.body?.email).trim().toLowerCase();
  const cleanOtp = asString(req.body?.otp).trim();
  const rawPassword = asString(req.body?.password);

  if (rawPassword.length < 8 || rawPassword.length > 128 || !rawPassword.trim()) {
    throw new HttpError(400, 'Kata sandi baru harus 8 sampai 128 karakter.');
  }

  let user = null;
  if (token) {
    user = await users.findByResetTokenHash(hashResetToken(token));
    if (!user || !safeHexEqual(hashResetToken(token), user.reset_token_hash) || !user.reset_token_expires_at || new Date(user.reset_token_expires_at) < new Date()) {
      throw new HttpError(400, 'Token reset tidak valid atau sudah kedaluwarsa (maksimal 30 menit). Silakan minta tautan baru.');
    }
  } else if (cleanEmail && cleanOtp) {
    if (!EMAIL_RE.test(cleanEmail)) throw new HttpError(400, 'Format email tidak valid.');
    user = await users.findByEmail(cleanEmail);
    await verifyOtpAgainstUser(user, cleanOtp, 'reset_password');
  } else {
    throw new HttpError(400, 'Token reset atau email beserta kode OTP wajib diisi.');
  }

  const wasUnverified = user.email_verified === false;
  const updatedUser = await users.update(user.id, {
    password_hash: await bcrypt.hash(rawPassword, BCRYPT_ROUNDS),
    email_verified: true,
    reset_token_hash: null,
    reset_token_expires_at: null,
    otp_code_hash: null,
    otp_purpose: null,
    otp_expires_at: null,
    otp_attempts: 0,
    token_version: Number(user.token_version || 0) + 1,
  });
  if (wasUnverified && updatedUser) {
    await grantSignupBonus(updatedUser);
  }
  await refreshTokens.revokeAllForUser(user.id);
  clearRefreshCookie(res);
  res.json({ ok: true, message: 'Kata sandi berhasil diubah. Silakan masuk kembali.' });
});
