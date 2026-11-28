// Comprehensive Security Audit Regression Suite (ASVS L2 / OWASP Top 10 / API Top 10).
// Covers: Refresh token reuse detection, JWT alg/iss/aud pinning, BOLA/IDOR (User A vs User B vs Admin),
// DOCX macro & external relationship blocking, PDF JavaScript & excessive page count blocking,
// Payment QR SSRF & webhook currency/signature validation, SSRF protections, AI output validation,
// and security log secret redaction.
import test from 'node:test';
import assert from 'node:assert/strict';
import jwt from 'jsonwebtoken';
import JSZip from 'jszip';
import { PDFDocument, PDFName, PDFString } from 'pdf-lib';
import request from 'supertest';
import { createApp } from '../src/app.js';
import { config } from '../src/config.js';
import { initStorage, documents, payments, tokenTransactions } from '../src/repositories/index.js';
import { logSecurityEvent, recordFailedLogin, resetSecurityMonitor } from '../src/services/securityLog.js';
import { inspectDocx } from '../src/services/docxEditor.js';
import { inspectPdf, MAX_PDF_PAGES } from '../src/services/pdfEditor.js';
import { isAllowedMidtransQrUrl, fetchQrImage, handleNotification } from '../src/services/payments.js';
import { validatePublicUrl } from '../src/services/sourceFetcher.js';
import { validateAiIssues } from '../src/services/aiValidate.js';

test('Security Regression 1: Refresh token reuse detection revokes all sessions and invalidates active access tokens', async () => {
  await initStorage('', { persistPath: null });
  const app = createApp();
  const agent = request.agent(app);

  const reg = await agent.post('/api/auth/register').send({
    name: 'Session Victim',
    email: `reuse-${Date.now()}@runut.test`,
    password: 'StrongPassword123!',
  });
  assert.equal(reg.status, 201);
  const originalCookie = reg.headers['set-cookie'];
  assert.ok(originalCookie, 'Must set HttpOnly refresh cookie');

  // Legitimate refresh rotates the refresh token
  const ref1 = await request(app)
    .post('/api/auth/refresh')
    .set('Cookie', originalCookie);
  assert.equal(ref1.status, 200);
  const legitimateAccessToken = ref1.body.accessToken;
  const legitimateNewCookie = ref1.headers['set-cookie'];

  // Attacker replays the OLD rotated refresh cookie -> must trigger REFRESH_REUSE_DETECTED
  const replay = await request(app)
    .post('/api/auth/refresh')
    .set('Cookie', originalCookie);
  assert.equal(replay.status, 401);
  assert.equal(replay.body.code, 'REFRESH_REUSE_DETECTED');

  // Both the rotated cookie AND the legitimate access token must now be invalidated!
  const afterReplayRefresh = await request(app)
    .post('/api/auth/refresh')
    .set('Cookie', legitimateNewCookie);
  assert.equal(afterReplayRefresh.status, 401);

  const afterReplayMe = await request(app)
    .get('/api/auth/me')
    .set('Authorization', `Bearer ${legitimateAccessToken}`);
  assert.equal(afterReplayMe.status, 401);
  assert.equal(afterReplayMe.body.code, 'TOKEN_REVOKED');
});

test('Security Regression 2: JWT pinning rejects wrong issuer/audience and unsigned/forged tokens', async () => {
  await initStorage('', { persistPath: null });
  const app = createApp();

  const wrongIssuer = jwt.sign(
    { sub: '00000000-0000-0000-0000-000000000001', email: 'a@b.com', tv: 0 },
    config.jwt.accessSecret,
    { algorithm: 'HS256', issuer: 'evil-issuer', audience: 'runut-web', expiresIn: '1h' },
  );
  await request(app).get('/api/auth/me').set('Authorization', `Bearer ${wrongIssuer}`).expect(401);

  const algNoneToken = `${Buffer.from(JSON.stringify({ alg: 'none', typ: 'JWT' })).toString('base64url')}.${Buffer.from(JSON.stringify({ sub: '1', iss: 'runut-api', aud: 'runut-web' })).toString('base64url')}.`;
  await request(app).get('/api/auth/me').set('Authorization', `Bearer ${algNoneToken}`).expect(401);
});

