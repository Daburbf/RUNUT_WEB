import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import request from 'supertest';
import { Document, Packer, Paragraph, TextRun } from 'docx';

process.env.NODE_ENV = 'test';
process.env.RATE_LIMIT_AUTH_MAX = '1000';
process.env.RATE_LIMIT_ANALYSIS_MAX = '1000';
process.env.RATE_LIMIT_EXPORT_MAX = '1000';
process.env.JWT_ACCESS_SECRET = 'download-token-safety-test-secret-32-chars';

const { createApp } = await import('../src/app.js');
const { tokenTransactions, downloadTransactions } = await import('../src/repositories/index.js');

const app = createApp();

let aiServer;
test.before(async () => {
  aiServer = http.createServer((req, res) => {
    let body = '';
    req.on('data', (c) => { body += c; });
    req.on('end', () => {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ model: 'mock/particle-1', choices: [{ message: { content: '{"issues":[]}' } }] }));
    });
  });
  await new Promise((resolve) => aiServer.listen(0, '127.0.0.1', resolve));
  process.env.AI_PROVIDER = '9router';
  process.env.AI_BASE_URL = `http://127.0.0.1:${aiServer.address().port}`;
  process.env.AI_API_KEY = 'test-key';
  process.env.AI_MODEL = 'mock/particle-1';
});

test.after(async () => {
  await new Promise((resolve) => aiServer.close(resolve));
});

async function setupUserAndDoc(tokens = 5) {
  const email = `dl-${Date.now()}-${Math.random().toString(16).slice(2, 7)}@runut.test`;
  const prevBonus = process.env.SIGNUP_FREE_TOKENS;
  process.env.SIGNUP_FREE_TOKENS = '0';
  let reg;
  try {
    reg = await request(app).post('/api/auth/register').send({
      name: 'Uji Unduhan',
      email,
      password: 'Password123!',
    });
  } finally {
    if (prevBonus === undefined) delete process.env.SIGNUP_FREE_TOKENS;
    else process.env.SIGNUP_FREE_TOKENS = prevBonus;
  }
  assert.equal(reg.status, 201);
  if (tokens > 0) {
    await tokenTransactions.credit({
      user_id: reg.body.user.id,
      amount: tokens,
      type: 'purchase',
      description: 'Saldo uji unduhan',
    });
  }
  const text = 'Penelitian ini membahas keamanan transaksi token unduhan dua fase agar pembatalan penyimpanan file tidak pernah memotong saldo pengguna secara permanen pada platform Runut.';
  const an = await request(app)
    .post('/api/analysis')
    .set('Authorization', `Bearer ${reg.body.accessToken}`)
    .send({ text, title: 'Naskah Uji Unduhan', ai_consent: true });
  assert.equal(an.status, 201);
  // 1 token dipakai analisis -> sisa (tokens - 1)
  return {
    userId: reg.body.user.id,
    token: reg.body.accessToken,
    docId: an.body.document.id,
    balanceAfterAnalysis: tokens - 1,
  };
}

