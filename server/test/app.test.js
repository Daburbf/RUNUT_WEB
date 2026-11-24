import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import request from 'supertest';

// Stub 9Router: server HTTP nyata yang meniru /v1/chat/completions
let mode = 'ok';
let seenRequests = 0;
const stub = http.createServer((req, res) => {
  seenRequests++;
  if (mode === 'hang') return;
  if (mode === 'http500') {
    res.writeHead(500, { 'content-type': 'text/plain' });
    return res.end('provider error');
  }
  if (mode === 'http404') {
    res.writeHead(404, { 'content-type': 'application/json' });
    return res.end('{"error":"model not found"}');
  }
  let body = '';
  req.on('data', (c) => (body += c));
  req.on('end', () => {
    assert.equal(req.url, '/v1/chat/completions', 'endpoint OpenAI-compatible dipakai apa adanya');
    assert.equal(req.headers.authorization, 'Bearer test-key', 'kredensial dikirim dari konfigurasi server');
    const payload = JSON.parse(body);
    assert.ok(payload.model, 'model dikirim dari AI_MODEL');
    assert.equal(payload.response_format, undefined, 'parameter yang tidak semua model dukung tidak dikirim');
    const text = String(payload.messages[1].content).split('<<<\n')[1].split('\n>>>')[0];
    const content = mode === 'badjson' ? 'ini bukan json' : JSON.stringify({ issues: buildIssues(text) });
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ choices: [{ message: { content } }] }));
  });
});
await new Promise((resolve) => stub.listen(0, '127.0.0.1', resolve));
const stubUrl = `http://127.0.0.1:${stub.address().port}/v1`;

const at = (text, needle) => {
  const start = text.indexOf(needle);
  return { start, end: start + needle.length, text: needle };
};

function buildIssues(text) {
  const issues = [];
  if (text.includes('Selain itu')) {
    issues.push({ ...at(text, 'Selain itu'), type: 'transition', explanation: 'Penghubung ini dipakai berulang di beberapa bagian sehingga hubungan gagasan terasa monoton.', suggestion: 'Gunakan penghubung lain yang sesuai, atau hilangkan bila tidak diperlukan.' });
  }
  if (text.includes('penulis')) {
    issues.push({ ...at(text, 'penulis'), type: 'repetition', explanation: 'Kata ini muncul berkali-kali dalam paragraf pendek.', suggestion: 'Ganti dengan sebutan lain pada sebagian kemunculan.' });
  }
  const second = 'menambah data';
  const secondAt = text.indexOf(second);
  if (secondAt !== -1) {
    issues.push({ start: secondAt, end: secondAt + second.length, text: second, type: 'uniform_structure', explanation: 'Susunan kalimat ini mirip dengan kalimat sebelumnya.', suggestion: 'Variasikan pembukaan kalimat.' });
  }
  const third = 'Laporan ini disusun';
  const thirdAt = text.indexOf(third);
  if (thirdAt !== -1) {
    issues.push({ start: thirdAt, end: thirdAt + third.length, text: third, type: 'sentence_pattern', explanation: 'Pola pembukaan kalimat ini sama dengan dua kalimat lain.', suggestion: 'Ubah susunan pembukaannya.', needs_review: true });
  }
  return issues;
}

process.env.NODE_ENV = 'test';
process.env.RATE_LIMIT_AUTH_MAX = '1000';
process.env.RATE_LIMIT_ANALYSIS_MAX = '1000';
process.env.JWT_ACCESS_SECRET = 'test-secret-yang-cukup-panjang-32-karakter';
process.env.AI_PROVIDER = '9router';
process.env.AI_BASE_URL = stubUrl;
process.env.AI_API_KEY = 'test-key';
process.env.AI_MODEL = 'vendor/model-uji';
process.env.AI_TIMEOUT_MS = '2000';
delete process.env.MAIL_HOST;

const { createApp } = await import('../src/app.js');
const {
  users,
  documents,
  issues: issuesRepo,
  tokenTransactions,
  initStorage,
} = await import('../src/repositories/index.js');
const { createMemoryRepositories } = await import('../src/repositories/memory.js');
const app = createApp();

const TEXT = [
  'Selain itu penulis menambah data pada laporan tahunan ini.',
  'Selain itu penulis menyimpulkan temuan utama dari data tersebut.',
  'penulis menilai hasilnya cukup baik dan layak dibaca.',
  'Laporan ini disusun penulis dengan hati-hati agar mudah dipahami pembaca.',
].join(' ');

