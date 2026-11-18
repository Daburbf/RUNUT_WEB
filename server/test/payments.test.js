import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import request from 'supertest';

process.env.NODE_ENV = 'test';
process.env.MIDTRANS_SERVER_KEY = '';
process.env.RATE_LIMIT_AUTH_MAX = '1000';
process.env.JWT_ACCESS_SECRET = 'test-secret-yang-cukup-panjang-32-karakter';

const { createApp } = await import('../src/app.js');
const { config } = await import('../src/config.js');
const app = createApp();

const emailOf = () => `bayar${Date.now()}${Math.random().toString(16).slice(2, 8)}@runut.test`;

async function newUser(agent) {
  const res = await agent.post('/api/auth/register')
    .send({ name: 'Pembayar Uji', email: emailOf(), password: 'rahasia12345' });
  assert.equal(res.status, 201, JSON.stringify(res.body));
  return { token: res.body.accessToken, id: res.body.user.id, auth: { Authorization: `Bearer ${res.body.accessToken}` } };
}

test('health & katalog: 3 paket token dan 10 metode pembayaran datang dari server', async () => {
  const health = await request(app).get('/api/health');
  assert.equal(health.status, 200);
  assert.equal(health.body.tokens.available, false, 'tanpa kunci gateway pembelian ditutup');
  assert.equal(health.body.tokens.mode, 'unavailable');
  assert.equal(health.body.tokens.packages.length, 3);
  assert.deepEqual(
    health.body.tokens.packages.map((p) => ({ id: p.id, tokens: p.tokens, price_idr: p.price_idr })),
    [
      { id: 'hemat', tokens: 5, price_idr: 5000 },
      { id: 'populer', tokens: 10, price_idr: 9000 },
      { id: 'lebih_hemat', tokens: 20, price_idr: 16000 },
    ],
  );

  const agent = request.agent(app);
  const user = await newUser(agent);
  const res = await agent.get('/api/payments').set(user.auth);
  assert.equal(res.status, 200, JSON.stringify(res.body));
  assert.equal(res.body.available, false);
  assert.equal(res.body.mode, 'unavailable');
  assert.equal(res.body.packages.length, 3);
  assert.ok(res.body.methods.length >= 8, 'metode pembayaran lengkap');
  assert.deepEqual(res.body.orders, []);
  const ids = res.body.methods.map((m) => m.id);
  for (const id of ['qris', 'va_bca', 'gopay', 'card', 'alfamart']) {
    assert.ok(ids.includes(id), `metode ${id} tersedia`);
  }
});

test('tanpa kredensial Midtrans, pembelian tertutup dan endpoint simulator tidak ada', async () => {
  const agent = request.agent(app);
  const user = await newUser(agent);
  const created = await agent.post('/api/payments').set(user.auth).send({ package_id: 'hemat', method: 'va_bca' });
  assert.equal(created.status, 503);
  assert.equal(created.body.code, 'PAYMENTS_UNAVAILABLE');
  const simulated = await agent.post('/api/payments/RUNUT-TIDAK-ADA/simulate').set(user.auth).send({});
  assert.equal(simulated.status, 404);
  assert.equal(simulated.body.error, 'Endpoint tidak ditemukan.');
});

test('metode atau paket tidak dikenal ditolak tanpa memanggil gateway', async () => {
  const agent = request.agent(app);
  const user = await newUser(agent);
  const badMethod = await agent.post('/api/payments').set(user.auth).send({ package_id: 'hemat', method: 'bitcoin' });
  assert.equal(badMethod.status, 400);
  assert.equal(badMethod.body.code, 'METHOD_INVALID');

  const badPkg = await agent.post('/api/payments').set(user.auth).send({ package_id: 'paket_palsu', method: 'qris' });
  assert.equal(badPkg.status, 400);
  assert.equal(badPkg.body.code, 'PACKAGE_INVALID');
});

test('pengguna tidak bisa memanipulasi nominal atau jumlah token dari frontend', async () => {
  // Buat stub Midtrans lokal untuk memeriksa nominal yang dikirim server ke gateway
  let lastChargeBody = null;
  const midtransStub = http.createServer((req, res) => {
    let raw = '';
    req.on('data', (c) => { raw += c; });
    req.on('end', () => {
      lastChargeBody = JSON.parse(raw);
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({
        transaction_id: 'mid-tx-999',
        va_numbers: [{ bank: 'bca', va_number: '1234567890' }],
      }));
    });
  });
  await new Promise((resolve) => midtransStub.listen(0, '127.0.0.1', resolve));
  const port = midtransStub.address().port;

  config.payments.serverKey = 'SB-Mid-server-test';
  config.payments.apiBase = `http://127.0.0.1:${port}`;
  try {
    const agent = request.agent(app);
    const user = await newUser(agent);
    // Klien mencoba mengirim amount: 100 dan token_amount: 999999 untuk paket lebih_hemat (20 token, Rp16.000)
    const created = await agent.post('/api/payments').set(user.auth).send({
      package_id: 'lebih_hemat',
      method: 'va_bca',
      amount: 100,
      price_idr: 100,
      tokens: 999999,
      token_amount: 999999,
    });
    assert.equal(created.status, 201);
    assert.equal(created.body.payment.amount, 16000, 'server memakai harga paket resmi Rp16.000, bukan input klien');
    assert.equal(created.body.payment.token_amount, 20, 'server memakai 20 token sesuai paket, bukan input klien');
    assert.equal(lastChargeBody.transaction_details.gross_amount, 16000, 'tagihan ke Midtrans tetap Rp16.000');

    // Pengguna lain tidak boleh mengakses transaksi ini
    const otherAgent = request.agent(app);
    const stranger = await newUser(otherAgent);
    const forbidden = await otherAgent.get(`/api/payments/${created.body.payment.order_id}`).set(stranger.auth);
    assert.equal(forbidden.status, 403);
  } finally {
    config.payments.serverKey = '';
    config.payments.apiBase = '';
    midtransStub.close();
  }
});