test('Download 2-Phase: reservasi TIDAK memotong saldo permanen, cancel melepaskan reservasi, commit memotong tepat 1 kali', async () => {
  const ctx = await setupUserAndDoc(5); // saldo setelah analisis = 4
  const auth = { Authorization: `Bearer ${ctx.token}` };

  // 1. Reserve -> saldo total tetap 4, reserved = 1, available = 3
  const r1 = await request(app)
    .post(`/api/documents/${ctx.docId}/download/reserve`)
    .set(auth)
    .send({ format: 'txt', idempotency_key: 'cancel-test-1' });
  assert.equal(r1.status, 201);
  assert.equal(r1.body.balance, 4);
  assert.equal(r1.body.reserved_tokens, 1);
  assert.equal(r1.body.available_balance, 3);
  assert.equal(r1.body.transaction.state, 'reserved');

  // 2. User membatalkan Save As / menutup File Explorer -> cancel melepaskan reservasi, saldo tetap 4!
  const cancelRes = await request(app)
    .post(`/api/documents/${ctx.docId}/download/${r1.body.transaction.id}/cancel`)
    .set(auth)
    .send({ reason: 'user_cancelled_picker' });
  assert.equal(cancelRes.status, 200);
  assert.equal(cancelRes.body.balance, 4);
  assert.equal(cancelRes.body.reserved_tokens, 0);
  assert.equal(cancelRes.body.available_balance, 4);
  assert.equal(cancelRes.body.transaction.state, 'cancelled');
  assert.match(cancelRes.body.message, /Token Anda tidak dipotong/i);

  // Commit setelah cancel harus ditolak (409)
  const commitCancelled = await request(app)
    .post(`/api/documents/${ctx.docId}/download/${r1.body.transaction.id}/commit`)
    .set(auth);
  assert.equal(commitCancelled.status, 409);

  // 3. Reserve baru -> fetch file -> commit sukses -> saldo berkurang 1 (jadi 3)
  const r2 = await request(app)
    .post(`/api/documents/${ctx.docId}/download/reserve`)
    .set(auth)
    .send({ format: 'txt', idempotency_key: 'commit-test-1' });
  assert.equal(r2.status, 201);
  const txId = r2.body.transaction.id;

  const fileRes = await request(app)
    .get(`/api/documents/${ctx.docId}/download/file?tx=${txId}`)
    .set(auth);
  assert.equal(fileRes.status, 200);
  assert.equal(fileRes.headers['x-download-transaction-id'], txId);

  // Sebelum commit, saldo masih 4!
  const balBefore = await request(app).get('/api/tokens').set(auth);
  assert.equal(balBefore.body.balance, 4);
  assert.equal(balBefore.body.reserved_tokens, 1);
  assert.equal(balBefore.body.available_balance, 3);

  const commit1 = await request(app)
    .post(`/api/documents/${ctx.docId}/download/${txId}/commit`)
    .set(auth);
  assert.equal(commit1.status, 200);
  assert.equal(commit1.body.balance, 3);
  assert.equal(commit1.body.reserved_tokens, 0);
  assert.equal(commit1.body.transaction.state, 'committed');

  // 4. Duplicate commit harus idempoten (saldo tetap 3, TIDAK dipotong ganda)
  const commitDup = await request(app)
    .post(`/api/documents/${ctx.docId}/download/${txId}/commit`)
    .set(auth);
  assert.equal(commitDup.status, 200);
  assert.equal(commitDup.body.duplicate, true);
  assert.equal(commitDup.body.balance, 3);

  // 5. Cancel setelah commit ditolak (409)
  const cancelCommitted = await request(app)
    .post(`/api/documents/${ctx.docId}/download/${txId}/cancel`)
    .set(auth);
  assert.equal(cancelCommitted.status, 409);
});