const emailOf = () => `uji${Date.now()}${Math.random().toString(16).slice(2, 8)}@runut.test`;

async function newUser(agent, name = 'Penulis Uji', initialTokens = 0) {
  const email = emailOf();
  const res = await agent.post('/api/auth/register').send({ name, email, password: 'rahasia12345' });
  assert.equal(res.status, 201, JSON.stringify(res.body));
  assert.equal(res.body.user.token_balance, 0, 'pengguna baru selalu mulai dengan saldo 0 token');
  const id = res.body.user.id;
  if (initialTokens > 0) {
    await tokenTransactions.credit({
      user_id: id,
      amount: initialTokens,
      type: 'purchase',
      description: `Topup uji ${initialTokens} token`,
      reference_type: 'test',
      reference_id: `TEST-${Date.now()}`,
    });
  }
  return { email, password: 'rahasia12345', token: res.body.accessToken, id };
}

test('health melaporkan penyimpanan sementara, status AI, dan tarif token', async () => {
  const res = await request(app).get('/api/health');
  assert.equal(res.status, 200);
  assert.equal(res.body.ok, true);
  assert.match(res.body.storage, /memori/);
  assert.equal(res.body.ai.configured, true);
  assert.equal(res.body.limits.min_words, 20);
  assert.equal(res.body.limits.words_per_token, 1000);
  assert.equal(res.body.tokens.packages.length, 3);
});

test('pengguna baru memiliki saldo 0 token dan tidak bisa mengubah saldo lewat request', async () => {
  const agent = request.agent(app);
  const email = emailOf();
  const reg = await agent.post('/api/auth/register').send({
    name: 'Pengguna Baru',
    email,
    password: 'rahasia12345',
    token_balance: 9999,
  });
  assert.equal(reg.status, 201);
  assert.equal(reg.body.user.token_balance, 0);
  assert.equal(reg.body.user.total_purchased, 0);
  assert.equal(reg.body.user.total_used, 0);

  const auth = { Authorization: `Bearer ${reg.body.accessToken}` };
  const tok = await agent.get('/api/tokens').set(auth);
  assert.equal(tok.status, 200);
  assert.equal(tok.body.balance, 0);
});

test('registrasi memvalidasi email, panjang sandi, dan email ganda', async () => {
  const agent = request.agent(app);
  const email = emailOf();
  assert.equal((await agent.post('/api/auth/register').send({ name: 'A', email, password: 'rahasia12345' })).status, 400);
  assert.equal((await agent.post('/api/auth/register').send({ name: 'Andi', email: 'bukan-email', password: 'rahasia12345' })).status, 400);
  assert.equal((await agent.post('/api/auth/register').send({ name: 'Andi', email, password: 'pendek' })).status, 400);
  assert.equal((await agent.post('/api/auth/register').send({ name: 'Andi', email, password: 'rahasia12345' })).status, 201);
  const dup = await agent.post('/api/auth/register').send({ name: 'Andi', email, password: 'rahasia12345' });
  assert.equal(dup.status, 409);
});

test('login, /me, refresh lewat cookie HttpOnly, dan logout mencabut sesi', async () => {
  const agent = request.agent(app);
  const user = await newUser(agent);
  assert.ok(user.token);

  await agent.post('/api/auth/logout').expect(200);
  const me = await agent.get('/api/auth/me').set('Authorization', `Bearer ${user.token}`);
  assert.equal(me.status, 200);

  await agent.post('/api/auth/login').send({ email: user.email, password: 'salah-sekali' }).expect(401);
  const login = await agent.post('/api/auth/login').send({ email: user.email, password: user.password });
  assert.equal(login.status, 200);
  const cookie = login.headers['set-cookie'].join(';');
  assert.match(cookie, /__Secure-runut_refresh=/);
  assert.match(cookie, /HttpOnly/i, 'refresh token tidak boleh bisa dibaca JavaScript');
  assert.equal(login.body.refreshToken, undefined, 'refresh token tidak dikirim di body');

  const refreshed = await agent.post('/api/auth/refresh');
  assert.equal(refreshed.status, 200);
  assert.ok(refreshed.body.accessToken);

  await agent.post('/api/auth/logout').expect(200);
  const after = await agent.post('/api/auth/refresh');
  assert.equal(after.status, 401, 'setelah logout, cookie sesi tidak bisa dipakai lagi');
});