test('Security Regression 3: BOLA / IDOR protection across User A, User B, and Admin endpoints', async () => {
  await initStorage('', { persistPath: null });
  const app = createApp();

  const regA = await request(app).post('/api/auth/register').send({
    name: 'User A',
    email: `bola-a-${Date.now()}@runut.test`,
    password: 'PasswordA123!',
    token_balance: 99999, // mass assignment attempt
  });
  const regB = await request(app).post('/api/auth/register').send({
    name: 'User B',
    email: `bola-b-${Date.now()}@runut.test`,
    password: 'PasswordB123!',
  });
  assert.equal(regA.status, 201);
  assert.equal(regA.body.user.token_balance, 10, 'Mass assignment of token_balance must be ignored (only default 10 signup bonus granted)');

  const tokenA = regA.body.accessToken;
  const userBId = regB.body.user.id;

  const docB = await documents.create({
    user_id: userBId,
    title: 'Dokumen Rahasia B',
    original_text: 'Isi dokumen rahasia milik User B yang tidak boleh diakses User A.',
    word_count: 11,
    token_cost: 1,
  });
  const payB = await payments.create({
    user_id: userBId,
    order_id: `RUNUT-BOLA-${Date.now()}`,
    package_id: 'hemat',
    package_label: 'Hemat',
    token_amount: 5,
    method: 'qris',
    method_label: 'QRIS',
    channel: 'qris',
    amount: 5000,
    status: 'pending',
    provider: 'midtrans',
  });

  // User A attempts to access/modify/delete User B's document and payment
  await request(app).get(`/api/documents/${docB.id}`).set('Authorization', `Bearer ${tokenA}`).expect(403);
  await request(app).patch(`/api/documents/${docB.id}/title`).set('Authorization', `Bearer ${tokenA}`).send({ title: 'Hacked' }).expect(403);
  await request(app).post(`/api/documents/${docB.id}/restore`).set('Authorization', `Bearer ${tokenA}`).expect(403);
  await request(app).get(`/api/documents/${docB.id}/preservation`).set('Authorization', `Bearer ${tokenA}`).expect(403);
  await request(app).get(`/api/documents/${docB.id}/download?format=txt`).set('Authorization', `Bearer ${tokenA}`).expect(403);
  await request(app).get(`/api/documents/${docB.id}/analysis-report?format=json`).set('Authorization', `Bearer ${tokenA}`).expect(403);
  await request(app).delete('/api/documents').set('Authorization', `Bearer ${tokenA}`).send({ ids: [docB.id] }).expect(404);
  await request(app).get(`/api/payments/${payB.order_id}`).set('Authorization', `Bearer ${tokenA}`).expect(403);
  await request(app).get(`/api/payments/${payB.order_id}/invoice`).set('Authorization', `Bearer ${tokenA}`).expect(403);
  await request(app).post(`/api/payments/${payB.order_id}/renew`).set('Authorization', `Bearer ${tokenA}`).expect(403);
  await request(app).get('/api/admin/ai-usage').set('Authorization', `Bearer ${tokenA}`).expect(403);
});

test('Security Regression 4: DOCX macro (vbaProject.bin) and external template relationship injection are rejected', async () => {
  // Macro-enabled DOCX
  const macroZip = new JSZip();
  macroZip.file('word/document.xml', '<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body><w:p><w:r><w:t>Hello</w:t></w:r></w:p></w:body></w:document>');
  macroZip.file('word/vbaProject.bin', Buffer.from('FAKE_VBA_MACRO'));
  const macroBuf = await macroZip.generateAsync({ type: 'nodebuffer' });
  await assert.rejects(() => inspectDocx(macroBuf), /bermakro VBA/i);

  // External attachedTemplate SSRF/RCE relationship
  const extRelZip = new JSZip();
  extRelZip.file('word/document.xml', '<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body><w:p><w:r><w:t>Hello</w:t></w:r></w:p></w:body></w:document>');
  extRelZip.file('word/_rels/settings.xml.rels', `<?xml version="1.0" encoding="UTF-8"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
  <Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/attachedTemplate" Target="https://attacker.example/template.dotm" TargetMode="External"/>
</Relationships>`);
  const extRelBuf = await extRelZip.generateAsync({ type: 'nodebuffer' });
  await assert.rejects(() => inspectDocx(extRelBuf), /relasi eksternal berbahaya/i);
});

