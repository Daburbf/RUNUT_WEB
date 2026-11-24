import test from 'node:test';
import assert from 'node:assert/strict';
import {
  initStorage,
  closeStorage,
  healthCheck,
  users,
  tokenTransactions,
  refreshTokens,
  documents,
  analyses,
  issues,
  downloadTransactions,
  documentFiles,
  storage,
} from '../src/repositories/index.js';
import { MIGRATIONS } from '../src/repositories/migrations.js';
import { USER_COLUMNS, resolveSslOption } from '../src/repositories/postgres.js';

const url = process.env.RUNUT_TEST_DATABASE_URL || '';
const requireIntegration = String(process.env.RUNUT_REQUIRE_INTEGRATION_TESTS || '').toLowerCase() === 'true';

test('migrasi & konfigurasi PostgreSQL: versi berurutan, kolom legacy dibersihkan, whitelist & SSL valid', async () => {
  assert.ok(MIGRATIONS.length >= 2, 'minimal 2 migrasi berversi tersedia');
  for (let i = 0; i < MIGRATIONS.length; i++) {
    assert.equal(MIGRATIONS[i].version, i + 1, 'versi migrasi harus berurutan mulai dari 1');
    assert.ok(MIGRATIONS[i].name && MIGRATIONS[i].sql, 'setiap migrasi wajib memiliki nama dan SQL');
  }

  // Pastikan token_version masuk whitelist dan kolom legacy sudah dihapus
  assert.equal(USER_COLUMNS.has('token_version'), true, 'token_version wajib bisa diperbarui saat reset password');
  assert.equal(USER_COLUMNS.has('token_balance'), false, 'token_balance tidak boleh masuk whitelist update()');
  assert.equal(USER_COLUMNS.has('is_premium'), false, 'kolom legacy is_premium harus dihapus dari whitelist');
  assert.equal(USER_COLUMNS.has('premium_until'), false, 'kolom legacy premium_until harus dihapus dari whitelist');

  // Resolusi SSL untuk deploy production vs lokal
  assert.equal(resolveSslOption('postgres://postgres:pw@localhost:5432/runut', { NODE_ENV: 'production' }), false);
  assert.deepEqual(
    resolveSslOption('postgres://user:pw@dpg-abc.singapore-postgres.render.com:5432/runut', { NODE_ENV: 'production' }),
    { rejectUnauthorized: false },
  );
  assert.equal(
    resolveSslOption('postgres://user:pw@dpg-abc.render.com:5432/runut', { NODE_ENV: 'production', DATABASE_SSL: 'false' }),
    false,
  );
  assert.deepEqual(
    resolveSslOption('postgres://user:pw@localhost:5432/runut', { DATABASE_SSL: 'true', DATABASE_SSL_REJECT_UNAUTHORIZED: 'true' }),
    { rejectUnauthorized: true },
  );
});

test('repository parity: countPendingByDocument hanya menghitung analisis terbaru & cleanup expired bekerja', async () => {
  await initStorage('', { persistPath: null });
  const health = await healthCheck();
  assert.equal(health.ok, true);

  const user = await users.create({ name: 'Uji Parity', email: `parity-${Date.now()}@runut.test`, password_hash: 'x' });
  assert.equal('is_premium' in user, false, 'user baru tidak lagi membawa kolom legacy is_premium');
  assert.equal('premium_until' in user, false, 'user baru tidak lagi membawa kolom legacy premium_until');

  const doc = await documents.create({
    user_id: user.id,
    title: 'Dokumen Uji',
    original_text: 'Halo dunia ini teks uji coba untuk verifikasi.',
    word_count: 8,
    token_cost: 1,
  });

  const a1 = await analyses.create({ document_id: doc.id, stats: {}, token_cost: 1 });
  await issues.createMany([
    { analysis_id: a1.id, category: 'ejaan', start_pos: 0, end_pos: 4, snippet: 'Halo', decision: 'active' },
    { analysis_id: a1.id, category: 'ejaan', start_pos: 5, end_pos: 10, snippet: 'dunia', decision: 'active' },
  ]);
  assert.equal(await issues.countPendingByDocument(doc.id), 2);

  const a2 = await analyses.create({ document_id: doc.id, stats: {}, token_cost: 1 });
  await issues.createMany([
    { analysis_id: a2.id, category: 'ejaan', start_pos: 0, end_pos: 4, snippet: 'Halo', decision: 'active' },
  ]);
  assert.equal(await issues.countPendingByDocument(doc.id), 1, 'hanya menghitung issue aktif dari analisis terbaru');

  await refreshTokens.create({
    user_id: user.id,
    token_hash: `expired-${Date.now()}`,
    expires_at: new Date(Date.now() - 60_000).toISOString(),
  });
  const removedTokens = await refreshTokens.deleteExpired();
  assert.ok(removedTokens >= 1, 'refresh token kedaluwarsa harus terhapus');
});