test('endpoint terproteksi membutuhkan token akses', async () => {
  await request(app).get('/api/auth/me').expect(401);
  await request(app).get('/api/tokens').expect(401);
  await request(app).get('/api/tokens/transactions').expect(401);
  await request(app).post('/api/analysis/estimate').send({ text: TEXT }).expect(401);
  await request(app).post('/api/analysis').send({ text: TEXT, ai_consent: true }).expect(401);
  await request(app).get('/api/documents').expect(401);
  await request(app).get('/api/documents').set('Authorization', 'Bearer token-palsu').expect(401);
});

test('reset password: SMTP belum dikonfigurasi dilaporkan apa adanya', async () => {
  const res = await request(app).post('/api/auth/forgot-password').send({ email: 'siapa@runut.test' });
  assert.equal(res.status, 503);
  assert.equal(res.body.code, 'MAIL_NOT_CONFIGURED');
});

test('persetujuan AI wajib sebelum teks dikirim ke provider dan token tidak dipotong', async () => {
  const agent = request.agent(app);
  const user = await newUser(agent, 'Penulis', 5);
  const before = seenRequests;
  const res = await agent.post('/api/analysis').set('Authorization', `Bearer ${user.token}`).send({ text: TEXT });
  assert.equal(res.status, 400);
  assert.equal(res.body.code, 'AI_CONSENT_REQUIRED');
  assert.equal(seenRequests, before, 'teks tidak boleh dikirim ke provider tanpa persetujuan');
  const bal = await agent.get('/api/tokens').set('Authorization', `Bearer ${user.token}`);
  assert.equal(bal.body.balance, 5, 'saldo tidak berkurang jika persetujuan belum dicentang');
});

test('teks pendek (<20 kata) ditolak tanpa memotong saldo token', async () => {
  const agent = request.agent(app);
  const user = await newUser(agent, 'Penulis', 5);
  const auth = { Authorization: `Bearer ${user.token}` };

  const short = await agent.post('/api/analysis').set(auth).send({ text: 'Terlalu pendek saja.', ai_consent: true });
  assert.equal(short.status, 400);
  assert.equal(short.body.code, 'TOO_SHORT');
  assert.equal((await agent.get('/api/tokens').set(auth)).body.balance, 5);
});

test('pengguna dengan saldo kurang tidak bisa menjalankan analisis dan AI tidak dipanggil', async () => {
  const agent = request.agent(app);
  const user = await newUser(agent, 'Saldo Kosong', 0);
  const auth = { Authorization: `Bearer ${user.token}` };
  const before = seenRequests;

  const res = await agent.post('/api/analysis').set(auth).send({ text: TEXT, ai_consent: true });
  assert.equal(res.status, 402);
  assert.equal(res.body.code, 'INSUFFICIENT_TOKENS');
  assert.equal(res.body.details.required, 1);
  assert.equal(res.body.details.balance, 0);
  assert.equal(seenRequests, before, 'AI tidak boleh dipanggil saat saldo kurang');
});

test('estimasi biaya dan perhitungan progresif (750=1, 1500=2, 2500=3, 7200=8 token)', async () => {
  const agent = request.agent(app);
  const user = await newUser(agent, 'Estimator', 20);
  const auth = { Authorization: `Bearer ${user.token}` };

  const cases = [
    { words: 20, expectedCost: 1 },
    { words: 500, expectedCost: 1 },
    { words: 750, expectedCost: 1 },
    { words: 1000, expectedCost: 1 },
    { words: 1001, expectedCost: 2 },
    { words: 1500, expectedCost: 2 },
    { words: 2500, expectedCost: 3 },
    { words: 7200, expectedCost: 8 },
  ];

  for (const c of cases) {
    const sample = Array.from({ length: c.words }, (_, idx) => `kata${idx}`).join(' ');
    const est = await agent.post('/api/analysis/estimate').set(auth).send({ text: sample });
    assert.equal(est.status, 200);
    assert.equal(est.body.word_count, c.words);
    assert.equal(est.body.token_cost, c.expectedCost, `${c.words} kata harus berbiaya ${c.expectedCost} token`);
    assert.equal(est.body.balance, 20, 'estimasi tidak memotong saldo');
    assert.equal(est.body.balance_after, 20 - c.expectedCost);
  }
});

