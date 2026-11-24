// Comprehensive Automated Tests for:
// 1. Persistent __Secure-runut_refresh Cookies (SameSite=Lax, Secure, HttpOnly, Max-Age=2592000, Expires, Path=/api/auth, no Domain)
// 2. Cloudflare Pages Same-Origin API Proxy (functions/api/[[path]].js)
// 3. Cloudflare R2 Private Persistent Document Storage (AWS SigV4, PDF/DOCX restart durability, 403 isolation, fail-closed errors)
import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { createHash } from 'node:crypto';
import JSZip from 'jszip';
import { PDFDocument, StandardFonts } from 'pdf-lib';
import request from 'supertest';
import { createApp } from '../src/app.js';
import { initStorage, documents, refreshTokens } from '../src/repositories/index.js';
import {
  saveOriginalUploadPersistent,
  getOriginalUploadPersistent,
  deleteOriginalUploadPersistent,
  clearMemoryFileCache,
} from '../src/services/fileStore.js';
import {
  buildPrivateObjectKey,
  generateR2SignedDownloadUrl,
} from '../src/services/r2Storage.js';
import {
  reserveR2Operation,
  getR2QuotaSnapshot,
} from '../src/services/r2Quota.js';
import {
  onRequest as pagesProxyOnRequest,
  parseTrustedBackendOrigin,
  sanitizeSetCookieForSameOrigin,
} from '../../functions/api/[[path]].js';

function sha256(buf) {
  return createHash('sha256').update(buf).digest('hex');
}

async function buildSamplePdf() {
  const doc = await PDFDocument.create();
  const page = doc.addPage([595.28, 841.89]);
  const font = await doc.embedFont(StandardFonts.Helvetica);
  page.drawText('Dokumen PDF uji ketahanan penyimpanan Cloudflare R2.', { x: 60, y: 760, size: 12, font });
  return Buffer.from(await doc.save({ useObjectStreams: false }));
}

async function buildSampleDocx() {
  const zip = new JSZip();
  zip.file('[Content_Types].xml', '<?xml version="1.0" encoding="UTF-8"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"></Types>');
  zip.file('word/document.xml', '<?xml version="1.0" encoding="UTF-8"?><w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body><w:p><w:r><w:t>Dokumen DOCX uji Cloudflare R2.</w:t></w:r></w:p></w:body></w:document>');
  return zip.generateAsync({ type: 'nodebuffer' });
}

function startMockR2Server() {
  const objects = new Map();
  let failUploads = false;
  const server = http.createServer((req, res) => {
    const auth = req.headers.authorization || '';
    if (!auth.startsWith('AWS4-HMAC-SHA256 ')) {
      res.writeHead(403);
      res.end('Missing AWS SigV4');
      return;
    }
    const key = req.url.split('?')[0];
    if (req.method === 'PUT') {
      if (failUploads) {
        res.writeHead(503);
        res.end('R2 Outage');
        return;
      }
      const chunks = [];
      req.on('data', (c) => chunks.push(c));
      req.on('end', () => {
        objects.set(key, {
          buffer: Buffer.concat(chunks),
          contentType: req.headers['content-type'] || 'application/octet-stream',
        });
        res.writeHead(200);
        res.end();
      });
      return;
    }
    if (req.method === 'GET') {
      const entry = objects.get(key);
      if (!entry) {
        res.writeHead(404);
        res.end('NoSuchKey');
        return;
      }
      res.writeHead(200, { 'Content-Type': entry.contentType });
      res.end(entry.buffer);
      return;
    }
    if (req.method === 'DELETE') {
      objects.delete(key);
      res.writeHead(204);
      res.end();
      return;
    }
    res.writeHead(405);
    res.end();
  });

  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address();
      resolve({
        server,
        endpoint: `http://127.0.0.1:${port}`,
        objects,
        setFailUploads: (v) => { failUploads = v; },
      });
    });
  });
}

