// Vercel Serverless Function Entry Point — serves all /api/* routes via existing RUNUT Express app.
// Enables single-platform zero-credit-card deployment on Vercel Hobby (personal/academic use)
// connected to Neon Free PostgreSQL (OBJECT_STORAGE_PROVIDER=postgres, Migration v8).
import { createApp } from '../server/src/app.js';
import { initStorage } from '../server/src/repositories/index.js';
import { validateProductionConfig } from '../server/src/config.js';

// Safe zero-cost production defaults on Vercel (never overrides explicit operator values except hard safety locks)
if (process.env.VERCEL) {
  process.env.NODE_ENV = process.env.NODE_ENV || 'production';
  process.env.DATABASE_SSL = process.env.DATABASE_SSL || 'true';
  process.env.PG_CONNECTION_TIMEOUT_MS = process.env.PG_CONNECTION_TIMEOUT_MS || '10000';
  process.env.OBJECT_STORAGE_PROVIDER = process.env.OBJECT_STORAGE_PROVIDER || 'postgres';
  process.env.STRICT_STORAGE_QUOTA_MODE = process.env.STRICT_STORAGE_QUOTA_MODE || 'true';
  process.env.COOKIE_SECURE = process.env.COOKIE_SECURE || 'true';
  process.env.COOKIE_SAME_SITE = process.env.COOKIE_SAME_SITE || 'lax';
  process.env.MIDTRANS_IS_PRODUCTION = 'false';
  process.env.STRICT_FREE_AI_ONLY = 'true';
  if (!process.env.FRONTEND_URL && process.env.VERCEL_URL) {
    process.env.FRONTEND_URL = `https://${process.env.VERCEL_URL}`;
  }
}

let appPromise = null;

async function getExpressApp() {
  if (!appPromise) {
    appPromise = (async () => {
      validateProductionConfig();
      await initStorage();
      return createApp();
    })().catch((err) => {
      appPromise = null;
      throw err;
    });
  }
  return appPromise;
}

export default async function handler(req, res) {
  try {
    const app = await getExpressApp();
    return app(req, res);
  } catch (err) {
    console.error('[runut-vercel] startup error:', err?.message || err);
    res.statusCode = 503;
    res.setHeader('Content-Type', 'application/json; charset=utf-8');
    res.setHeader('Cache-Control', 'no-store');
    res.end(JSON.stringify({
      error: 'Server sedang memulai atau konfigurasi environment (DATABASE_URL / JWT_ACCESS_SECRET) belum lengkap.',
      code: 'SERVER_INIT_FAILED',
    }));
  }
}