test('analisis memotong token secara progresif sesuai jumlah kata dan membuka semua saran', async () => {
  const agent = request.agent(app);
  const user = await newUser(agent, 'Pengguna Token', 10);
  const auth = { Authorization: `Bearer ${user.token}` };

  // 1) Analisis 37 kata -> 1 token
  const res1 = await agent.post('/api/analysis').set(auth).send({
    text: TEXT,
    title: 'Laporan Pendek',
    ai_consent: true,
  });
  assert.equal(res1.status, 201, JSON.stringify(res1.body));
  assert.equal(res1.body.analysis.locked, false, 'semua hasil terbuka tanpa kunci');
  assert.equal(res1.body.meta.token_cost, 1);
  assert.equal(res1.body.meta.token_balance, 9);
  assert.equal(res1.body.issues.length, 4, 'seluruh 4 saran ditampilkan tanpa dipotong 3');

  // 2) Analisis > 1.000 kata (mis. 1.500 kata) -> 2 token
  const paragraph = 'Laporan ini disusun untuk memeriksa pola tulisan. Selain itu penulis menambah data pendukung. Selain itu penulis memperkuat argumen supaya pembaca yakin.';
  // paragraph = 21 kata; 72 * 21 = 1.512 kata -> 2 token
  const longText = Array.from({ length: 72 }, () => paragraph).join('\n\n');
  const res2 = await agent.post('/api/analysis').set(auth).send({
    text: longText,
    title: 'Laporan 1500 Kata',
    ai_consent: true,
  });
  assert.equal(res2.status, 201);
  assert.equal(res2.body.analysis.stats.word_count, 1512);
  assert.equal(res2.body.meta.token_cost, 2);
  assert.equal(res2.body.meta.token_balance, 7);
  assert.ok(res2.body.analysis.ai.sections >= 2, 'teks panjang dipecah menjadi beberapa bagian');

  // Periksa riwayat transaksi token
  const txRes = await agent.get('/api/tokens/transactions').set(auth);
  assert.equal(txRes.status, 200);
  assert.equal(txRes.body.balance, 7);
  assert.equal(txRes.body.summary.total_purchased, 10);
  assert.equal(txRes.body.summary.total_used, 3);
});

test('idempotency key mencegah pemotongan token ganda pada pengiriman ulang', async () => {
  const agent = request.agent(app);
  const user = await newUser(agent, 'Idempoten Uji', 5);
  const auth = { Authorization: `Bearer ${user.token}` };
  const idemKey = 'idem-key-unik-123';

  const first = await agent.post('/api/analysis').set(auth).send({
    text: TEXT,
    title: 'Uji Idempoten',
    ai_consent: true,
    idempotency_key: idemKey,
  });
  assert.equal(first.status, 201);
  assert.equal(first.body.meta.token_balance, 4);

  const second = await agent.post('/api/analysis').set(auth).send({
    text: TEXT,
    title: 'Uji Idempoten',
    ai_consent: true,
    idempotency_key: idemKey,
  });
  assert.equal(second.status, 200);
  assert.equal(second.body.idempotent_replay, true);
  assert.equal(second.body.document.id, first.body.document.id);
  assert.equal(second.body.meta.token_balance, 4, 'saldo tidak dipotong dua kali');
});

test('permintaan analisis bersamaan (concurrent) bersifat atomik dan tidak membuat saldo negatif', async () => {
  const agent = request.agent(app);
  // Saldo hanya 1 token, tetapi pengguna mengirim 2 permintaan analisis 1 token secara bersamaan.
  const user = await newUser(agent, 'Balapan Uji', 1);
  const auth = { Authorization: `Bearer ${user.token}` };

  const [r1, r2] = await Promise.all([
    agent.post('/api/analysis').set(auth).send({ text: TEXT, title: 'Serentak 1', ai_consent: true }),
    agent.post('/api/analysis').set(auth).send({ text: TEXT, title: 'Serentak 2', ai_consent: true }),
  ]);

  const statuses = [r1.status, r2.status].sort();
  assert.deepEqual(statuses, [201, 402], 'hanya satu yang berhasil, satu lagi ditolak karena saldo habis');

  const me = await agent.get('/api/auth/me').set(auth);
  assert.equal(me.body.user.token_balance, 0, 'saldo akhir tepat 0 dan tidak pernah negatif');
});

