import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import crypto from 'node:crypto';
import request from 'supertest';

process.env.NODE_ENV = 'test';
process.env.RATE_LIMIT_AUTH_MAX = '1000';
process.env.RATE_LIMIT_PAYMENT_MAX = '1000';
process.env.JWT_ACCESS_SECRET = 'qris-dynamic-payment-test-secret-32-chars';

const { createApp } = await import('../src/app.js');
const { config } = await import('../src/config.js');
const { payments } = await import('../src/repositories/index.js');

const app = createApp();

let mockMidtrans;
let chargeCalls = [];
let statusResponses = new Map();

test.before(async () => {
  mockMidtrans = http.createServer((req, res) => {
    let body = '';
    req.on('data', (c) => { body += c; });
    req.on('end', () => {
      if (req.method === 'POST' && req.url === '/v2/charge') {
        const parsed = JSON.parse(body || '{}');
        chargeCalls.push(parsed);
        const orderId = parsed.transaction_details?.order_id || 'ORD';
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({
          status_code: '201',
          transaction_id: `tx-${orderId}`,
          order_id: orderId,
          transaction_status: 'pending',
          actions: [{ name: 'generate-qr-code', url: `http://127.0.0.1:${mockMidtrans.address().port}/qr/${orderId}` }],
        }));
        return;
      }
      if (req.method === 'GET' && req.url.startsWith('/v2/') && req.url.endsWith('/status')) {
        const orderId = decodeURIComponent(req.url.slice(4, -7));
        const custom = statusResponses.get(orderId) || { transaction_status: 'expire', transaction_id: `tx-${orderId}` };
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ order_id: orderId, ...custom }));
        return;
      }
      res.writeHead(404);
      res.end();
    });
  });
  await new Promise((resolve) => mockMidtrans.listen(0, '127.0.0.1', resolve));
  config.payments.serverKey = 'SB-Mid-server-qris-test-key';
  config.payments.apiBase = `http://127.0.0.1:${mockMidtrans.address().port}`;
});

test.after(async () => {
  await new Promise((resolve) => mockMidtrans.close(resolve));
});

function signWebhook(orderId, statusCode, grossAmount) {
  return crypto
    .createHash('sha512')
    .update(`${orderId}${statusCode}${grossAmount}${config.payments.serverKey}`)
    .digest('hex');
}

async function createUser() {
  const email = `qris-${Date.now()}-${Math.random().toString(16).slice(2, 7)}@runut.test`;
  const r = await request(app).post('/api/auth/register').send({ name: 'Uji QRIS', email, password: 'Password123!' });
  assert.equal(r.status, 201);
  return { id: r.body.user.id, token: r.body.accessToken };
}