// 1. Persistent __Secure-runut_refresh Cookie Tests
test('Persistent Auth Cookie: __Secure-runut_refresh has HttpOnly, Secure, SameSite=Lax, Max-Age=2592000, Expires, Path=/api/auth, no Domain, survives restart & rotates safely', async () => {
  await initStorage('', { persistPath: null });
  const prevSameSite = process.env.COOKIE_SAME_SITE;
  const prevSecure = process.env.COOKIE_SECURE;
  process.env.COOKIE_SAME_SITE = 'lax';
  process.env.COOKIE_SECURE = 'true';

  try {
    const app = createApp();
    const reg = await request(app).post('/api/auth/register').send({
      name: 'Persistent User',
      email: `persist-${Date.now()}@runut.test`,
      password: 'StrongPassword123!',
    });
    assert.equal(reg.status, 201);

    const setCookies = reg.headers['set-cookie'] || [];
    const refreshCookieHeader = setCookies.find((c) => c.startsWith('__Secure-runut_refresh='));
    assert.ok(refreshCookieHeader, 'Must issue __Secure-runut_refresh cookie');
    assert.match(refreshCookieHeader, /HttpOnly/i);
    assert.match(refreshCookieHeader, /Secure/i);
    assert.match(refreshCookieHeader, /SameSite=Lax/i);
    assert.match(refreshCookieHeader, /Max-Age=2592000/i);
    assert.match(refreshCookieHeader, /Expires=/i);
    assert.match(refreshCookieHeader, /Path=\/api\/auth/i);
    assert.doesNotMatch(refreshCookieHeader, /Domain=/i, 'Host-only cookie must NOT include Domain attribute');

    // Simulate browser restart: extract persisted cookie value and send from a completely fresh HTTP client
    const cookiePair = refreshCookieHeader.split(';')[0];
    const afterBrowserRestart = await request(app)
      .post('/api/auth/refresh')
      .set('Cookie', cookiePair);
    assert.equal(afterBrowserRestart.status, 200);
    assert.ok(afterBrowserRestart.body.accessToken);
    const rotatedCookieHeader = (afterBrowserRestart.headers['set-cookie'] || []).find((c) => c.startsWith('__Secure-runut_refresh='));
    assert.ok(rotatedCookieHeader);
    const rotatedPair = rotatedCookieHeader.split(';')[0];
    assert.notEqual(rotatedPair, cookiePair, 'Refresh token must rotate on every refresh');

    // Verify new access token works
    await request(app)
      .get('/api/auth/me')
      .set('Authorization', `Bearer ${afterBrowserRestart.body.accessToken}`)
      .expect(200);

    // Logout revokes session and clears __Secure-runut_refresh with matching Path/SameSite/Secure/HttpOnly
    const logoutRes = await request(app)
      .post('/api/auth/logout')
      .set('Cookie', rotatedPair);
    assert.equal(logoutRes.status, 200);
    const clearedHeader = (logoutRes.headers['set-cookie'] || []).find((c) => c.startsWith('__Secure-runut_refresh='));
    assert.ok(clearedHeader);
    assert.match(clearedHeader, /Path=\/api\/auth/i);
    assert.match(clearedHeader, /SameSite=Lax/i);
    assert.match(clearedHeader, /Secure/i);
    assert.match(clearedHeader, /HttpOnly/i);
    assert.doesNotMatch(clearedHeader, /Domain=/i);

    // Using the revoked cookie after logout must fail
    await request(app).post('/api/auth/refresh').set('Cookie', rotatedPair).expect(401);

    // Expired refresh token must be rejected
    const expiredRaw = 'expired-token-value-1234567890';
    await refreshTokens.create({
      user_id: reg.body.user.id,
      token_hash: sha256(expiredRaw),
      expires_at: new Date(Date.now() - 60_000).toISOString(),
    });
    await request(app)
      .post('/api/auth/refresh')
      .set('Cookie', `__Secure-runut_refresh=${expiredRaw}`)
      .expect(401);
  } finally {
    if (prevSameSite === undefined) delete process.env.COOKIE_SAME_SITE; else process.env.COOKIE_SAME_SITE = prevSameSite;
    if (prevSecure === undefined) delete process.env.COOKIE_SECURE; else process.env.COOKIE_SECURE = prevSecure;
  }
});

