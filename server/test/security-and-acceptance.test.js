import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import crypto from 'node:crypto';
import JSZip from 'jszip';
import request from 'supertest';
import { Document, Packer, Paragraph, TextRun } from 'docx';

process.env.NODE_ENV = 'test';
process.env.RATE_LIMIT_AUTH_MAX = '1000';
process.env.RATE_LIMIT_ANALYSIS_MAX = '1000';
process.env.RATE_LIMIT_EXPORT_MAX = '1000';
process.env.JWT_ACCESS_SECRET = 'security-test-secret-minimal-32-karakter-ok';

const { createApp } = await import('../src/app.js');
const { config } = await import('../src/config.js');
const { tokenTransactions } = await import('../src/repositories/index.js');
const { validatePublicUrl, fetchAndExtractSource } = await import('../src/services/sourceFetcher.js');
const { verifySignature } = await import('../src/services/payments.js');
const { buildWritingSystemPrompt } = await import('../src/services/prompts/writingEngine.js');

const app = createApp();

let aiServer;
let aiPort;

test.before(async () => {
  aiServer = http.createServer((req, res) => {
    let body = '';
    req.on('data', (c) => { body += c; });
    req.on('end', () => {
      const parsed = JSON.parse(body || '{}');
      const userMsg = parsed?.messages?.find((m) => m.role === 'user')?.content || '';
      const marker = userMsg.indexOf('<<<\n');
      const endMarker = userMsg.lastIndexOf('\n>>>');
      const docText = marker !== -1 && endMarker > marker ? userMsg.slice(marker + 4, endMarker) : '';
      const target = 'Selain itu';
      const idx = docText.indexOf(target);
      const issues = idx !== -1
        ? [{
            type: 'transition',
            start: idx,
            end: idx + target.length,
            text: target,
            explanation: 'Transisi berulang di awal kalimat.',
            suggestion: 'Di samping itu',
            needs_review: false,
          }]
        : [];
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({
        model: 'mock/particle-1',
        choices: [{ message: { content: JSON.stringify({ issues }) } }],
      }));
    });
  });
  await new Promise((resolve) => aiServer.listen(0, '127.0.0.1', resolve));
  aiPort = aiServer.address().port;
  process.env.AI_PROVIDER = '9router';
  process.env.AI_BASE_URL = `http://127.0.0.1:${aiPort}`;
  process.env.AI_API_KEY = 'test-key-not-secret';
  process.env.AI_MODEL = 'mock/particle-1';
});

test.after(async () => {
  await new Promise((resolve) => aiServer.close(resolve));
});

async function createAuthedUser(emailPrefix, tokens = 10) {
  const email = `${emailPrefix}-${Date.now()}-${Math.random().toString(16).slice(2, 7)}@runut.test`;
  const reg = await request(app).post('/api/auth/register').send({
    name: `User ${emailPrefix}`,
    email,
    password: 'Password123!',
  });
  assert.equal(reg.status, 201);
  if (tokens > 0) {
    await tokenTransactions.credit({
      user_id: reg.body.user.id,
      amount: tokens,
      type: 'purchase',
      description: 'Saldo uji keamanan',
    });
  }
  return { email, id: reg.body.user.id, token: reg.body.accessToken };
}

test('Security: /api/admin/ai-usage fail-closed saat ADMIN_EMAILS kosong, tolak non-admin, izinkan admin', async () => {
  const prevAdmins = process.env.ADMIN_EMAILS;
  try {
    const regular = await createAuthedUser('regular', 0);
    const admin = await createAuthedUser('admin', 0);

    // 1. ADMIN_EMAILS kosong -> WAJIB 403 (fail-closed)
    delete process.env.ADMIN_EMAILS;
    const resUnconfigured = await request(app)
      .get('/api/admin/ai-usage?live=false')
      .set('Authorization', `Bearer ${regular.token}`);
    assert.equal(resUnconfigured.status, 403);
    assert.equal(resUnconfigured.body.code, 'ADMIN_NOT_CONFIGURED');

    // 2. ADMIN_EMAILS diisi -> non-admin 403, admin 200
    process.env.ADMIN_EMAILS = admin.email;
    const resNonAdmin = await request(app)
      .get('/api/admin/ai-usage?live=false')
      .set('Authorization', `Bearer ${regular.token}`);
    assert.equal(resNonAdmin.status, 403);
    assert.equal(resNonAdmin.body.code, 'ADMIN_ONLY');

    const resAdmin = await request(app)
      .get('/api/admin/ai-usage?live=false')
      .set('Authorization', `Bearer ${admin.token}`);
    assert.equal(resAdmin.status, 200);
    assert.ok(resAdmin.body.primary_provider);
  } finally {
    if (prevAdmins === undefined) delete process.env.ADMIN_EMAILS;
    else process.env.ADMIN_EMAILS = prevAdmins;
  }
});

