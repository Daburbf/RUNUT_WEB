// Deployment Durability & Cross-Origin Authentication Tests (Vercel Frontend -> Persistent Backend).
// Verifies:
// 1. Original PDF upload survives simulated backend restart with identical SHA-256 hash & ownership isolation.
// 2. Cross-origin Vercel -> Backend auth sets exact CORS allowlist + SameSite=None; Secure; HttpOnly cookies.
// 3. Untrusted origins are rejected by CORS.
// 4. render.yaml uses a non-expiring external PostgreSQL database and defaults Midtrans to sandbox.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { PDFDocument, StandardFonts } from 'pdf-lib';
import request from 'supertest';
import { createApp } from '../src/app.js';
import { initStorage, documents, tokenTransactions } from '../src/repositories/index.js';
import {
  saveOriginalUploadPersistent,
  getOriginalUploadPersistent,
  clearMemoryFileCache,
} from '../src/services/fileStore.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '../..');

function sha256(buf) {
  return createHash('sha256').update(buf).digest('hex');
}

async function buildSamplePdf() {
  const doc = await PDFDocument.create();
  const page = doc.addPage([595.28, 841.89]);
  const font = await doc.embedFont(StandardFonts.Helvetica);
  page.drawText('Dokumen uji durabilitas penyimpanan persisten RUNUT setelah restart server.', {
    x: 60,
    y: 760,
    size: 12,
    font,
  });
  return Buffer.from(await doc.save({ useObjectStreams: false }));
}

test('Durability: Uploaded original PDF survives backend restart with identical SHA-256 & owner-only access', async () => {
  await initStorage('', { persistPath: null });
  const appInstance1 = createApp();

  const u1 = await request(appInstance1).post('/api/auth/register').send({
    name: 'Pemilik PDF',
    email: `dur-owner-${Date.now()}@runut.test`,
    password: 'StrongPassword123!',
  });
  const u2 = await request(appInstance1).post('/api/auth/register').send({
    name: 'User Lain',
    email: `dur-other-${Date.now()}@runut.test`,
    password: 'StrongPassword123!',
  });
  assert.equal(u1.status, 201);
  assert.equal(u2.status, 201);

  const ownerId = u1.body.user.id;
  const ownerToken = u1.body.accessToken;
  const otherToken = u2.body.accessToken;
  await tokenTransactions.credit({ user_id: ownerId, amount: 10, type: 'purchase', description: 'Topup Durability' });

  const originalPdf = await buildSamplePdf();
  const originalHash = sha256(originalPdf);

  const doc = await documents.create({
    user_id: ownerId,
    title: 'Laporan Durabilitas',
    original_text: 'Dokumen uji durabilitas penyimpanan persisten RUNUT setelah restart server.',
    word_count: 9,
    token_cost: 1,
    file_name: 'laporan-durabilitas.pdf',
  });

  await saveOriginalUploadPersistent(doc.id, {
    userId: ownerId,
    buffer: originalPdf,
    ext: 'pdf',
    originalName: 'laporan-durabilitas.pdf',
  });

  // Simulate backend process restart: clear in-memory file cache & create a fresh Express app instance
  clearMemoryFileCache();
  const appInstance2 = createApp();

  const retrieved = await getOriginalUploadPersistent(doc.id, { userId: ownerId });
  assert.ok(retrieved, 'Original PDF must be retrievable from persistent store after restart');
  assert.equal(sha256(retrieved.buffer), originalHash, 'Retrieved original PDF SHA-256 must match uploaded file byte-for-byte');

  // Another user must NOT retrieve the file directly or via HTTP download
  const unauthorizedRead = await getOriginalUploadPersistent(doc.id, { userId: u2.body.user.id });
  assert.equal(unauthorizedRead, null);
  await request(appInstance2)
    .get(`/api/documents/${doc.id}/download?format=pdf`)
    .set('Authorization', `Bearer ${otherToken}`)
    .expect(403);

  // Owner downloads the PDF after restart and gets exact preserved original bytes
  const dl = await request(appInstance2)
    .get(`/api/documents/${doc.id}/download?format=pdf`)
    .set('Authorization', `Bearer ${ownerToken}`)
    .buffer(true)
    .parse((res, cb) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => cb(null, Buffer.concat(chunks)));
    });
  assert.equal(dl.status, 200);
  assert.equal(sha256(dl.body), originalHash);
});