// 2. Cloudflare Pages Same-Origin API Proxy Tests
test('Cloudflare Pages Proxy: forwards /api/*, preserves multiple Set-Cookie headers without Domain, blocks open-proxy & external redirects', async () => {
  assert.equal(parseTrustedBackendOrigin('https://runut-web.onrender.com'), 'https://runut-web.onrender.com');
  assert.equal(parseTrustedBackendOrigin('http://evil.example.com'), null);
  assert.equal(parseTrustedBackendOrigin('https://user:pass@runut-web.onrender.com'), null);
  assert.equal(parseTrustedBackendOrigin('https://runut-web.onrender.com/subpath'), null);

  assert.equal(
    sanitizeSetCookieForSameOrigin('__Secure-runut_refresh=abc; Path=/api/auth; Domain=runut-web.onrender.com; HttpOnly; Secure; SameSite=Lax'),
    '__Secure-runut_refresh=abc; Path=/api/auth; HttpOnly; Secure; SameSite=Lax',
  );

  // Missing BACKEND_ORIGIN -> 503 PROXY_MISCONFIGURED
  const badCfgRes = await pagesProxyOnRequest({
    request: new Request('https://runut-web.pages.dev/api/health'),
    env: {},
  });
  assert.equal(badCfgRes.status, 503);

  // Start real local HTTP backend to test full end-to-end proxy request/response + multiple Set-Cookie headers
  const mockBackend = http.createServer((req, res) => {
    if (req.url === '/api/redirect-evil') {
      res.writeHead(302, { Location: 'https://attacker.example/steal' });
      res.end();
      return;
    }
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => {
      res.setHeader('Set-Cookie', [
        '__Secure-runut_refresh=tok123; Max-Age=2592000; Path=/api/auth; Domain=runut-web.onrender.com; HttpOnly; Secure; SameSite=Lax',
        'runut_hint=1; Path=/; SameSite=Lax',
      ]);
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({
        url: req.url,
        method: req.method,
        cookie: req.headers.cookie || null,
        auth: req.headers.authorization || null,
        body: Buffer.concat(chunks).toString('utf8'),
      }));
    });
  });

  await new Promise((r) => mockBackend.listen(0, '127.0.0.1', r));
  const { port } = mockBackend.address();
  const backendOrigin = `http://127.0.0.1:${port}`;

  try {
    const proxyRes = await pagesProxyOnRequest({
      request: new Request('https://runut-web.pages.dev/api/auth/login?next=home', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Cookie: '__Secure-runut_refresh=existing',
          Authorization: 'Bearer demo-jwt',
        },
        body: JSON.stringify({ email: 'a@b.com' }),
      }),
      env: { BACKEND_ORIGIN: backendOrigin },
    });

    assert.equal(proxyRes.status, 200);
    const payload = await proxyRes.json();
    assert.equal(payload.url, '/api/auth/login?next=home');
    assert.equal(payload.method, 'POST');
    assert.equal(payload.cookie, '__Secure-runut_refresh=existing');
    assert.equal(payload.auth, 'Bearer demo-jwt');
    assert.equal(payload.body, '{"email":"a@b.com"}');

    const cookies = proxyRes.headers.getSetCookie();
    assert.equal(cookies.length, 2, 'Multiple Set-Cookie headers must remain separate');
    assert.match(cookies[0], /^__Secure-runut_refresh=tok123/);
    assert.doesNotMatch(cookies[0], /Domain=/i, 'Proxy must strip upstream Render Domain attribute');
    assert.match(cookies[1], /^runut_hint=1/);

    // External upstream redirect must be blocked (502 UNTRUSTED_UPSTREAM_REDIRECT)
    const evilRedir = await pagesProxyOnRequest({
      request: new Request('https://runut-web.pages.dev/api/redirect-evil'),
      env: { BACKEND_ORIGIN: backendOrigin },
    });
    assert.equal(evilRedir.status, 502);
    const redirBody = await evilRedir.json();
    assert.equal(redirBody.code, 'UNTRUSTED_UPSTREAM_REDIRECT');
  } finally {
    await new Promise((r) => mockBackend.close(r));
  }
});