test('QRIS Dinamis: masa berlaku 10 menit, custom_expiry dikirim ke Midtrans, auto-renew idempoten & unik', async () => {
  chargeCalls = [];
  statusResponses.clear();
  const user = await createUser();
  const auth = { Authorization: `Bearer ${user.token}` };

  // 1. Buat QRIS baru -> masa berlaku harus ~600 detik (10 menit)
  const created = await request(app)
    .post('/api/payments')
    .set(auth)
    .send({ package_id: 'populer', method: 'qris' });
  assert.equal(created.status, 201);
  const p1 = created.body.payment;
  assert.equal(p1.channel, 'qris');
  assert.equal(p1.validity_seconds, 600);
  assert.ok(p1.remaining_seconds >= 590 && p1.remaining_seconds <= 600, `remaining_seconds=${p1.remaining_seconds}`);
  assert.ok(p1.server_time);
  assert.deepEqual(chargeCalls[0]?.custom_expiry, { expiry_duration: 10, unit: 'minute' });

  // 2. Paksa kedaluwarsa di DB lalu uji concurrent renew -> hanya 1 QRIS pengganti baru yang dibuat!
  const stored1 = await payments.findByOrderId(p1.order_id);
  await payments.update(stored1.id, { expires_at: new Date(Date.now() - 5000).toISOString() });

  const [rn1, rn2] = await Promise.all([
    request(app).post(`/api/payments/${p1.order_id}/renew`).set(auth).send({}),
    request(app).post(`/api/payments/${p1.order_id}/renew`).set(auth).send({}),
  ]);
  assert.equal(rn1.body.renewed, true);
  assert.equal(rn2.body.renewed, true);
  assert.equal(rn1.body.payment.order_id, rn2.body.payment.order_id, 'concurrent renew harus mengembalikan order pengganti yang sama');
  assert.notEqual(rn1.body.payment.order_id, p1.order_id, 'order_id QRIS baru harus unik');
  assert.equal(rn1.body.payment.replaces_order_id, p1.order_id);
  assert.equal(chargeCalls.length, 2, 'Midtrans /v2/charge hanya boleh dipanggil 1 kali untuk renewal');

  // 3. Lunasi QRIS pengganti lewat webhook sah -> saldo bertambah 10 token tepat 1 kali
  const p2 = rn1.body.payment;
  const wh2 = await request(app).post('/api/payments/notify').send({
    order_id: p2.order_id,
    status_code: '200',
    gross_amount: String(p2.amount),
    transaction_status: 'settlement',
    fraud_status: 'accept',
    transaction_id: `tx-${p2.order_id}`,
    signature_key: signWebhook(p2.order_id, '200', String(p2.amount)),
  });
  assert.equal(wh2.status, 200);
  assert.equal(wh2.body.status, 'paid');

  const bal1 = (await request(app).get('/api/tokens').set(auth)).body.balance;
  assert.equal(bal1, 20, '10 token bonus awal + 10 token pembelian');

  // 4. Late webhook untuk QRIS lama (p1) setelah p2 SUDAH lunas -> TIDAK boleh kredit ganda, harus ditandai rekonsiliasi!
  const whLate = await request(app).post('/api/payments/notify').send({
    order_id: p1.order_id,
    status_code: '200',
    gross_amount: String(p1.amount),
    transaction_status: 'settlement',
    fraud_status: 'accept',
    transaction_id: `tx-${p1.order_id}`,
    signature_key: signWebhook(p1.order_id, '200', String(p1.amount)),
  });
  assert.equal(whLate.status, 200);
  const bal2 = (await request(app).get('/api/tokens').set(auth)).body.balance;
  assert.equal(bal2, 20, 'late payment setelah replacement lunas tidak boleh menggandakan saldo token');
  const p1Updated = await payments.findByOrderId(p1.order_id);
  assert.equal(p1Updated.reconciliation_flag, 'late_payment_after_replacement_paid');
});

test('QRIS Dinamis: pembayaran terlambat pada QRIS expired (tanpa replacement lunas) tetap dikreditkan sekali & batalkan replacement pending', async () => {
  statusResponses.clear();
  const user = await createUser();
  const auth = { Authorization: `Bearer ${user.token}` };

  const c1 = await request(app).post('/api/payments').set(auth).send({ package_id: 'hemat', method: 'qris' });
  const p1 = c1.body.payment;
  const stored1 = await payments.findByOrderId(p1.order_id);
  await payments.update(stored1.id, { expires_at: new Date(Date.now() - 5000).toISOString() });

  const rn = await request(app).post(`/api/payments/${p1.order_id}/renew`).set(auth).send({});
  const p2 = rn.body.payment;
  assert.equal(p2.status, 'pending');

  // Webhook settlement terlambat datang untuk p1 sementara p2 masih pending
  const whLate = await request(app).post('/api/payments/notify').send({
    order_id: p1.order_id,
    status_code: '200',
    gross_amount: String(p1.amount),
    transaction_status: 'settlement',
    fraud_status: 'accept',
    transaction_id: `tx-${p1.order_id}`,
    signature_key: signWebhook(p1.order_id, '200', String(p1.amount)),
  });
  assert.equal(whLate.status, 200);
  assert.equal(whLate.body.status, 'paid');

  const bal = (await request(app).get('/api/tokens').set(auth)).body.balance;
  assert.equal(bal, 15, 'pembayaran sah yang terlambat harus tetap dikreditkan 5 token di atas 10 token bonus awal');
  const p2After = await payments.findByOrderId(p2.order_id);
  assert.equal(p2After.status, 'cancelled', 'QRIS pengganti yang masih pending harus dibatalkan');
});
