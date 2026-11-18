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
import {
  createAnalysis, estimateAnalysis, upload,
  MIN_ANALYSIS_WORDS, AI_MAX_CHARS, MAX_UPLOAD_BYTES,
} from './routes/analysis.js';
import {
  getTokenBalance, listTokenTransactions, listTokenPackages,
} from './routes/tokens.js';
import {
  listDocuments, getDocument, decideIssues, restoreOriginal, renameDocument,
  deleteDocuments, downloadDocument,
} from './routes/documents.js';
import {
  listPayments, createPaymentHandler, getPayment, paymentQr,
  paymentInvoice, paymentNotification,
} from './routes/payments.js';
import { paymentInfo } from './services/payments.js';
import { TOKEN_PACKAGES, WORDS_PER_TOKEN, getTokenPricingInfo } from './services/tokens.js';
import { startRetentionJob } from './services/retention.js';
import bcrypt from 'bcryptjs';
import { initStorage, storage, users, tokenTransactions } from './repositories/index.js';
import { getProviderInfo } from './services/aiProvider.js';

export function createApp() {
  const app = express();
  app.disable('x-powered-by');
  app.set('trust proxy', 1);

  app.use(helmet({ crossOriginResourcePolicy: { policy: 'cross-origin' } }));
  app.use(cors({
    origin: (origin, cb) => {
      if (!origin) return cb(null, true);
      const local = /^http:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/.test(origin);
      const allowed = [config.frontendUrl, 'http://localhost:5173', 'http://localhost:4173'];
      cb(null, allowed.includes(origin) || (config.env !== 'production' && local));
    },
    credentials: true,
  }));
  app.use(express.json({ limit: '1mb' }));
  app.use(cookieParser());

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
    const pay = paymentInfo();
    res.json({
      ok: true,
      storage: storage.detail,
      ai: { provider: ai.provider, model: ai.model || null, configured: ai.configured, timeout_ms: ai.timeoutMs },
      tokens: {
        available: pay.available,
        mode: pay.mode,
        packages: TOKEN_PACKAGES,
        pricing: getTokenPricingInfo(),
      },
      mail_configured: config.mail.configured,
      limits: {
        min_words: MIN_ANALYSIS_WORDS,
        words_per_token: WORDS_PER_TOKEN,
        max_chars: AI_MAX_CHARS,
        max_upload_bytes: MAX_UPLOAD_BYTES,
      },
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

  // ---- Token & Saldo ----
  app.get('/api/tokens/packages', listTokenPackages);
  app.get('/api/tokens/transactions', requireAuth, listTokenTransactions);
  app.get('/api/tokens', requireAuth, getTokenBalance);

  // ---- Analisis (FR-02..FR-06) ----
  app.post('/api/analysis/estimate', requireAuth, upload.single('file'), estimateAnalysis);
  app.post('/api/analysis', requireAuth, analysisLimiter, upload.single('file'), createAnalysis);

  // ---- Dokumen, saran, unduhan (FR-08..FR-11) ----
  app.get('/api/documents', requireAuth, listDocuments);
  app.delete('/api/documents', requireAuth, deleteDocuments);
  app.get('/api/documents/:id/download', requireAuth, downloadDocument);
  app.get('/api/documents/:id', requireAuth, getDocument);
  app.patch('/api/documents/:id/issues', requireAuth, decideIssues);
  app.post('/api/documents/:id/restore', requireAuth, restoreOriginal);
  app.patch('/api/documents/:id/title', requireAuth, renameDocument);

  // ---- Pembayaran Token (FR-07) ----
  app.get('/api/payments', requireAuth, listPayments);
  app.post('/api/payments', requireAuth, createPaymentHandler);
  app.post('/api/payments/notify', paymentNotification);
  app.get('/api/payments/:orderId/qr', requireAuth, paymentQr);
  app.get('/api/payments/:orderId/invoice', requireAuth, paymentInvoice);
  app.get('/api/payments/:orderId', requireAuth, getPayment);

  const dist = fileURLToPath(new URL('../../dist', import.meta.url));
  if (existsSync(dist)) {
    app.use(express.static(dist));
    app.get(/^\/(?!api\/)/, (req, res) => res.sendFile(path.join(dist, 'index.html')));
  }

  app.use('/api', notFound);
  app.use(errorHandler);
  return app;
}

async function seedInitialAccounts() {
  if (!process.env.SEED_ACCOUNTS) return;

  // 1. Akun Test (10 Token)
  const testEmail = process.env.TEST_EMAIL || 'test@runut.local';
  const testPassword = process.env.TEST_PASSWORD || 'Test12345!';
  const testUser = (await users.findByEmail(testEmail)) || (await users.create({
    name: 'Akun Test',
    email: testEmail,
    password_hash: await bcrypt.hash(testPassword, 10),
    token_balance: 0,
  }));
  await tokenTransactions.credit({
    user_id: testUser.id,
    amount: 10,
    type: 'purchase',
    description: 'Saldo awal akun uji coba (Paket Populer - 10 token)',
    reference_type: 'seed',
    reference_id: 'SEED-TEST-10',
    idempotency_key: 'seed:test:10',
  });
  console.log(`[auth] akun test (10 token): ${testEmail} / ${testPassword}`);

  // 2. Akun Demo / Pro lama (10 Token)
  const demoEmail = process.env.PRO_EMAIL || 'premium@runut.local';
  const demoPassword = process.env.PRO_PASSWORD || 'Premium12345!';
  const demoUser = (await users.findByEmail(demoEmail)) || (await users.create({
    name: 'Pengguna Demo',
    email: demoEmail,
    password_hash: await bcrypt.hash(demoPassword, 10),
    token_balance: 0,
  }));
  await tokenTransactions.credit({
    user_id: demoUser.id,
    amount: 10,
    type: 'purchase',
    description: 'Saldo awal akun uji coba (Paket Populer - 10 token)',
    reference_type: 'seed',
    reference_id: 'SEED-DEMO-10',
    idempotency_key: 'seed:demo:10',
  });
  console.log(`[auth] akun demo (10 token): ${demoEmail} / ${demoPassword}`);

  // 3. Akun Saldo 0
  const zeroEmail = process.env.FREE_EMAIL || 'free@runut.local';
  const zeroPassword = process.env.FREE_PASSWORD || 'Free12345!';
  (await users.findByEmail(zeroEmail)) || (await users.create({
    name: 'Pengguna Baru (0 Token)',
    email: zeroEmail,
    password_hash: await bcrypt.hash(zeroPassword, 10),
    token_balance: 0,
  }));
  console.log(`[auth] akun uji saldo 0: ${zeroEmail} / ${zeroPassword}`);
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