test('Security: SSRF protection memblokir localhost, metadata IP, IPv6 mapped, port non-web, DNS rebinding, dan redirect privat', async () => {
  const blockedUrls = [
    'http://127.0.0.1/secret',
    'http://localhost/admin',
    'http://169.254.169.254/latest/meta-data/',
    'http://[::1]/secret',
    'http://[::ffff:127.0.0.1]/secret',
    'http://[::ffff:169.254.169.254]/latest/meta-data/',
    'http://10.0.0.5/internal',
    'http://172.16.0.1/internal',
    'http://192.168.1.1/router',
    'http://example.com:6379/',
    'http://example.com:5432/',
    'file:///etc/passwd',
    'ftp://example.com/file.txt',
  ];
  for (const u of blockedUrls) {
    const check = validatePublicUrl(u);
    assert.equal(check.ok, false, `URL berbahaya harus diblokir: ${u}`);
  }

  // DNS rebinding: domain publik yang meresolusi ke 169.254.169.254 harus diblokir sebelum fetch dipanggil
  let fetchCalled = false;
  const dnsBlocked = await fetchAndExtractSource('https://rebind.example.org/paper.html', {
    lookupImpl: async () => [{ address: '169.254.169.254', family: 4 }],
    fetchImpl: async () => { fetchCalled = true; throw new Error('should not fetch'); },
  });
  assert.equal(dnsBlocked.ok, false);
  assert.equal(dnsBlocked.code, 'SSRF_DNS_BLOCKED');
  assert.equal(fetchCalled, false, 'fetch tidak boleh dipanggil saat DNS meresolusi ke IP privat');

  // Redirect dari domain publik ke IP internal harus diblokir
  const redirectBlocked = await fetchAndExtractSource('https://public.example.org/start', {
    lookupImpl: async () => [{ address: '93.184.216.34', family: 4 }],
    fetchImpl: async () => ({
      status: 302,
      ok: false,
      headers: new Headers({ location: 'http://169.254.169.254/latest/meta-data/' }),
    }),
  });
  assert.equal(redirectBlocked.ok, false);
  assert.equal(redirectBlocked.code, 'SSRF_BLOCKED');
});