// 3. Cloudflare R2 Private Persistent Storage Tests
test('Cloudflare R2 Storage: PDF & DOCX survive restart with SHA-256 integrity, 403 isolation, signed URLs, and fail-closed on outage', async () => {
  await initStorage('', { persistPath: null });
  const mockR2 = await startMockR2Server();

  const r2Env = {
    NODE_ENV: 'production',
    FILE_STORAGE_PROVIDER: 'r2',
    R2_ENDPOINT: mockR2.endpoint,
    R2_ACCOUNT_ID: 'testaccount123',
    R2_ACCESS_KEY_ID: 'test-access-key',
    R2_SECRET_ACCESS_KEY: 'test-secret-key',
    R2_BUCKET: 'runut-private-docs',
  };

  try {
    const ownerId = '11111111-1111-4111-8111-111111111111';
    const otherUserId = '22222222-2222-4222-8222-222222222222';
    const pdfBuf = await buildSamplePdf();
    const docxBuf = await buildSampleDocx();
    const pdfHash = sha256(pdfBuf);
    const docxHash = sha256(docxBuf);

    const pdfDoc = await documents.create({
      user_id: ownerId,
      title: 'R2 PDF',
      original_text: 'Dokumen PDF uji R2.',
      word_count: 4,
      token_cost: 1,
      file_name: 'r2.pdf',
    });
    const docxDoc = await documents.create({
      user_id: ownerId,
      title: 'R2 DOCX',
      original_text: 'Dokumen DOCX uji R2.',
      word_count: 4,
      token_cost: 1,
      file_name: 'r2.docx',
    });

    const savedPdf = await saveOriginalUploadPersistent(pdfDoc.id, {
      userId: ownerId,
      buffer: pdfBuf,
      ext: 'pdf',
      originalName: 'r2.pdf',
      env: r2Env,
    });
    const savedDocx = await saveOriginalUploadPersistent(docxDoc.id, {
      userId: ownerId,
      buffer: docxBuf,
      ext: 'docx',
      originalName: 'r2.docx',
      env: r2Env,
    });

    assert.equal(savedPdf.storageProvider, 'r2');
    assert.equal(savedPdf.storageKey, buildPrivateObjectKey(ownerId, pdfDoc.id, 'pdf'));
    assert.equal(savedDocx.storageProvider, 'r2');

    // Simulate backend restart: clear memory cache completely
    clearMemoryFileCache();

    // Retrieve both from R2 and verify SHA-256 byte-for-byte
    const gotPdf = await getOriginalUploadPersistent(pdfDoc.id, { userId: ownerId, env: r2Env });
    const gotDocx = await getOriginalUploadPersistent(docxDoc.id, { userId: ownerId, env: r2Env });
    assert.equal(sha256(gotPdf.buffer), pdfHash);
    assert.equal(sha256(gotDocx.buffer), docxHash);

    // Cross-user access denied
    const crossRead = await getOriginalUploadPersistent(pdfDoc.id, { userId: otherUserId, env: r2Env });
    assert.equal(crossRead, null);

    // Strict quota mode blocks reusable signed download URLs by default; compatibility mode requires explicit opt-out
    assert.throws(
      () => generateR2SignedDownloadUrl(savedPdf.storageKey, { expiresInSeconds: 300, env: r2Env }),
      (err) => err?.code === 'SIGNED_URL_DISABLED_IN_STRICT_QUOTA_MODE' && err?.status === 403,
    );
    const signedUrl = generateR2SignedDownloadUrl(savedPdf.storageKey, {
      expiresInSeconds: 120,
      allowCompatibilitySignedUrl: true,
      env: { ...r2Env, STRICT_R2_QUOTA_MODE: 'false' },
    });
    assert.match(signedUrl, /X-Amz-Algorithm=AWS4-HMAC-SHA256/);
    assert.match(signedUrl, /X-Amz-Expires=120/);
    assert.match(signedUrl, /X-Amz-Signature=[0-9a-f]{64}/);

    // Missing R2 object returns controlled 404 R2_OBJECT_MISSING error
    mockR2.objects.clear();
    await assert.rejects(
      () => getOriginalUploadPersistent(pdfDoc.id, { userId: ownerId, env: r2Env }),
      (err) => err?.code === 'R2_OBJECT_MISSING' && err?.status === 404,
    );

    // R2 outage during upload fails explicitly (503) — never silently falls back to ephemeral local disk!
    mockR2.setFailUploads(true);
    await assert.rejects(
      () => saveOriginalUploadPersistent('33333333-3333-4333-8333-333333333333', {
        userId: ownerId,
        buffer: pdfBuf,
        ext: 'pdf',
        originalName: 'fail.pdf',
        env: r2Env,
      }),
      (err) => err?.code === 'R2_UPLOAD_FAILED' && err?.status === 503,
    );

    await deleteOriginalUploadPersistent(pdfDoc.id, { env: r2Env });
    await deleteOriginalUploadPersistent(docxDoc.id, { env: r2Env });
  } finally {
    await new Promise((r) => mockR2.server.close(r));
  }
});