test('adapter PostgreSQL: migrasi otomatis v5, token_version, ledger atomik, transaksi unduhan, concurrent, file persisten, dan isolasi user', async (t) => {
  if (!url) {
    if (requireIntegration) {
      assert.fail('RUNUT_REQUIRE_INTEGRATION_TESTS=true tetapi RUNUT_TEST_DATABASE_URL belum diisi. Sediakan PostgreSQL uji yang valid.');
    }
    t.skip('RUNUT_TEST_DATABASE_URL belum diisi (set RUNUT_REQUIRE_INTEGRATION_TESTS=true di CI untuk wajib gagal bila tidak tersedia)');
    return;
  }
  const info = await initStorage(url);
  try {
    assert.equal(info.driver, 'postgresql', 'initStorage harus memilih adapter PostgreSQL');
    assert.match(storage.detail, /PostgreSQL v/);

    const health = await healthCheck();
    assert.equal(health.ok, true);
    assert.equal(health.driver, 'postgresql');
    assert.ok(health.schema_version >= 5, `schema_version harus >= 5, didapat ${health.schema_version}`);

    const email = `pg${Date.now()}${Math.random().toString(16).slice(2, 8)}@runut.test`;
    const otherEmail = `pgother${Date.now()}${Math.random().toString(16).slice(2, 8)}@runut.test`;
    const created = await users.create({ name: 'Uji PG', email, password_hash: 'x' });
    const otherUser = await users.create({ name: 'User Lain', email: otherEmail, password_hash: 'x' });
    assert.ok(created.id, 'create mengembalikan baris dengan id');
    assert.equal(created.token_balance, 0);
    assert.equal(created.token_version, 0);

    assert.equal((await users.findById(created.id)).email, email);
    assert.equal((await users.findByEmail(email.toUpperCase())).id, created.id);

    // Kolom di luar whitelist (termasuk token_balance) tidak boleh diubah lewat update(),
    // sedangkan token_version HARUS bisa diperbarui.
    const updated = await users.update(created.id, {
      name: 'Nama Baru',
      token_version: 1,
      token_balance: 9999,
      id: '00000000-0000-0000-0000-000000000000',
      drop_all: true,
    });
    assert.equal(updated.name, 'Nama Baru');
    assert.equal(updated.token_version, 1, 'token_version wajib bisa diperbarui di PostgreSQL');
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

    // Concurrent deductions must never produce negative balance
    const concurrentResults = await Promise.all([
      tokenTransactions.deduct({ user_id: created.id, amount: 6, description: 'Concurrent 1', reference_type: 'analysis' }),
      tokenTransactions.deduct({ user_id: created.id, amount: 6, description: 'Concurrent 2', reference_type: 'analysis' }),
    ]);
    const okCount = concurrentResults.filter((r) => r.ok).length;
    assert.equal(okCount, 1, 'hanya satu pemotongan 6 token dari saldo 10 yang boleh berhasil secara konkuren');
    const afterConcurrent = await tokenTransactions.summaryByUser(created.id);
    assert.equal(afterConcurrent.balance, 4);

    // Document ownership & persistent file storage (Migration v5)
    const pgDoc = await documents.create({
      user_id: created.id,
      title: 'Dokumen Persisten PG',
      original_text: 'Isi dokumen uji untuk penyimpanan persisten PostgreSQL.',
      word_count: 8,
      token_cost: 1,
      file_name: 'uji.pdf',
    });
    const sampleBytes = Buffer.from('%PDF-1.7\n%persistent-test-payload\n');
    await documentFiles.save({
      document_id: pgDoc.id,
      user_id: created.id,
      ext: 'pdf',
      original_name: 'uji.pdf',
      size_bytes: sampleBytes.length,
      sha256: 'abc123',
      content: sampleBytes,
    });
    const ownedFile = await documentFiles.findByDocumentId(pgDoc.id, { user_id: created.id });
    assert.ok(ownedFile && ownedFile.buffer.equals(sampleBytes), 'file persisten harus dapat diambil kembali oleh pemiliknya');
    const crossUserFile = await documentFiles.findByDocumentId(pgDoc.id, { user_id: otherUser.id });
    assert.equal(crossUserFile, null, 'user lain tidak boleh mengakses file persisten milik user lain');

    // Download two-phase reservation -> prepare -> commit & cancel in PostgreSQL
    const resv1 = await downloadTransactions.reserve({
      user_id: created.id,
      document_id: pgDoc.id,
      export_format: 'pdf',
      reserved_tokens: 1,
      ttl_seconds: 120,
    });
    assert.equal(resv1.ok, true);
    await downloadTransactions.markPrepared(resv1.transaction.id, created.id);
    const committed = await downloadTransactions.commit({
      id: resv1.transaction.id,
      user_id: created.id,
      description: 'Unduh PDF uji PG',
    });
    assert.equal(committed.ok, true);
    assert.equal(committed.balance, 3);

    const resv2 = await downloadTransactions.reserve({
      user_id: created.id,
      document_id: pgDoc.id,
      export_format: 'docx',
      reserved_tokens: 1,
      ttl_seconds: 120,
    });
    assert.equal(resv2.ok, true);
    const cancelled = await downloadTransactions.cancel(resv2.transaction.id, created.id, 'user_cancelled');
    assert.equal(cancelled.ok, true);
    const afterCancel = await tokenTransactions.summaryByUser(created.id);
    assert.equal(afterCancel.balance, 3, 'pembatalan unduhan tidak boleh memotong saldo');

    // Cross-user document deletion must be ignored; owner deletion cascades to document_files
    const wrongDelete = await documents.deleteMany(otherUser.id, [pgDoc.id]);
    assert.equal(wrongDelete.length, 0);
    const ownerDelete = await documents.deleteMany(created.id, [pgDoc.id]);
    assert.equal(ownerDelete.length, 1);
    assert.equal(await documentFiles.findByDocumentId(pgDoc.id), null, 'penghapusan dokumen harus cascade ke document_files');

    const token = `hash-${Date.now()}`;
    const session = await refreshTokens.create({ user_id: created.id, token_hash: token, expires_at: new Date(Date.now() + 3600e3), user_agent: 'uji' });
    assert.equal((await refreshTokens.findByHash(token)).id, session.id);
    assert.equal(await refreshTokens.revokeByHash(token), true);
    assert.equal(await refreshTokens.revokeByHash(token), false);
  } finally {
    await closeStorage();
  }
});
