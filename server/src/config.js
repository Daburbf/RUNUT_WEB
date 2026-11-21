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

export const config = {
  env: process.env.NODE_ENV || 'development',
  port: Number(process.env.PORT || 3000),
  frontendUrl: (process.env.FRONTEND_URL || 'http://localhost:5173').replace(/\/$/, ''),

  database: { url: process.env.DATABASE_URL || '' },

  jwt: {
    accessSecret: secretFor('JWT_ACCESS_SECRET'),
    accessTtl: process.env.JWT_ACCESS_TTL || '1h',
    refreshDays: Number(process.env.REFRESH_TOKEN_DAYS || 30),
  },

  ai: {
    provider: (process.env.AI_PROVIDER || '9router').toLowerCase(),
    baseUrl: (process.env.AI_BASE_URL || (process.env.AI_PROVIDER?.toLowerCase() === 'gemini' ? 'https://generativelanguage.googleapis.com/v1beta/openai' : (process.env.AI_PROVIDER?.toLowerCase() === 'openai' ? 'https://api.openai.com/v1' : 'http://localhost:20128/v1'))).replace(/\/$/, ''),
    apiKey: process.env.AI_API_KEY || '',
    model: process.env.AI_MODEL || (process.env.AI_PROVIDER?.toLowerCase() === 'gemini' ? 'gemini-3.1-flash-lite' : ''),
    timeoutMs: Number(process.env.AI_TIMEOUT_MS || 90000),
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
  if (!config.ai.baseUrl || !config.ai.model || !config.ai.apiKey) {
    problems.push('Konfigurasi AI belum lengkap (AI_BASE_URL/AI_API_KEY/AI_MODEL) - endpoint analisis menjawab 503 sampai dilengkapi.');
  }
  if (!config.payments.serverKey) {
    problems.push('MIDTRANS_SERVER_KEY belum dikonfigurasi: pembelian token dinonaktifkan.');
  }
  if (!config.mail.configured) problems.push('SMTP belum dikonfigurasi - reset password via email menjawab 503.');
  return problems;
}