// 4. Persistent R2 Application-Side Safety Quota Tests (80% free-tier margin + concurrency guard)
test('Cloudflare R2 Safety Quotas: blocks uploads before 8 GB / Class A / Class B thresholds and prevents concurrent bypass without deleting existing files', async () => {
  await initStorage('', { persistPath: null });
  const tightEnv = {
    R2_MAX_MANAGED_BYTES: '2048',
    R2_CLASS_A_MONTHLY_LIMIT: '3',
    R2_CLASS_B_MONTHLY_LIMIT: '2',
  };

  // Concurrent reservation: two 1500-byte uploads cannot both reserve inside a 2048-byte cap
  const r1 = await reserveR2Operation('PutObject', { bytes: 1500, env: tightEnv });
  await assert.rejects(
    () => reserveR2Operation('PutObject', { bytes: 1500, env: tightEnv }),
    (err) => err?.code === 'R2_STORAGE_QUOTA_LIMIT' && err?.status === 503,
  );
  await r1.commit();

  // Existing committed bytes stay preserved (never auto-deleted to recover quota)
  const snap = await getR2QuotaSnapshot({ env: tightEnv });
  assert.equal(snap.managed_bytes, 1500);
  assert.equal(snap.object_count, 1);

  // Class A limit reached after 3rd op
  const r2 = await reserveR2Operation('PutObject', { bytes: 100, env: tightEnv });
  await r2.commit();
  const r3 = await reserveR2Operation('PutObject', { bytes: 100, env: tightEnv });
  await r3.commit();
  await assert.rejects(
    () => reserveR2Operation('PutObject', { bytes: 50, env: tightEnv }),
    (err) => err?.code === 'R2_CLASS_A_QUOTA_LIMIT' && err?.status === 503,
  );

  // Class B read limit enforced
  const b1 = await reserveR2Operation('GetObject', { env: tightEnv });
  await b1.commit();
  const b2 = await reserveR2Operation('GetObject', { env: tightEnv });
  await b2.commit();
  await assert.rejects(
    () => reserveR2Operation('GetObject', { env: tightEnv }),
    (err) => err?.code === 'R2_CLASS_B_QUOTA_LIMIT' && err?.status === 503,
  );
});