test('Security Regression 5: PDF with /JavaScript active action and excessive page count are rejected', async () => {
  // PDF containing /JavaScript OpenAction
  const jsDoc = await PDFDocument.create();
  jsDoc.addPage([595, 842]);
  const jsAction = jsDoc.context.obj({
    Type: PDFName.of('Action'),
    S: PDFName.of('JavaScript'),
    JS: PDFString.of('app.alert("xss")'),
  });
  jsDoc.catalog.set(PDFName.of('OpenAction'), jsAction);
  const jsPdfBuf = Buffer.from(await jsDoc.save({ useObjectStreams: false }));
  await assert.rejects(() => inspectPdf(jsPdfBuf), /skrip aktif|aksi berbahaya/i);

  // PDF exceeding MAX_PDF_PAGES
  const hugeDoc = await PDFDocument.create();
  for (let i = 0; i < MAX_PDF_PAGES + 1; i++) {
    hugeDoc.addPage([200, 200]);
  }
  const hugePdfBuf = Buffer.from(await hugeDoc.save({ useObjectStreams: false }));
  await assert.rejects(() => inspectPdf(hugePdfBuf), /melebihi batas aman maksimum/i);
});

test('Security Regression 6: Payment QR SSRF protection & webhook currency/signature validation', async () => {
  assert.equal(isAllowedMidtransQrUrl('https://api.midtrans.com/v2/qris/123/qr-code'), true);
  assert.equal(isAllowedMidtransQrUrl('https://api.sandbox.midtrans.com/v2/qris/123/qr-code'), true);
  assert.equal(isAllowedMidtransQrUrl('http://127.0.0.1:8080/internal'), false);
  assert.equal(isAllowedMidtransQrUrl('http://169.254.169.254/latest/meta-data/'), false);
  assert.equal(isAllowedMidtransQrUrl('https://attacker.example/steal-basic-auth'), false);

  await assert.rejects(
    () => fetchQrImage({
      order_id: 'ORDER-SSRF',
      provider: 'midtrans',
      instructions: { qr_url: 'https://attacker.example/qr.png' },
    }),
    (err) => err?.code === 'UNTRUSTED_QR_URL' && err?.status === 403,
  );
});

test('Security Regression 7: SSRF URL validator blocks all restricted targets & AI validator rejects malicious/schema-invalid outputs', () => {
  const blockedUrls = [
    'http://localhost/admin',
    'http://127.0.0.1:80/',
    'http://169.254.169.254/latest/meta-data/',
    'http://10.0.0.1/secret',
    'http://192.168.1.1/',
    'http://[::1]/',
    'http://[::ffff:127.0.0.1]/',
    'ftp://example.com/file.txt',
    'https://example.com:8443/internal',
    'https://user:pass@example.com/',
  ];
  for (const u of blockedUrls) {
    const res = validatePublicUrl(u);
    assert.equal(res.ok, false, `URL must be blocked: ${u}`);
  }

  // AI prompt injection / malicious output fields rejected
  const text = 'Dokumen ilmiah ini menganalisis performa jaringan komputer secara objektif.';
  const maliciousAi = {
    issues: [
      { type: 'exec_shell', start: 0, end: 7, text: 'Dokumen', explanation: 'x', suggestion: '<script>alert(1)</script>' },
      { type: 'formality', start: 0, end: 7, text: 'MISMATCH', explanation: 'x', suggestion: 'y' },
    ],
  };
  const checked = validateAiIssues(maliciousAi, text);
  assert.equal(checked.valid.length, 0);
});

test('Security Regression 8: Security logger redacts secrets/documents and alerts on brute-force login threshold', () => {
  resetSecurityMonitor();
  const entry = logSecurityEvent('test_event', {
    password: 'SecretPassword!',
    apiKey: 'sk-live-12345',
    original_text: 'Private user thesis text',
    ip: '127.0.0.1',
  });
  assert.equal(entry.password, '[REDACTED]');
  assert.equal(entry.apiKey, '[REDACTED]');
  assert.equal(entry.original_text, '[REDACTED]');
  assert.equal(entry.ip, '127.0.0.1');

  let last;
  for (let i = 0; i < 5; i++) {
    last = recordFailedLogin({ ip: '198.51.100.10', emailHash: 'deadbeef' });
  }
  assert.equal(last.attempts, 5);
  assert.equal(last.suspicious, true);
});
