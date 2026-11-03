import test from 'node:test';
import assert from 'node:assert/strict';
import request from 'supertest';

// Payment gateway: tanpa kredensial, pembelian dinonaktifkan. Simulator tidak boleh menandai lunas.
process.env.NODE_ENV = 'test';
process.env.MIDTRANS_SERVER_KEY = '';
process.env.RATE_LIMIT_AUTH_MAX = '1000';
process.env.JWT_ACCESS_SECRET = 'test-secret-yang-cukup-panjang-32-karakter';

const { createApp } = await import('../src/app.js');
const app = createApp();

const emailOf = () => `bayar${Date.now()}${Math.random().toString(16).slice(2, 8)}@runut.test`;

async function newUser(agent) {
  const res = await agent.post('/api/auth/register')
    .send({ name: 'Pembayar Uji', email: emailOf(), password: 'rahasia12345' });
  assert.equal(res.status, 201, JSON.stringify(res.body));
  return { token: res.body.accessToken, id: res.body.user.id, auth: { Authorization: `Bearer ${res.body.accessToken}` } };
}

test('health & katalog: harga dan metode datang dari server', async () => {
  const health = await request(app).get('/api/health');
  assert.equal(health.status, 200);
  assert.equal(health.body.premium.price_idr, 49000, 'harga seragam dengan footer website');
  assert.equal(health.body.premium.duration_days, 30);
  assert.equal(health.body.premium.available, false, 'tanpa kunci gateway tidak boleh membuka pembelian');
  assert.equal(health.body.premium.mode, 'unavailable');
  assert.equal(health.body.limits.free_words, 500);
  assert.equal(health.body.limits.premium_words, null, 'Premium tanpa batas kata');

  const agent = request.agent(app);
  const user = await newUser(agent);
  const res = await agent.get('/api/payments').set(user.auth);
  assert.equal(res.status, 200, JSON.stringify(res.body));
  assert.equal(res.body.available, false);
  assert.equal(res.body.mode, 'unavailable');
  assert.equal(res.body.price_idr, 49000);
  assert.ok(res.body.methods.length >= 8, 'metode pembayaran lengkap');
  assert.deepEqual(res.body.orders, []);
  const ids = res.body.methods.map((m) => m.id);
  for (const id of ['qris', 'va_bca', 'gopay', 'card', 'alfamart']) {
    assert.ok(ids.includes(id), `metode ${id} tersedia`);
  }
});

test('tanpa kredensial Midtrans, pembelian tertutup dan endpoint simulator tidak melunasi transaksi', async () => {
  const agent = request.agent(app);
  const user = await newUser(agent);
  const created = await agent.post('/api/payments').set(user.auth).send({ method: 'va_bca' });
  assert.equal(created.status, 503);
  assert.equal(created.body.code, 'PAYMENTS_UNAVAILABLE');
  const simulated = await agent.post('/api/payments/RUNUT-TIDAK-ADA/simulate').set(user.auth).send({});
  assert.equal(simulated.status, 404);
  assert.equal(simulated.body.error, 'Endpoint tidak ditemukan.');
});

test('metode tidak dikenal ditolak tanpa memanggil gateway', async () => {
  const agent = request.agent(app);
  const user = await newUser(agent);
  const bad = await agent.post('/api/payments').set(user.auth).send({ method: 'bitcoin' });
  assert.equal(bad.status, 400);
  assert.equal(bad.body.code, 'METHOD_INVALID');
});

test('endpoint simulator dihapus dan tidak bisa melunasi transaksi', async () => {
  const agent = request.agent(app);
  const user = await newUser(agent);
  const res = await agent.post('/api/payments/RUNUT-TIDAK-ADA/simulate').set(user.auth).send({});
  assert.equal(res.status, 404);
  assert.equal(res.body.error, 'Endpoint tidak ditemukan.');
});