test('Security: validasi upload file (magic bytes, file kosong, DOCX terenkripsi, ZIP path traversal, XXE, dan JSON rusak)', async () => {
  const user = await createAuthedUser('uploadsec', 5);
  const auth = { Authorization: `Bearer ${user.token}` };

  // 1. File kosong -> 400 EMPTY_FILE
  const emptyRes = await request(app)
    .post('/api/analysis')
    .set(auth)
    .field('ai_consent', 'true')
    .attach('file', Buffer.alloc(0), { filename: 'empty.txt', contentType: 'text/plain' });
  assert.equal(emptyRes.status, 400);
  assert.equal(emptyRes.body.code, 'EMPTY_FILE');

  // 2. File palsu ber-ekstensi .pdf tanpa header %PDF- -> 415 INVALID_FILE_SIGNATURE
  const fakePdf = await request(app)
    .post('/api/analysis')
    .set(auth)
    .field('ai_consent', 'true')
    .attach('file', Buffer.from('MZ\x90\x00not a real pdf'), { filename: 'malware.pdf', contentType: 'application/pdf' });
  assert.equal(fakePdf.status, 415);
  assert.equal(fakePdf.body.code, 'INVALID_FILE_SIGNATURE');

  // 3. File palsu ber-ekstensi .docx tanpa header ZIP -> 415 INVALID_FILE_SIGNATURE
  const fakeDocx = await request(app)
    .post('/api/analysis')
    .set(auth)
    .field('ai_consent', 'true')
    .attach('file', Buffer.from('plain text masquerading as docx'), { filename: 'fake.docx', contentType: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document' });
  assert.equal(fakeDocx.status, 415);
  assert.equal(fakeDocx.body.code, 'INVALID_FILE_SIGNATURE');

  // 4. DOCX terenkripsi (OLE2 magic D0 CF 11 E0) -> 400 ENCRYPTED_DOCUMENT
  const encDocx = await request(app)
    .post('/api/analysis')
    .set(auth)
    .field('ai_consent', 'true')
    .attach('file', Buffer.from([0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1]), { filename: 'locked.docx', contentType: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document' });
  assert.equal(encDocx.status, 400);
  assert.equal(encDocx.body.code, 'ENCRYPTED_DOCUMENT');

  // 5. DOCX dengan path traversal inside ZIP -> 400 UNSAFE_DOCX_ARCHIVE
  const evilZip = new JSZip();
  evilZip.file('../evil.txt', 'pwned');
  evilZip.file('word/document.xml', '<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body><w:p><w:r><w:t>Hello</w:t></w:r></w:p></w:body></w:document>');
  const evilBuf = await evilZip.generateAsync({ type: 'nodebuffer' });
  const travRes = await request(app)
    .post('/api/analysis')
    .set(auth)
    .field('ai_consent', 'true')
    .attach('file', evilBuf, { filename: 'traversal.docx', contentType: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document' });
  assert.equal(travRes.status, 400);
  assert.equal(travRes.body.code, 'UNSAFE_DOCX_ARCHIVE');

  // 6. DOCX dengan XXE <!DOCTYPE> -> 400 UNSAFE_DOCX_ARCHIVE
  const xxeZip = new JSZip();
  xxeZip.file('word/document.xml', '<?xml version="1.0"?><!DOCTYPE foo [<!ENTITY xxe SYSTEM "file:///etc/passwd">]><w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body><w:p><w:r><w:t>&xxe;</w:t></w:r></w:p></w:body></w:document>');
  const xxeBuf = await xxeZip.generateAsync({ type: 'nodebuffer' });
  const xxeRes = await request(app)
    .post('/api/analysis')
    .set(auth)
    .field('ai_consent', 'true')
    .attach('file', xxeBuf, { filename: 'xxe.docx', contentType: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document' });
  assert.equal(xxeRes.status, 400);
  assert.equal(xxeRes.body.code, 'UNSAFE_DOCX_ARCHIVE');

  // 7. Malformed JSON body -> 400 INVALID_JSON (bukan 500)
  const badJson = await request(app)
    .post('/api/auth/login')
    .set('Content-Type', 'application/json')
    .send('{"email": "broken');
  assert.equal(badJson.status, 400);
  assert.equal(badJson.body.code, 'INVALID_JSON');

  // 8. Security headers pada respons API
  const healthRes = await request(app).get('/api/health');
  assert.equal(healthRes.status, 200);
  assert.equal(healthRes.headers['x-content-type-options'], 'nosniff');
  assert.equal(healthRes.headers['referrer-policy'], 'strict-origin-when-cross-origin');
  assert.match(healthRes.headers['permissions-policy'] || '', /camera=\(\)/);
  assert.equal(healthRes.headers['cache-control'], 'no-store');
});

test('Security: prompt injection boundary & constant-time Midtrans signature verification', () => {
  const sysId = buildWritingSystemPrompt({ language: 'id' });
  const sysEn = buildWritingSystemPrompt({ language: 'en' });
  assert.match(sysId, /DATA DOKUMEN PENGGUNA YANG TIDAK TERPERCAYA/);
  assert.match(sysEn, /UNTRUSTED USER DOCUMENT DATA/);

  const prevKey = config.payments.serverKey;
  try {
    config.payments.serverKey = 'SB-Mid-server-test-key';
    const sig = crypto.createHash('sha512').update('ORD-12009000SB-Mid-server-test-key').digest('hex');
    assert.equal(verifySignature({ order_id: 'ORD-1', status_code: '200', gross_amount: '9000', signature_key: sig }), true);
    assert.equal(verifySignature({ order_id: 'ORD-1', status_code: '200', gross_amount: '9000', signature_key: 'not-hex!' }), false);
    assert.equal(verifySignature({ order_id: 'ORD-1', status_code: '200', gross_amount: '9000', signature_key: '0'.repeat(128) }), false);
  } finally {
    config.payments.serverKey = prevKey;
  }
});

test('Acceptance E2E: DOCX upload -> analisis -> revisi -> unduh DOCX & laporan PDF/DOCX -> isolasi akun', async () => {
  const userA = await createAuthedUser('acceptA', 10);
  const userB = await createAuthedUser('acceptB', 10);

  const doc = new Document({
    sections: [{
      children: [
        new Paragraph({
          children: [
            new TextRun('Penelitian ini menganalisis efektivitas pembelajaran daring pada mahasiswa tingkat sarjana di Indonesia tahun 2025. Selain itu penelitian ini menguji kualitas penyusunan laporan akademik secara sistematis dan terukur.'),
          ],
        }),
      ],
    }],
  });
  const docxBuf = await Packer.toBuffer(doc);

  const analyzed = await request(app)
    .post('/api/analysis')
    .set('Authorization', `Bearer ${userA.token}`)
    .field('ai_consent', 'true')
    .field('title', 'Laporan Akademik Uji')
    .attach('file', docxBuf, {
      filename: 'laporan-akademik.docx',
      contentType: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    });
  assert.equal(analyzed.status, 201, JSON.stringify(analyzed.body));
  const docId = analyzed.body.document.id;
  assert.ok(analyzed.body.issues.length >= 1);

  // Terapkan revisi
  const applyRes = await request(app)
    .patch(`/api/documents/${docId}/issues`)
    .set('Authorization', `Bearer ${userA.token}`)
    .send({ accept_all: true });
  assert.equal(applyRes.status, 200);
  assert.match(applyRes.body.revised_text, /Di samping itu/);

  const binaryParser = (res, callback) => {
    const chunks = [];
    res.on('data', (c) => chunks.push(c));
    res.on('end', () => callback(null, Buffer.concat(chunks)));
  };

  // Unduh DOCX teredit (preservasi template)
  const dlDocx = await request(app)
    .get(`/api/documents/${docId}/download?format=docx`)
    .set('Authorization', `Bearer ${userA.token}`)
    .buffer(true)
    .parse(binaryParser);
  assert.equal(dlDocx.status, 200);
  assert.equal(dlDocx.headers['x-preservation-mode'], 'template-preserved');
  assert.equal(dlDocx.body.subarray(0, 2).toString('latin1'), 'PK');

  // Unduh Laporan Analisis PDF & DOCX
  const repPdf = await request(app)
    .get(`/api/documents/${docId}/analysis-report?format=pdf`)
    .set('Authorization', `Bearer ${userA.token}`)
    .buffer(true)
    .parse(binaryParser);
  assert.equal(repPdf.status, 200);
  assert.equal(repPdf.body.subarray(0, 5).toString('latin1'), '%PDF-');

  const repDocx = await request(app)
    .get(`/api/documents/${docId}/analysis-report?format=docx`)
    .set('Authorization', `Bearer ${userA.token}`)
    .buffer(true)
    .parse(binaryParser);
  assert.equal(repDocx.status, 200);
  assert.equal(repDocx.body.subarray(0, 2).toString('latin1'), 'PK');

  // Isolasi antar pengguna: User B tidak boleh mengakses dokumen atau laporan milik User A
  const stealDoc = await request(app)
    .get(`/api/documents/${docId}`)
    .set('Authorization', `Bearer ${userB.token}`);
  assert.equal(stealDoc.status, 403);

  const stealReport = await request(app)
    .get(`/api/documents/${docId}/analysis-report?format=pdf`)
    .set('Authorization', `Bearer ${userB.token}`);
  assert.equal(stealReport.status, 403);
});
