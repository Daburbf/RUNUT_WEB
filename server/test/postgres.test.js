import test from 'node:test';
import assert from 'node:assert/strict';
import { initStorage, users, tokenTransactions, refreshTokens, storage } from '../src/repositories/index.js';

const url = process.env.RUNUT_TEST_DATABASE_URL || '';

test('adapter PostgreSQL: skema otomatis, akun, ledger token, dan siklus sesi', { skip: url || 'RUNUT_TEST_DATABASE_URL belum diisi' }, async () => {
  const info = await initStorage(url);
  assert.equal(info.driver, 'postgresql', 'initStorage harus memilih adapter PostgreSQL');
  assert.match(storage.detail, /PostgreSQL/);

  const email = `pg${Date.now()}${Math.random().toString(16).slice(2, 8)}@runut.test`;
  const created = await users.create({ name: 'Uji PG', email, password_hash: 'x' });
  assert.ok(created.id, 'create mengembalikan baris dengan id');
  assert.equal(created.token_balance, 0);

  assert.equal((await users.findById(created.id)).email, email);
  assert.equal((await users.findByEmail(email.toUpperCase())).id, created.id);

  // Kolom di luar whitelist (termasuk token_balance) tidak boleh diubah lewat update()
  const updated = await users.update(created.id, { name: 'Nama Baru', token_balance: 9999, id: '00000000-0000-0000-0000-000000000000', drop_all: true });
  assert.equal(updated.name, 'Nama Baru');
  assert.equal(updated.id, created.id);
  assert.equal(updated.token_balance, 0, 'token_balance tidak boleh bisa diubah lewat update()');

  // Operasi atomik ledger token di PostgreSQL
  const creditRes = await tokenTransactions.credit({
    user_id: created.id,
    amount: 10,
    type: 'purchase',
    description: 'Pembelian Paket Populer (10 token)',
    reference_type: 'payment',
    reference_id: 'ORDER-PG-1',
    idempotency_key: 'payment:ORDER-PG-1',
  });
  assert.equal(creditRes.ok, true);
  assert.equal(creditRes.user.token_balance, 10);

  const dupCredit = await tokenTransactions.credit({
    user_id: created.id,
    amount: 10,
    type: 'purchase',
    description: 'Pembelian Paket Populer (10 token)',
    reference_type: 'payment',
    reference_id: 'ORDER-PG-1',
    idempotency_key: 'payment:ORDER-PG-1',
  });
  assert.equal(dupCredit.duplicate, true);
  assert.equal(dupCredit.user.token_balance, 10);

  const deductRes = await tokenTransactions.deduct({
    user_id: created.id,
    amount: 3,
    description: 'Analisis 2500 kata',
    reference_type: 'analysis',
  });
  assert.equal(deductRes.ok, true);
  assert.equal(deductRes.balance, 7);

  const refundRes = await tokenTransactions.refund({
    user_id: created.id,
    amount: 3,
    description: 'Refund analisis gagal',
  });
  assert.equal(refundRes.ok, true);
  assert.equal(refundRes.user.token_balance, 10);

  const summary = await tokenTransactions.summaryByUser(created.id);
  assert.equal(summary.balance, 10);
  assert.equal(summary.total_purchased, 10);
  assert.equal(summary.total_used, 0);

  const token = `hash-${Date.now()}`;
  const session = await refreshTokens.create({ user_id: created.id, token_hash: token, expires_at: new Date(Date.now() + 3600e3), user_agent: 'uji' });
  assert.equal((await refreshTokens.findByHash(token)).id, session.id);
  assert.equal(await refreshTokens.revokeByHash(token), true);
  assert.equal(await refreshTokens.revokeByHash(token), false);
});