test('Download 2-Phase: concurrency, idempotency, ownership isolation, expiry, dan failed conversion tidak memotong token', async () => {
  const ctxA = await setupUserAndDoc(2); // saldo setelah analisis = 1
  const ctxB = await setupUserAndDoc(2);
  const authA = { Authorization: `Bearer ${ctxA.token}` };
  const authB = { Authorization: `Bearer ${ctxB.token}` };

  // 1. Concurrent reserves saat saldo = 1: hanya 1 yang berhasil, sisanya 402 INSUFFICIENT_TOKENS
  const [c1, c2] = await Promise.all([
    request(app).post(`/api/documents/${ctxA.docId}/download/reserve`).set(authA).send({ format: 'txt', idempotency_key: 'conc-1' }),
    request(app).post(`/api/documents/${ctxA.docId}/download/reserve`).set(authA).send({ format: 'txt', idempotency_key: 'conc-2' }),
  ]);
  const statuses = [c1.status, c2.status].sort();
  assert.deepEqual(statuses, [201, 402]);
  const winnerTx = c1.status === 201 ? c1.body.transaction : c2.body.transaction;

  // 2. User B tidak boleh mengambil file, mengonfirmasi, atau membatalkan transaksi User A (403)
  const stealFile = await request(app).get(`/api/documents/${ctxA.docId}/download/file?tx=${winnerTx.id}`).set(authB);
  assert.equal(stealFile.status, 403);
  const stealCommit = await request(app).post(`/api/documents/${ctxA.docId}/download/${winnerTx.id}/commit`).set(authB);
  assert.equal(stealCommit.status, 403);

  // 3. Duplicate reserve dengan idempotency_key sama mengembalikan transaksi yang sama tanpa reservasi ganda
  const dupReserve = await request(app)
    .post(`/api/documents/${ctxA.docId}/download/reserve`)
    .set(authA)
    .send({ format: 'txt', idempotency_key: winnerTx.idempotency_key });
  assert.equal(dupReserve.status, 200);
  assert.equal(dupReserve.body.duplicate, true);
  assert.equal(dupReserve.body.transaction.id, winnerTx.id);

  // 4. Release expired reservations secara otomatis
  const released = await downloadTransactions.releaseExpired(new Date(Date.now() + 10 * 60 * 1000).toISOString());
  assert.ok(released >= 1);
  const balAfterExpire = await request(app).get('/api/tokens').set(authA);
  assert.equal(balAfterExpire.body.balance, 1);
  assert.equal(balAfterExpire.body.reserved_tokens, 0);
  assert.equal(balAfterExpire.body.available_balance, 1);

  // 5. Audit history endpoint /api/tokens/downloads & X-Request-Id header
  const hist = await request(app).get('/api/tokens/downloads').set(authA);
  assert.equal(hist.status, 200);
  assert.ok(hist.headers['x-request-id'], 'X-Request-Id header wajib ada');
  assert.ok(Array.isArray(hist.body.download_transactions));
  assert.ok(hist.body.download_transactions.some((t) => t.state === 'expired'));

  // 6. Kegagalan konversi DOCX-ke-PDF saat LibreOffice nonaktif tidak memotong token!
  const prevConv = process.env.DOCX_PDF_CONVERSION_ENABLED;
  try {
    process.env.DOCX_PDF_CONVERSION_ENABLED = 'false';
    await tokenTransactions.credit({ user_id: ctxA.userId, amount: 3, type: 'purchase', description: 'Topup uji konversi' });
    const docx = new Document({
      sections: [{
        children: [
          new Paragraph({
            children: [new TextRun('Dokumen akademik ini dibuat secara khusus untuk menguji skenario kegagalan konversi dokumen DOCX ke format PDF agar reservasi token pengguna dilepaskan secara otomatis tanpa memotong saldo.')],
          }),
        ],
      }],
    });
    const docxBuf = await Packer.toBuffer(docx);
    const up = await request(app)
      .post('/api/analysis')
      .set(authA)
      .field('ai_consent', 'true')
      .attach('file', docxBuf, { filename: 'uji.docx', contentType: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document' });
    assert.equal(up.status, 201);
    const balBeforeFail = (await request(app).get('/api/tokens').set(authA)).body.balance;

    const rFail = await request(app)
      .post(`/api/documents/${up.body.document.id}/download/reserve`)
      .set(authA)
      .send({ format: 'pdf' });
    assert.equal(rFail.status, 201);

    const fileFail = await request(app)
      .get(`/api/documents/${up.body.document.id}/download/file?tx=${rFail.body.transaction.id}`)
      .set(authA);
    assert.equal(fileFail.status, 503);
    assert.ok(fileFail.body.request_id);

    const balAfterFail = (await request(app).get('/api/tokens').set(authA)).body;
    assert.equal(balAfterFail.balance, balBeforeFail, 'saldo tidak boleh berkurang saat konversi PDF gagal');
    assert.equal(balAfterFail.reserved_tokens, 0, 'reservasi harus dilepas otomatis saat file gagal dibuat');
  } finally {
    if (prevConv === undefined) delete process.env.DOCX_PDF_CONVERSION_ENABLED;
    else process.env.DOCX_PDF_CONVERSION_ENABLED = prevConv;
  }
});