test('penerapan saran, penolakan, pembatalan, perbandingan, dan pemulihan teks asli', async () => {
  const agent = request.agent(app);
  const user = await newUser(agent, 'Editor Uji', 5);
  const auth = { Authorization: `Bearer ${user.token}` };

  const created = await agent.post('/api/analysis').set(auth).send({ text: TEXT, ai_consent: true });
  assert.equal(created.status, 201);
  const docId = created.body.document.id;

  const all = await agent.get(`/api/documents/${docId}`).set(auth);
  assert.equal(all.body.issues.length, 4, 'semua masalah tersimpan langsung terbuka');

  const applied = await agent.patch(`/api/documents/${docId}/issues`).set(auth).send({ accept_all: true });
  assert.equal(applied.status, 200);
  assert.notEqual(applied.body.revised_text, TEXT, 'teks revisi berbeda dari teks asli');
  assert.ok(applied.body.revised_text.includes('Gunakan penghubung lain'), 'saran diterapkan');
  assert.equal(applied.body.issues.filter((i) => i.decision === 'applied').length, 3, 'saran perlu cek manual tidak diterapkan otomatis');

  const manualId = applied.body.issues.find((i) => i.needs_manual_review).id;
  const refused = await agent.patch(`/api/documents/${docId}/issues`).set(auth).send({ decisions: [{ id: manualId, decision: 'applied' }] });
  assert.equal(refused.status, 409);
  assert.equal(refused.body.code, 'NEEDS_MANUAL');

  const confirmed = await agent.patch(`/api/documents/${docId}/issues`).set(auth)
    .send({ decisions: [{ id: manualId, decision: 'applied', confirm_manual: true }] });
  assert.equal(confirmed.status, 200);
  assert.ok(confirmed.body.revised_text.includes('Ubah susunan pembukaannya'));

  const rejected = await agent.patch(`/api/documents/${docId}/issues`).set(auth)
    .send({ decisions: [{ id: manualId, decision: 'rejected' }, { id: applied.body.issues[0].id, decision: 'rejected' }] });
  assert.equal(rejected.status, 200);
  assert.equal(rejected.body.issues.filter((i) => i.decision === 'rejected').length, 2);

  const bad = await agent.patch(`/api/documents/${docId}/issues`).set(auth).send({ decisions: [{ id: manualId, decision: 'entah' }] });
  assert.equal(bad.status, 400);

  const restored = await agent.post(`/api/documents/${docId}/restore`).set(auth);
  assert.equal(restored.status, 200);
  assert.equal(restored.body.revised_text, TEXT);
  assert.equal(restored.body.issues.every((i) => i.decision === 'active'), true);
});

test('saran dengan posisi basi ditolak dan tidak mengubah teks', async () => {
  const agent = request.agent(app);
  const user = await newUser(agent, 'Stale Uji', 5);
  const auth = { Authorization: `Bearer ${user.token}` };
  const created = await agent.post('/api/analysis').set(auth).send({ text: TEXT, ai_consent: true });
  const docId = created.body.document.id;
  await documents.update(docId, { original_text: 'Teks sudah diganti sepenuhnya oleh pengguna.' });
  const res = await agent.patch(`/api/documents/${docId}/issues`).set(auth).send({ accept_all: true });
  assert.equal(res.status, 409);
  assert.equal(res.body.code, 'STALE_POSITION');
});

test('unggahan: TXT diekstrak, tipe tidak didukung & PDF kosong tidak mengurangi token', async () => {
  const agent = request.agent(app);
  const user = await newUser(agent, 'Upload Uji', 5);
  const auth = { Authorization: `Bearer ${user.token}` };

  const txt = await agent.post('/api/analysis').set(auth).attach('file', Buffer.from(TEXT), 'tulisan.txt').field('ai_consent', 'true');
  assert.equal(txt.status, 201, JSON.stringify(txt.body));
  assert.equal(txt.body.document.title, 'tulisan');
  assert.equal(txt.body.analysis.stats.word_count, 37);
  assert.equal(txt.body.meta.token_balance, 4);

  const bad = await agent.post('/api/analysis').set(auth).attach('file', Buffer.from('data'), 'gambar.png').field('ai_consent', 'true');
  assert.equal(bad.status, 415);
  assert.equal(bad.body.code, 'BAD_FILE_TYPE');
  assert.equal((await agent.get('/api/tokens').set(auth)).body.balance, 4, 'format tidak didukung tidak memotong token');

  const empty = await agent.post('/api/analysis').set(auth)
    .attach('file', Buffer.from('%PDF-1.4 tidak ada lapisan teks'), 'pindai.pdf').field('ai_consent', 'true');
  assert.equal(empty.status, 400);
  assert.equal(empty.body.code, 'NO_TEXT');
  assert.equal((await agent.get('/api/tokens').set(auth)).body.balance, 4, 'file tanpa teks tidak memotong token');
});

