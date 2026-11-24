import { fileURLToPath } from 'node:url';
import { existsSync } from 'node:fs';
import path from 'node:path';
import express from 'express';
import cors from 'cors';
import helmet from 'helmet';
import cookieParser from 'cookie-parser';
import rateLimit from 'express-rate-limit';
import { config, checkStartupConfig, validateProductionConfig } from './config.js';
import { attachRequestId, errorHandler, notFound } from './middleware/errors.js';
import { requireAuth } from './middleware/auth.js';
import {
  register, login, googleLogin, verifyOtp, resendOtp, refresh, logout, me, forgotPassword, resetPassword,
} from './routes/auth.js';
import {
  createAnalysis, estimateAnalysis, upload, uploadAnalysisFiles,
  MIN_ANALYSIS_WORDS, AI_MAX_CHARS, MAX_UPLOAD_BYTES,
} from './routes/analysis.js';
import {
  getTokenBalance, listTokenTransactions, listDownloadTransactions, listTokenPackages,
} from './routes/tokens.js';
import {
  listDocuments, getDocument, getDocumentPreservation, decideIssues, restoreOriginal, renameDocument,
  deleteDocuments, downloadDocument, reserveDocumentDownload, fetchPreparedDownload,
  commitDocumentDownload, cancelDocumentDownload, downloadAnalysisReport,
} from './routes/documents.js';
import {
  listPayments, createPaymentHandler, getPayment, renewPayment, cancelPayment, deletePayment, paymentQr,
  paymentInvoice, paymentNotification,
} from './routes/payments.js';
import { paymentInfo } from './services/payments.js';
import { TOKEN_PACKAGES, WORDS_PER_TOKEN, getTokenPricingInfo } from './services/tokens.js';
import { startRetentionJob } from './services/retention.js';
import { initStorage, closeStorage, healthCheck, storage } from './repositories/index.js';
import { getProviderInfo } from './services/aiProvider.js';
import { getAiUsageSnapshot, fetchOpenRouterAccountLimits } from './services/aiQuota.js';
import { getDocumentProcessingCapabilities } from './services/documentProcessor.js';
import { getDocumentStorageStatus } from './services/fileStore.js';

