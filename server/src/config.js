import dotenv from 'dotenv';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomBytes } from 'node:crypto';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
dotenv.config({ path: path.resolve(__dirname, '../.env') });
dotenv.config();

const ephemeral = [];

function secretFor(name) {
  const value = process.env[name];
  if (value) {
    if (value.length < 32) console.warn(`[config] ${name} lebih pendek dari 32 karakter.`);
    return value;
  }
  ephemeral.push(name);
  return randomBytes(32).toString('hex');
}

const isProduction = (process.env.NODE_ENV || 'development') === 'production';
const frontendUrl = (process.env.FRONTEND_URL || (isProduction ? '' : 'http://localhost:5173')).replace(/\/$/, '');
const corsOrigins = Array.from(new Set(
  [
    frontendUrl,
    ...String(process.env.CORS_ORIGINS || '')
      .split(',')
      .map((s) => s.trim().replace(/\/$/, ''))
      .filter(Boolean),
  ].filter(Boolean),
));

export const config = {
  env: process.env.NODE_ENV || 'development',
  port: Number(process.env.PORT || 3000),
  frontendUrl,
  corsOrigins,

  database: {
    url: process.env.DATABASE_URL || '',
    poolMax: Number(process.env.PG_POOL_MAX || 10),
    idleTimeoutMs: Number(process.env.PG_IDLE_TIMEOUT_MS || 30000),
    connectionTimeoutMs: Number(process.env.PG_CONNECTION_TIMEOUT_MS || 5000),
    statementTimeoutMs: Number(process.env.PG_STATEMENT_TIMEOUT_MS || 15000),
    ssl: process.env.DATABASE_SSL || '',
  },

  jwt: {
    accessSecret: secretFor('JWT_ACCESS_SECRET'),
    accessTtl: process.env.JWT_ACCESS_TTL || '1h',
    refreshDays: Number(process.env.REFRESH_TOKEN_DAYS || 30),
  },

  ai: {
    provider: (process.env.AI_PROVIDER || 'openrouter').toLowerCase(),
    baseUrl: (process.env.OPENROUTER_BASE_URL || process.env.AI_BASE_URL || (process.env.AI_PROVIDER?.toLowerCase() === 'gemini' ? 'https://generativelanguage.googleapis.com/v1beta/openai' : (process.env.AI_PROVIDER?.toLowerCase() === 'openai' ? 'https://api.openai.com/v1' : 'https://openrouter.ai/api/v1'))).replace(/\/$/, ''),
    apiKey: process.env.OPENROUTER_API_KEY || process.env.AI_API_KEY || '',
    model: process.env.OPENROUTER_MODEL || process.env.AI_MODEL || (process.env.AI_PROVIDER?.toLowerCase() === 'gemini' ? 'gemini-3.1-flash-lite' : 'particle-ai/particle-1:free'),
    timeoutMs: Number(process.env.AI_TIMEOUT_MS || 90000),
    geminiApiKey: process.env.GEMINI_API_KEY || '',
    geminiModel: process.env.GEMINI_MODEL || 'gemini-3.1-flash-lite',
  },

  admin: {
    emails: String(process.env.ADMIN_EMAILS || '')
      .split(',')
      .map((s) => s.trim().toLowerCase())
      .filter(Boolean),
  },

  conversion: {
    libreOfficePath: (process.env.LIBREOFFICE_PATH || process.env.LIBREOFFICE_BIN || '').trim(),
    docxPdfEnabled: String(process.env.DOCX_PDF_CONVERSION_ENABLED || 'true') !== 'false',
    docxPdfTimeoutMs: Number(process.env.DOCX_PDF_TIMEOUT_MS || 120000),
  },

  payments: {
    serverKey: process.env.MIDTRANS_SERVER_KEY || '',
    clientKey: process.env.MIDTRANS_CLIENT_KEY || '',
    isProduction: String(process.env.MIDTRANS_IS_PRODUCTION || 'false') === 'true',
    apiBase: (process.env.MIDTRANS_API_BASE || '').replace(/\/$/, ''),
    qrisAcquirer: process.env.MIDTRANS_QRIS_ACQUIRER || 'gopay',
    expiryHours: Number(process.env.PAYMENT_EXPIRY_HOURS || 24),
  },

  mail: {
    host: process.env.MAIL_HOST || '',
    port: Number(process.env.MAIL_PORT || 587),
    secure: String(process.env.MAIL_SECURE || 'false') === 'true',
    user: process.env.MAIL_USER || '',
    pass: process.env.MAIL_PASS || '',
    from: process.env.MAIL_FROM || 'Runut <no-reply@runut.local>',
    configured: Boolean(process.env.MAIL_HOST && process.env.MAIL_USER && process.env.MAIL_PASS),
  },

  google: {
    clientId: (process.env.GOOGLE_CLIENT_ID || '').trim(),
    configured: Boolean((process.env.GOOGLE_CLIENT_ID || '').trim()),
  },
};

export function checkStartupConfig() {
  const problems = [];
  if (ephemeral.length) {
    problems.push(`${ephemeral.join(', ')} kosong - memakai kunci acak sementara; semua sesi tidak valid setelah server restart.`);
  }
  if (config.env === 'production' && !config.frontendUrl) {
    problems.push('FRONTEND_URL belum dikonfigurasi di production.');
  } else if (config.env === 'production' && /^https?:\/\/(localhost|127\.0\.0\.1)(:\d+)?/i.test(config.frontendUrl)) {
    problems.push('FRONTEND_URL masih menunjuk ke localhost di mode production. Ganti dengan URL publik HTTPS.');
  }
  if (!config.ai.baseUrl || !config.ai.model || !config.ai.apiKey) {
    problems.push('Konfigurasi AI belum lengkap (OPENROUTER_API_KEY / AI_API_KEY) - endpoint analisis menjawab 503 sampai dilengkapi.');
  }
  if (!config.payments.serverKey) {
    problems.push('MIDTRANS_SERVER_KEY belum dikonfigurasi: pembelian token dinonaktifkan.');
  }
  if (!config.mail.configured) problems.push('SMTP belum dikonfigurasi - reset password via email menjawab 503.');
  return problems;
}

export function validateProductionConfig() {
  if (config.env !== 'production') return;
  const missing = [];
  if (ephemeral.includes('JWT_ACCESS_SECRET')) missing.push('JWT_ACCESS_SECRET');
  if (!config.database.url) missing.push('DATABASE_URL');
  if (missing.length) {
    throw new Error(`Konfigurasi wajib production belum diisi: ${missing.join(', ')}.`);
  }
}