test('riwayat & isolasi akun: kepemilikan dokumen, saldo, unduhan, dan hapus', async () => {
  const owner = request.agent(app);
  const user = await newUser(owner, 'Pemilik', 5);
  const auth = { Authorization: `Bearer ${user.token}` };
  const created = await owner.post('/api/analysis').set(auth).send({ text: TEXT, title: 'Dokumen Riwayat', ai_consent: true });
  const docId = created.body.document.id;

  const list = await owner.get('/api/documents?q=Riwayat').set(auth);
  assert.equal(list.body.documents.length, 1);
  assert.equal(list.body.documents[0].title, 'Dokumen Riwayat');
  assert.equal(list.body.documents[0].token_cost, 1);
  assert.equal((await owner.get('/api/documents?q=TidakAda').set(auth)).body.documents.length, 0);

  const other = request.agent(app);
  const stranger = await newUser(other, 'Orang Lain', 0);
  const strangerAuth = { Authorization: `Bearer ${stranger.token}` };
  const forbidden = await other.get(`/api/documents/${docId}`).set(strangerAuth);
  assert.equal(forbidden.status, 403);
  const strangerDocs = await other.get('/api/documents').set(strangerAuth);
  assert.equal(strangerDocs.body.documents.length, 0, 'tidak bisa melihat dokumen akun lain');
  const strangerTokens = await other.get('/api/tokens/transactions').set(strangerAuth);
  assert.equal(strangerTokens.body.balance, 0);
  assert.equal(strangerTokens.body.transactions.length, 0, 'tidak bisa melihat transaksi token akun lain');

  const txt = await owner.get(`/api/documents/${docId}/download?format=txt`).set(auth);
  assert.equal(txt.status, 200);
  assert.match(txt.headers['content-type'], /text\/plain/);
  assert.equal(txt.headers['x-token-balance'], '3', 'unduh TXT memotong 1 token (4 -> 3)');

  const docx = await owner.get(`/api/documents/${docId}/download?format=docx`).set(auth);
  assert.equal(docx.status, 200);
  assert.match(docx.headers['content-type'], /wordprocessingml/);
  assert.equal(docx.headers['x-token-balance'], '2', 'unduh DOCX memotong 1 token (3 -> 2)');

  const pdf = await owner.get(`/api/documents/${docId}/download?format=pdf`).set(auth);
  assert.equal(pdf.status, 200);
  assert.match(pdf.headers['content-type'], /application\/pdf/);
  assert.equal(pdf.headers['x-token-balance'], '1', 'unduh PDF memotong 1 token (2 -> 1)');
  const { PDFDocument } = await import('pdf-lib');
  const reloaded = await PDFDocument.load(pdf.body);
  assert.ok(reloaded.getPageCount() >= 1);

  // Format tidak valid tidak boleh memotong token
  const badFormat = await owner.get(`/api/documents/${docId}/download?format=rtf`).set(auth);
  assert.equal(badFormat.status, 400);
  assert.equal((await owner.get('/api/tokens').set(auth)).body.balance, 1);

  // Habiskan 1 token terakhir lalu pastikan unduhan berikutnya ditolak (402)
  await owner.get(`/api/documents/${docId}/download?format=txt`).set(auth).expect(200);
  assert.equal((await owner.get('/api/tokens').set(auth)).body.balance, 0);
  const noBalanceDl = await owner.get(`/api/documents/${docId}/download?format=pdf`).set(auth);
  assert.equal(noBalanceDl.status, 402);
  assert.equal(noBalanceDl.body.code, 'INSUFFICIENT_TOKENS');

  const del = await owner.delete('/api/documents').set(auth).send({ ids: [docId] });
  assert.equal(del.status, 200);
  assert.deepEqual(del.body.deleted, [docId]);
});