export function createApp() {
  const app = express();
  app.disable('x-powered-by');
  app.set('trust proxy', 1);
  app.use(attachRequestId);

  app.use(helmet({
    crossOriginResourcePolicy: { policy: 'cross-origin' },
    crossOriginOpenerPolicy: { policy: 'same-origin-allow-popups' },
    referrerPolicy: { policy: 'strict-origin-when-cross-origin' },
    hsts: config.env === 'production' ? { maxAge: 31536000, includeSubDomains: true } : false,
    contentSecurityPolicy: {
      directives: {
        defaultSrc: ["'self'"],
        scriptSrc: ["'self'", 'https://accounts.google.com/gsi/client'],
        styleSrc: ["'self'", "'unsafe-inline'", 'https://accounts.google.com/gsi/style', 'https://fonts.googleapis.com', 'https://cdnjs.cloudflare.com'],
        fontSrc: ["'self'", 'https://fonts.gstatic.com', 'https://cdnjs.cloudflare.com', 'data:'],
        imgSrc: ["'self'", 'data:', 'blob:', 'https://*.googleusercontent.com'],
        connectSrc: ["'self'", 'https://accounts.google.com/gsi/'],
        frameSrc: ["'self'", 'https://accounts.google.com/gsi/'],
      },
    },
  }));
  app.use((_req, res, next) => {
    res.setHeader('Permissions-Policy', 'camera=(), microphone=(), geolocation=()');
    next();
  });
  app.use('/api', (_req, res, next) => {
    res.setHeader('Cache-Control', 'no-store');
    next();
  });
  app.use(cors({
    origin: (origin, cb) => {
      if (!origin) return cb(null, true);
      const allowedOrigins = new Set([
        ...config.corsOrigins,
        ...(process.env.FRONTEND_URL ? [process.env.FRONTEND_URL.trim().replace(/\/$/, '')] : []),
        ...String(process.env.CORS_ORIGINS || '')
          .split(',')
          .map((s) => s.trim().replace(/\/$/, ''))
          .filter(Boolean),
      ]);
      if (allowedOrigins.has(origin)) return cb(null, true);
      if ((process.env.NODE_ENV || config.env) !== 'production' && /^http:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/.test(origin)) {
        return cb(null, true);
      }
      return cb(null, false);
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
  const exportLimiter = rateLimit({
    windowMs: 60 * 1000,
    max: Number(process.env.RATE_LIMIT_EXPORT_MAX || 30),
    standardHeaders: 'draft-7',
    legacyHeaders: false,
  });
  const paymentLimiter = rateLimit({
    windowMs: 15 * 60 * 1000,
    max: Number(process.env.RATE_LIMIT_PAYMENT_MAX || 30),
    standardHeaders: 'draft-7',
    legacyHeaders: false,
  });
  const webhookLimiter = rateLimit({
    windowMs: 60 * 1000,
    max: Number(process.env.RATE_LIMIT_WEBHOOK_MAX || 120),
    standardHeaders: 'draft-7',
    legacyHeaders: false,
  });
  const adminLimiter = rateLimit({
    windowMs: 60 * 1000,
    max: Number(process.env.RATE_LIMIT_ADMIN_MAX || 30),
    standardHeaders: 'draft-7',
    legacyHeaders: false,
  });

  app.get('/api/health', async (_req, res) => {
    const ai = getProviderInfo();
    const pay = paymentInfo();
    const [db, docProc] = await Promise.all([
      healthCheck(),
      getDocumentProcessingCapabilities(),
    ]);
    res.status(db.ok ? 200 : 503).json({
      ok: db.ok,
      storage: storage.detail,
      database: db,
      document_storage: getDocumentStorageStatus(),
      document_processing: docProc,
      ai: {
        provider: ai.provider,
        model: ai.model || null,
        configured: ai.configured,
        timeout_ms: ai.timeoutMs,
        fallback: ai.fallback,
      },
      tokens: {
        available: pay.available,
        mode: pay.mode,
        packages: TOKEN_PACKAGES,
        pricing: getTokenPricingInfo(),
      },
      mail_configured: Boolean(config.mail.configured || (process.env.MAIL_HOST && process.env.MAIL_USER && process.env.MAIL_PASS)),
      google_configured: Boolean((config.google.clientId || process.env.GOOGLE_CLIENT_ID || '').trim()),
      google_client_id: (config.google.clientId || process.env.GOOGLE_CLIENT_ID || '').trim() || null,
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
  app.post('/api/auth/verify-otp', authLimiter, verifyOtp);
  app.post('/api/auth/resend-otp', authLimiter, resendOtp);
  app.post('/api/auth/login', authLimiter, login);
  app.post('/api/auth/google', authLimiter, googleLogin);
  app.post('/api/auth/refresh', authLimiter, refresh);
  app.post('/api/auth/logout', logout);
  app.get('/api/auth/me', requireAuth, me);
  app.post('/api/auth/forgot-password', authLimiter, forgotPassword);
  app.post('/api/auth/reset-password', authLimiter, resetPassword);

  // ---- Token & Saldo ----
  app.get('/api/tokens/packages', listTokenPackages);
  app.get('/api/tokens/transactions', requireAuth, listTokenTransactions);
  app.get('/api/tokens/downloads', requireAuth, listDownloadTransactions);
  app.get('/api/tokens', requireAuth, getTokenBalance);

  // ---- Analisis (FR-02..FR-06) ----
  app.post('/api/analysis/estimate', requireAuth, upload.single('file'), estimateAnalysis);
  app.post('/api/analysis', requireAuth, analysisLimiter, uploadAnalysisFiles, createAnalysis);

  // ---- Dokumen, saran, unduhan (FR-08..FR-11) ----
  app.get('/api/documents', requireAuth, listDocuments);
  app.delete('/api/documents', requireAuth, deleteDocuments);
  app.post('/api/documents/:id/download/reserve', requireAuth, exportLimiter, reserveDocumentDownload);
  app.get('/api/documents/:id/download/file', requireAuth, exportLimiter, fetchPreparedDownload);
  app.post('/api/documents/:id/download/:txId/commit', requireAuth, exportLimiter, commitDocumentDownload);
  app.post('/api/documents/:id/download/:txId/cancel', requireAuth, exportLimiter, cancelDocumentDownload);
  app.get('/api/documents/:id/download', requireAuth, exportLimiter, downloadDocument);
  app.get('/api/documents/:id/analysis-report', requireAuth, exportLimiter, downloadAnalysisReport);
  app.get('/api/documents/:id/preservation', requireAuth, getDocumentPreservation);
  app.get('/api/documents/:id', requireAuth, getDocument);
  app.patch('/api/documents/:id/issues', requireAuth, decideIssues);
  app.post('/api/documents/:id/restore', requireAuth, restoreOriginal);
  app.patch('/api/documents/:id/title', requireAuth, renameDocument);

  // ---- Pemantauan Kuota AI (Admin - fail-closed) ----
  app.get('/api/admin/ai-usage', requireAuth, adminLimiter, async (req, res) => {
    const adminEmails = String(process.env.ADMIN_EMAILS || '')
      .split(',')
      .map((s) => s.trim().toLowerCase())
      .filter(Boolean);
    if (adminEmails.length === 0) {
      return res.status(403).json({
        error: 'Akses pemantauan kuota AI dinonaktifkan: ADMIN_EMAILS belum dikonfigurasi di server.',
        code: 'ADMIN_NOT_CONFIGURED',
      });
    }
    if (!adminEmails.includes(String(req.user?.email || '').toLowerCase())) {
      return res.status(403).json({ error: 'Akses pemantauan kuota AI hanya untuk admin.', code: 'ADMIN_ONLY' });
    }
    const ai = getProviderInfo();
    const usage = getAiUsageSnapshot();
    const includeLive = req.query.live !== 'false';
    const openrouterLimits = includeLive && process.env.OPENROUTER_API_KEY
      ? await fetchOpenRouterAccountLimits()
      : { available: false, scope: 'account', reason: 'Live OpenRouter account limits not queried or OPENROUTER_API_KEY not set.' };
    return res.json({
      primary_provider: {
        provider: ai.provider,
        model: ai.model || null,
        configured: ai.configured,
      },
      fallback_provider: ai.fallback,
      usage,
      openrouter_account_limits: openrouterLimits,
    });
  });

  // ---- Pembayaran Token (FR-07) ----
  app.get('/api/payments', requireAuth, listPayments);
  app.post('/api/payments', requireAuth, paymentLimiter, createPaymentHandler);
  app.post('/api/payments/notify', webhookLimiter, paymentNotification);
  app.post('/api/payments/:orderId/renew', requireAuth, paymentLimiter, renewPayment);
  app.post('/api/payments/:orderId/cancel', requireAuth, paymentLimiter, cancelPayment);
  app.delete('/api/payments/:orderId', requireAuth, paymentLimiter, deletePayment);
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

export async function start() {
  validateProductionConfig();
  for (const problem of checkStartupConfig()) console.warn('[config] ' + problem);
  const info = await initStorage();
  console.log(`[runut] penyimpanan: ${info.detail}`);
  const docCaps = await getDocumentProcessingCapabilities().catch(() => null);
  if (docCaps && !docCaps.libreoffice.available) {
    const guidance = docCaps.libreoffice.install_guidance;
    console.warn(`[document-processing] LibreOffice tidak terdeteksi (${docCaps.platform}). ${guidance?.summary || ''} Docker tidak wajib untuk pengembangan lokal; atur ${guidance?.recommended_env || 'LIBREOFFICE_PATH'} bila konversi DOC/DOCX-ke-PDF diperlukan.`);
  } else if (docCaps?.libreoffice?.available) {
    console.log(`[document-processing] LibreOffice siap: ${docCaps.libreoffice.binary} (${docCaps.libreoffice.version})`);
  }
  const app = createApp();
  const retentionTimer = startRetentionJob();
  const host = process.env.HOST || '0.0.0.0';
  const server = app.listen(config.port, host, () => {
    console.log(`[runut] API listening on ${host}:${config.port} (env=${config.env})`);
  });

  const shutdown = (signal) => {
    console.log(JSON.stringify({ event: 'shutdown_started', signal }));
    clearInterval(retentionTimer);
    server.close(async () => {
      await closeStorage();
      console.log(JSON.stringify({ event: 'shutdown_complete', signal }));
      process.exit(0);
    });
    setTimeout(() => process.exit(1), 10000).unref?.();
  };
  process.once('SIGINT', () => shutdown('SIGINT'));
  process.once('SIGTERM', () => shutdown('SIGTERM'));

  return server;
}