test('Cross-Origin Vercel Auth: exact CORS allowlist, SameSite=None; Secure; HttpOnly cookie, refresh & logout', async () => {
  await initStorage('', { persistPath: null });
  const prevFrontend = process.env.FRONTEND_URL;
  const prevCors = process.env.CORS_ORIGINS;
  const prevSameSite = process.env.COOKIE_SAME_SITE;

  const vercelOrigin = 'https://runut-web.vercel.app';
  process.env.FRONTEND_URL = vercelOrigin;
  process.env.CORS_ORIGINS = vercelOrigin;
  process.env.COOKIE_SAME_SITE = 'none';

  try {
    const app = createApp();

    // Allowed Vercel origin receives exact ACAO + ACAC
    const reg = await request(app)
      .post('/api/auth/register')
      .set('Origin', vercelOrigin)
      .send({
        name: 'Vercel User',
        email: `vercel-cors-${Date.now()}@runut.test`,
        password: 'StrongPassword123!',
      });
    assert.equal(reg.status, 201);
    assert.equal(reg.headers['access-control-allow-origin'], vercelOrigin);
    assert.equal(reg.headers['access-control-allow-credentials'], 'true');

    const setCookie = String((reg.headers['set-cookie'] || [])[0] || '');
    assert.match(setCookie, /HttpOnly/i);
    assert.match(setCookie, /SameSite=None/i);
    assert.match(setCookie, /Secure/i);
    assert.match(setCookie, /Path=\/api\/auth/i);

    // Untrusted origin must NOT receive Access-Control-Allow-Origin
    const evilPreflight = await request(app)
      .get('/api/health')
      .set('Origin', 'https://evil-attacker.example');
    assert.equal(evilPreflight.headers['access-control-allow-origin'], undefined);

    // Credentialed refresh works from allowed Vercel origin
    const refreshed = await request(app)
      .post('/api/auth/refresh')
      .set('Origin', vercelOrigin)
      .set('Cookie', reg.headers['set-cookie']);
    assert.equal(refreshed.status, 200);
    assert.ok(refreshed.body.accessToken);
    assert.equal(refreshed.headers['access-control-allow-origin'], vercelOrigin);

    // Logout clears cookie with matching cross-origin attributes
    const loggedOut = await request(app)
      .post('/api/auth/logout')
      .set('Origin', vercelOrigin)
      .set('Cookie', refreshed.headers['set-cookie']);
    assert.equal(loggedOut.status, 200);
    const clearedCookie = String((loggedOut.headers['set-cookie'] || [])[0] || '');
    assert.match(clearedCookie, /SameSite=None/i);
    assert.match(clearedCookie, /Secure/i);
  } finally {
    if (prevFrontend === undefined) delete process.env.FRONTEND_URL; else process.env.FRONTEND_URL = prevFrontend;
    if (prevCors === undefined) delete process.env.CORS_ORIGINS; else process.env.CORS_ORIGINS = prevCors;
    if (prevSameSite === undefined) delete process.env.COOKIE_SAME_SITE; else process.env.COOKIE_SAME_SITE = prevSameSite;
  }
});

test('Render Blueprint: avoids expiring 30-day Render free DB, uses same-origin lax cookies + R2, and defaults Midtrans to sandbox mode', () => {
  const renderYaml = readFileSync(path.join(ROOT, 'render.yaml'), 'utf8');
  assert.doesNotMatch(renderYaml, /^databases:/m, 'render.yaml must not provision an expiring 30-day Render free PostgreSQL database');
  assert.match(renderYaml, /key:\s*DATABASE_URL\r?\n\s*sync:\s*false/);
  assert.match(renderYaml, /key:\s*MIDTRANS_IS_PRODUCTION\r?\n\s*value:\s*"false"/);
  assert.match(renderYaml, /key:\s*COOKIE_SAME_SITE\r?\n\s*value:\s*"lax"/);
  assert.match(renderYaml, /key:\s*COOKIE_SECURE\r?\n\s*value:\s*"true"/);
  assert.match(renderYaml, /key:\s*FILE_STORAGE_PROVIDER\r?\n\s*value:\s*"r2"/);
});