test('kegagalan provider AI mengembalikan (refund) seluruh token pengguna secara otomatis', async () => {
  const agent = request.agent(app);
  const user = await newUser(agent, 'Refund Uji', 5);
  const auth = { Authorization: `Bearer ${user.token}` };
  const body = { text: TEXT, ai_consent: true };

  const key = process.env.AI_API_KEY;
  process.env.AI_API_KEY = '';
  const unconfigured = await agent.post('/api/analysis').set(auth).send(body);
  assert.equal(unconfigured.status, 503);
  assert.equal(unconfigured.body.code, 'AI_NOT_CONFIGURED');
  process.env.AI_API_KEY = key;
  assert.equal((await agent.get('/api/tokens').set(auth)).body.balance, 5, 'token dikembalikan saat AI belum dikonfigurasi');

  mode = 'http404';
  const notFound = await agent.post('/api/analysis').set(auth).send(body);
  assert.equal(notFound.status, 503);
  assert.equal(notFound.body.code, 'AI_MODEL_NOT_FOUND');
  assert.equal((await agent.get('/api/tokens').set(auth)).body.balance, 5, 'token dikembalikan saat model 404');

  mode = 'http500';
  const broken = await agent.post('/api/analysis').set(auth).send(body);
  assert.equal(broken.status, 502);
  assert.equal((await agent.get('/api/tokens').set(auth)).body.balance, 5, 'token dikembalikan saat AI 500');

  mode = 'badjson';
  const badjson = await agent.post('/api/analysis').set(auth).send(body);
  assert.equal(badjson.status, 502);
  assert.equal(badjson.body.code, 'AI_BAD_JSON');
  assert.equal((await agent.get('/api/tokens').set(auth)).body.balance, 5, 'token dikembalikan saat AI bad JSON');

  mode = 'hang';
  const timeout = Number(process.env.AI_TIMEOUT_MS);
  process.env.AI_TIMEOUT_MS = '150';
  const slow = await agent.post('/api/analysis').set(auth).send(body);
  process.env.AI_TIMEOUT_MS = String(timeout);
  assert.equal(slow.status, 504);
  assert.equal(slow.body.code, 'AI_TIMEOUT');
  assert.equal((await agent.get('/api/tokens').set(auth)).body.balance, 5, 'token dikembalikan saat AI timeout');

  mode = 'ok';
  const txRes = await agent.get('/api/tokens/transactions').set(auth);
  assert.equal(txRes.body.balance, 5);
  assert.equal(txRes.body.summary.total_used, 0, 'penggunaan bersih tetap 0 karena semua kegagalan di-refund');
  assert.ok(txRes.body.transactions.some((t) => t.type === 'refund'), 'riwayat mencatat transaksi refund');
});

test('saldo dan transaksi tetap tersimpan setelah server restart, dan production menolak tanpa DATABASE_URL', async () => {
  const tmpFile = path.join(os.tmpdir(), `runut-test-persist-${Date.now()}.json`);
  try {
    const repo1 = createMemoryRepositories({ persistPath: tmpFile });
    const created = await repo1.users.create({ name: 'Persisten', email: 'persisten@runut.test', password_hash: 'hash' });
    await repo1.tokenTransactions.credit({
      user_id: created.id,
      amount: 10,
      type: 'purchase',
      description: 'Pembelian Paket Populer (10 token)',
      reference_type: 'payment',
      reference_id: 'RUNUT-ORDER-1',
      idempotency_key: 'payment:RUNUT-ORDER-1',
    });
    await repo1.tokenTransactions.deduct({
      user_id: created.id,
      amount: 2,
      description: 'Analisis 1500 kata',
      reference_type: 'analysis',
      reference_id: 'DOC-1',
    });

    // Simulasi server restart: inisialisasi repository baru dari berkas yang sama
    const repo2 = createMemoryRepositories({ persistPath: tmpFile });
    const reloadedUser = await repo2.users.findById(created.id);
    assert.equal(reloadedUser.token_balance, 8, 'saldo tetap 8 token setelah server restart');
    const summary = await repo2.tokenTransactions.summaryByUser(created.id);
    assert.equal(summary.balance, 8);
    assert.equal(summary.total_purchased, 10);
    assert.equal(summary.total_used, 2);

    // Production tidak boleh diam-diam jatuh ke memori bila DATABASE_URL kosong
    await assert.rejects(
      () => initStorage('', { env: 'production' }),
      /DATABASE_URL wajib dikonfigurasi di production/,
    );
  } finally {
    if (fs.existsSync(tmpFile)) fs.unlinkSync(tmpFile);
  }
});

test.after(async () => {
  stub.close();
  await new Promise((resolve) => setTimeout(resolve, 50));
});
