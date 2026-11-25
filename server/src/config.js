import dotenv from 'dotenv';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomBytes } from 'node:crypto';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
dotenv.config({ path: path.resolve(__dirname, '../.env') });
dotenv.config();

const cleanEnv = (v) => String(v ?? '').replace(/^\uFEFF/, '').trim();

const ephemeral = [];

function secretFor(name) {
  const value = cleanEnv(process.env[name]);
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
    url: cleanEnv(process.env.DATABASE_URL),
    poolMax: Number(process.env.PG_POOL_MAX || 10),
    idleTimeoutMs: Number(process.env.PG_IDLE_TIMEOUT_MS || 30000),
    connectionTimeoutMs: Number(process.env.PG_CONNECTION_TIMEOUT_MS || 5000),
    statementTimeoutMs: Number(process.env.PG_STATEMENT_TIMEOUT_MS || 15000),
    ssl: cleanEnv(process.env.DATABASE_SSL),
  },

  jwt: {
    accessSecret: secretFor('JWT_ACCESS_SECRET'),
    accessTtl: cleanEnv(process.env.JWT_ACCESS_TTL) || '1h',
    refreshDays: Number(process.env.REFRESH_TOKEN_DAYS || 30),
  },

  ai: {
    strictFreeOnly: String(process.env.STRICT_FREE_AI_ONLY ?? 'true').trim().toLowerCase() !== 'false',
    failoverEnabled: String(process.env.AI_FAILOVER_ENABLED ?? 'true').trim().toLowerCase() !== 'false',
    maxProviderAttempts: Number(process.env.AI_MAX_PROVIDER_ATTEMPTS || 4),
    maxRetriesPerProvider: Number(process.env.AI_MAX_RETRIES_PER_PROVIDER || 1),
    provider: (cleanEnv(process.env.AI_PROVIDER) || 'openrouter').toLowerCase(),
    baseUrl: (cleanEnv(process.env.OPENROUTER_BASE_URL) || cleanEnv(process.env.AI_BASE_URL) || (cleanEnv(process.env.AI_PROVIDER).toLowerCase() === 'gemini' ? 'https://generativelanguage.googleapis.com/v1beta/openai' : 'https://openrouter.ai/api/v1')).replace(/\/$/, ''),
    apiKey: cleanEnv(process.env.OPENROUTER_API_KEY) || cleanEnv(process.env.GEMINI_API_KEY) || cleanEnv(process.env.AI_API_KEY),
    model: cleanEnv(process.env.OPENROUTER_PRIMARY_MODEL) || cleanEnv(process.env.OPENROUTER_MODEL) || cleanEnv(process.env.AI_MODEL) || (cleanEnv(process.env.AI_PROVIDER).toLowerCase() === 'gemini' ? 'gemini-3.1-flash-lite' : 'particle-ai/particle-1:free'),
    openrouterPrimaryModel: cleanEnv(process.env.OPENROUTER_PRIMARY_MODEL) || cleanEnv(process.env.OPENROUTER_MODEL) || 'particle-ai/particle-1:free',
    openrouterFallbackModel1: cleanEnv(process.env.OPENROUTER_FALLBACK_MODEL_1) || 'baidu/ernie-5.5-flash-preview:free',
    openrouterFallbackModel2: cleanEnv(process.env.OPENROUTER_FALLBACK_MODEL_2) || 'inclusionai/ling-3.2-flash:free',
    openrouterDynamicModel: cleanEnv(process.env.OPENROUTER_DYNAMIC_MODEL) || 'openrouter/free',
    enableNemotronFree: String(process.env.ENABLE_NEMOTRON_FREE || 'false').trim().toLowerCase() === 'true',
    enableGroqFree: String(process.env.ENABLE_GROQ_FREE || 'false').trim().toLowerCase() === 'true',
    groqFreeVerified: String(process.env.GROQ_FREE_VERIFIED || 'false').trim().toLowerCase() === 'true',
    enableTokenHarborFree: String(process.env.ENABLE_TOKEN_HARBOR_FREE || 'false').trim().toLowerCase() === 'true',
    tokenHarborBaseUrl: (cleanEnv(process.env.TOKEN_HARBOR_BASE_URL) || 'https://tokenharbor.ai/v1').replace(/\/$/, ''),
    tokenHarborModel: cleanEnv(process.env.TOKEN_HARBOR_FREE_MODEL) || 'deepseek-v4.1-flash:free',
    tokenHarborApiKey: cleanEnv(process.env.TOKEN_HARBOR_API_KEY),
    enableBeatApiFree: String(process.env.ENABLE_BEATAPI_FREE || 'false').trim().toLowerCase() === 'true',
    beatApiBaseUrl: (cleanEnv(process.env.BEATAPI_BASE_URL) || 'https://direct.beatapi.io/v1').replace(/\/$/, ''),
    beatApiModel: cleanEnv(process.env.BEATAPI_FREE_MODEL) || 'deepseek-v4.1-flash-free',
    beatApiApiKey: cleanEnv(process.env.BEATAPI_API_KEY),
    allowThirdPartyFreeAiProcessing: String(process.env.ALLOW_THIRD_PARTY_FREE_AI_PROCESSING || 'false').trim().toLowerCase() === 'true',
    timeoutMs: Number(process.env.AI_TIMEOUT_MS || 90000),
    geminiApiKey: cleanEnv(process.env.GEMINI_API_KEY),
    geminiModel: cleanEnv(process.env.GEMINI_CONTENT_MODEL) || cleanEnv(process.env.GEMINI_MODEL) || 'gemini-3.1-flash-lite',
  },

  templatePreservation: {
    strict: String(process.env.STRICT_TEMPLATE_PRESERVATION ?? 'true').trim().toLowerCase() !== 'false',
    preserveOriginalDocument: String(process.env.PRESERVE_ORIGINAL_DOCUMENT ?? 'true').trim().toLowerCase() !== 'false',
    allowTemplateRegeneration: String(process.env.ALLOW_TEMPLATE_REGENERATION || 'false').trim().toLowerCase() === 'true',
    allowSilentFormatConversion: String(process.env.ALLOW_SILENT_FORMAT_CONVERSION || 'false').trim().toLowerCase() === 'true',
    maxDocumentTextGrowthRatio: Number(process.env.MAX_DOCUMENT_TEXT_GROWTH_RATIO || 1.15),
    maxTemplateRepairAttempts: Number(process.env.MAX_TEMPLATE_REPAIR_ATTEMPTS || 1),
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
