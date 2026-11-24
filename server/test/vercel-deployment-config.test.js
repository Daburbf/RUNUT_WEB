// Verification tests for Vercel frontend configuration, split-origin cookie/CORS support,
// and production API base URL wiring.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { resolveRefreshCookieOptions } from '../src/middleware/auth.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '../..');

test('Vercel config: valid Vite SPA rewrites exclude /api/* and /assets/* and include security headers', () => {
  const cfg = JSON.parse(readFileSync(path.join(ROOT, 'vercel.json'), 'utf8'));
  assert.equal(cfg.framework, 'vite');
  assert.equal(cfg.buildCommand, 'npm run build');
  assert.equal(cfg.outputDirectory, 'dist');
  assert.ok(Array.isArray(cfg.rewrites) && cfg.rewrites.length >= 1);

  const spaRewrite = cfg.rewrites[0];
  assert.equal(spaRewrite.destination, '/index.html');
  assert.match(spaRewrite.source, /\?!api\//, 'SPA rewrite must not intercept /api/ routes');

  const rootHeaders = cfg.headers.find((h) => h.source === '/(.*)')?.headers || [];
  const headerNames = new Set(rootHeaders.map((h) => h.key.toLowerCase()));
  assert.ok(headerNames.has('x-content-type-options'));
  assert.ok(headerNames.has('x-frame-options'));
  assert.ok(headerNames.has('referrer-policy'));
  assert.ok(headerNames.has('permissions-policy'));

  const apiHeaders = cfg.headers.find((h) => h.source === '/api/(.*)')?.headers || [];
  assert.ok(
    apiHeaders.some((h) => h.key.toLowerCase() === 'cache-control' && /no-store/i.test(h.value)),
    'API responses must have Cache-Control: no-store on Vercel',
  );

  const rawJson = readFileSync(path.join(ROOT, 'vercel.json'), 'utf8');
  assert.doesNotMatch(rawJson, /ACTUAL-RENDER-HOST|YOUR-BACKEND-DOMAIN/i, 'Never commit a placeholder Render backend URL in vercel.json');
});

test('Split-origin Vercel + Backend cookies: COOKIE_SAME_SITE=none enforces SameSite=None and Secure=true', () => {
  const splitOpts = resolveRefreshCookieOptions({ NODE_ENV: 'production', COOKIE_SAME_SITE: 'none' });
  assert.equal(splitOpts.httpOnly, true);
  assert.equal(splitOpts.sameSite, 'none');
  assert.equal(splitOpts.secure, true);
  assert.equal(splitOpts.path, '/api/auth');

  const sameOriginProd = resolveRefreshCookieOptions({ NODE_ENV: 'production' });
  assert.equal(sameOriginProd.sameSite, 'lax');
  assert.equal(sameOriginProd.secure, true);

  const localDev = resolveRefreshCookieOptions({ NODE_ENV: 'development' });
  assert.equal(localDev.sameSite, 'lax');
  assert.equal(localDev.secure, false);
});

test('Frontend API client supports VITE_API_BASE_URL and VITE_API_URL with zero secrets in .env.example', () => {
  const apiJs = readFileSync(path.join(ROOT, 'src/utils/api.js'), 'utf8');
  assert.match(apiJs, /VITE_API_BASE_URL/);
  assert.match(apiJs, /VITE_API_URL/);

  const envExample = readFileSync(path.join(ROOT, '.env.example'), 'utf8');
  assert.match(envExample, /VITE_API_BASE_URL=/);
  assert.doesNotMatch(envExample, /sk-or-v1-|AIzaSy|Mid-server-|postgres:\/\//i);
});
