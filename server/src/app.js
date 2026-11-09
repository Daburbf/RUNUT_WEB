import { fileURLToPath } from 'node:url';
import { existsSync } from 'node:fs';
import path from 'node:path';
import express from 'express';
import cors from 'cors';
import helmet from 'helmet';
import cookieParser from 'cookie-parser';
import rateLimit from 'express-rate-limit';
import { config, checkStartupConfig } from './config.js';
import { errorHandler, notFound } from './middleware/errors.js';
import { requireAuth } from './middleware/auth.js';
import {
  register, login, refresh, logout, me, forgotPassword, resetPassword,
} from './routes/auth.js';
import { createAnalysis, upload, FREE_WORD_LIMIT, PREMIUM_WORD_LIMIT } from './routes/analysis.js';
import {
  listDocuments, getDocument, decideIssues, restoreOriginal, renameDocument,
  deleteDocuments, downloadDocument,
} from './routes/documents.js';
import {
  listPayments, createPaymentHandler, getPayment, paymentQr,
  paymentInvoice, paymentNotification,
} from './routes/payments.js';
import { paymentInfo } from './services/payments.js';
import { startRetentionJob } from './services/retention.js';
import bcrypt from 'bcryptjs';
import { initStorage, storage, users } from './repositories/index.js';
import { getProviderInfo } from './services/aiProvider.js';

export function createApp() {
  const app = express();
  app.disable('x-powered-by');
  app.set('trust proxy', 1);

  app.use(helmet({ crossOriginResourcePolicy: { policy: 'cross-origin' } }));
  app.use(cors({
    origin: (origin, cb) => {
      if (!origin) return cb(null, true);
      // Di luar produksi, port dev apa pun diizinkan: Vite kadang naik ke 5174
      // bila 5173 masih dipegang proses lama, dan origin tetap kena tolak.
      const local = /^http:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/.test(origin);
      const allowed = [config.frontendUrl, 'http://localhost:5173', 'http://localhost:4173'];
      cb(null, allowed.includes(origin) || (config.env !== 'production' && local));
    },
    credentials: true,
  }));
  app.use(express.json({ limit: '1mb' }));
  app.use(cookieParser());

  // Batas laju dapat dinaikkan lewat environment untuk pengujian beban/uji
  // otomatis; nilai bawaan tetap ketat untuk pemakaian normal.
  const authLimiter = rateLimit({
    windowMs: 15 * 60 * 1000,
    max: Number(process.env.RATE_LIMIT_AUTH_MAX || 30),
    standardHeaders: 'draft-7',
    legacyHeaders: false,
  });
  const analysisLimiter = rateLimit({
    windowMs: 60 * 1000,
    max: Number(process.env.RATE_LIMIT_ANALYSIS_MAX || 10),
    standardHeaders: 'draft-7',
    legacyHeaders: false,
  });

  app.get('/api/health', (_req, res) => {
    const ai = getProviderInfo();
    res.json({
      ok: true,
      storage: storage.detail,
      ai: { provider: ai.provider, model: ai.model || null, configured: ai.configured, timeout_ms: ai.timeoutMs },
      premium: {
        price_idr: config.premium.priceIdr,
        duration_days: config.premium.durationDays,
        available: paymentInfo().available,
        mode: paymentInfo().mode,
      },
      mail_configured: config.mail.configured,
      limits: { free_words: FREE_WORD_LIMIT, premium_words: PREMIUM_WORD_LIMIT, free_shown_issues: 3 },
    });
  });

  // ---- Autentikasi (FR-01) ----
  app.post('/api/auth/register', authLimiter, register);
  app.post('/api/auth/login', authLimiter, login);
  app.post('/api/auth/refresh', authLimiter, refresh);
  app.post('/api/auth/logout', logout);
  app.get('/api/auth/me', requireAuth, me);
  app.post('/api/auth/forgot-password', authLimiter, forgotPassword);
  app.post('/api/auth/reset-password', authLimiter, resetPassword);

  // ---- Analisis (FR-02..FR-06) ----
  app.post('/api/analysis', requireAuth, analysisLimiter, upload.single('file'), createAnalysis);

  // ---- Dokumen, saran, unduhan (FR-08..FR-11) ----
  app.get('/api/documents', requireAuth, listDocuments);
  app.delete('/api/documents', requireAuth, deleteDocuments);
  // /:id/download didaftarkan sebelum /:id agar tidak tertelan parameter.
  app.get('/api/documents/:id/download', requireAuth, downloadDocument);
  app.get('/api/documents/:id', requireAuth, getDocument);
  app.patch('/api/documents/:id/issues', requireAuth, decideIssues);
  app.post('/api/documents/:id/restore', requireAuth, restoreOriginal);
  app.patch('/api/documents/:id/title', requireAuth, renameDocument);

  // ---- Pembayaran (FR-07) ----
  app.get('/api/payments', requireAuth, listPayments);
  app.post('/api/payments', requireAuth, createPaymentHandler);
  // /notify didaftarkan sebelum /:orderId agar tidak tertelan parameter.
  app.post('/api/payments/notify', paymentNotification);
  app.get('/api/payments/:orderId/qr', requireAuth, paymentQr);
  app.get('/api/payments/:orderId/invoice', requireAuth, paymentInvoice);
  app.get('/api/payments/:orderId', requireAuth, getPayment);

  // Sajikan build frontend bila ada: satu origin, cookie & CORS otomatis cocok.
  const dist = fileURLToPath(new URL('../../dist', import.meta.url));
  if (existsSync(dist)) {
    app.use(express.static(dist));
    app.get(/^\/(?!api\/)/, (req, res) => res.sendFile(path.join(dist, 'index.html')));
  }

  app.use('/api', notFound);
  app.use(errorHandler);
  return app;
}

// Inisialisasi akun siap pakai (Pro & Gratis), supaya fitur berbayar
// dan fitur gratis bisa langsung digunakan tanpa registrasi manual.
async function seedInitialAccounts() {
  if (!process.env.SEED_ACCOUNTS) return;

  // 1. Akun Pro / Premium
  const proEmail = process.env.PRO_EMAIL || 'premium@runut.local';
  const proPassword = process.env.PRO_PASSWORD || 'Premium12345!';
  const days = Number(process.env.PRO_DAYS || 30);
  const proUser = (await users.findByEmail(proEmail)) || (await users.create({
    name: 'Pengguna Pro',
    email: proEmail,
    password_hash: await bcrypt.hash(proPassword, 10),
  }));
  if (!proUser.is_premium) await users.extendPremium(proUser.id, days);
  console.log(`[auth] akun pro/premium: ${proEmail} / ${proPassword}`);

  // 2. Akun Biasa (Gratis)
  const freeEmail = process.env.FREE_EMAIL || 'free@runut.local';
  const freePassword = process.env.FREE_PASSWORD || 'Free12345!';
  (await users.findByEmail(freeEmail)) || (await users.create({
    name: 'Pengguna Gratis',
    email: freeEmail,
    password_hash: await bcrypt.hash(freePassword, 10),
  }));
  console.log(`[auth] akun gratis: ${freeEmail} / ${freePassword}`);
}

export async function start() {
  for (const problem of checkStartupConfig()) console.warn('[config] ' + problem);
  const info = await initStorage();
  console.log(`[runut] penyimpanan: ${info.detail}`);
  await seedInitialAccounts();
  const app = createApp();
  startRetentionJob();
  return app.listen(config.port, () => {
    console.log(`[runut] API berjalan di http://localhost:${config.port}`);
  });
}
