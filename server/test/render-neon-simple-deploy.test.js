// Simple Zero-Cost Deployment Verification Tests
// Covers:
// 1. Neon Free PostgreSQL BYTEA storage (OBJECT_STORAGE_PROVIDER=postgres):
//    - Persistent binary save & retrieval after memory cache clear (simulates Render restart)
//    - SHA-256 verification on read & cross-user ownership isolation
//    - Conservative application-side limits: 700 MB managed data cap & 4 GB/mo outbound transfer cap
//    - Preserves existing documents when quota is exhausted
// 2. Render Free 512 MB RAM conversion guard (createConversionLimiter):
//    - Single-concurrency serialization (maxConcurrent=1)
//    - Bounded queue rejection (CONVERSION_QUEUE_FULL)
//    - Low-memory guard (INSUFFICIENT_MEMORY)
// 3. render.yaml blueprint verification (Free plan, Docker, postgres storage, sandbox Midtrans, free AI only)
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import { initStorage, documents } from '../src/repositories/index.js';
import {
  DEFAULT_PG_MAX_MANAGED_BYTES,
  DEFAULT_PG_MAX_OUTBOUND_BYTES,
  getPostgresStorageLimits,
  saveOriginalUploadPersistent,
  getOriginalUploadPersistent,
  clearMemoryFileCache,
} from '../src/services/fileStore.js';
import { createConversionLimiter } from '../src/services/libreOffice.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, '../..');

function sha256(buf) {
  return createHash('sha256').update(buf).digest('hex');
}

test('Simple Deploy 1: PostgreSQL BYTEA storage enforces 700 MB / 4 GB Neon Free safety caps, SHA-256, and cross-user isolation', async () => {
  const defaults = getPostgresStorageLimits({});
  assert.equal(defaults.maxManagedBytes, 700 * 1024 * 1024);
  assert.equal(defaults.maxManagedBytes, DEFAULT_PG_MAX_MANAGED_BYTES);
  assert.equal(defaults.maxOutboundBytes, 4 * 1024 * 1024 * 1024);
  assert.equal(defaults.maxOutboundBytes, DEFAULT_PG_MAX_OUTBOUND_BYTES);

  // Over-requesting beyond 700 MB / 4 GB clamps safely
  const clamped = getPostgresStorageLimits({
    PG_MAX_MANAGED_BYTES: String(2 * 1024 * 1024 * 1024),
    PG_MAX_OUTBOUND_BYTES: String(10 * 1024 * 1024 * 1024),
  });
  assert.equal(clamped.maxManagedBytes, DEFAULT_PG_MAX_MANAGED_BYTES);
  assert.equal(clamped.maxOutboundBytes, DEFAULT_PG_MAX_OUTBOUND_BYTES);

  await initStorage('', { persistPath: null });
  const ownerId = '55555555-5555-4555-8555-555555555555';
  const otherId = '66666666-6666-4666-8666-666666666666';
  const tightPgEnv = {
    OBJECT_STORAGE_PROVIDER: 'postgres',
    PG_MAX_MANAGED_BYTES: '2048',
    PG_MAX_DATABASE_BYTES: '2048',
    PG_MAX_OUTBOUND_BYTES: '2048',
  };

  const payload1 = Buffer.alloc(1200, 'A');
  const doc1 = await documents.create({
    user_id: ownerId,
    title: 'Neon PG Doc 1',
    original_text: 'Sample content',
    word_count: 2,
    token_cost: 1,
    file_name: 'doc1.pdf',
  });

  const saved1 = await saveOriginalUploadPersistent(doc1.id, {
    userId: ownerId,
    buffer: payload1,
    ext: 'pdf',
    originalName: 'doc1.pdf',
    env: tightPgEnv,
  });
  assert.equal(saved1.storageProvider, 'postgres');

  // Simulate Render container restart by clearing in-memory cache
  clearMemoryFileCache();
  const got1 = await getOriginalUploadPersistent(doc1.id, { userId: ownerId, env: tightPgEnv });
  assert.equal(got1.storageProvider, 'postgres');
  assert.equal(sha256(got1.buffer), sha256(payload1));

  // Cross-user isolation enforced
  assert.equal(await getOriginalUploadPersistent(doc1.id, { userId: otherId, env: tightPgEnv }), null);

  // Second upload exceeding 2048 byte cap MUST be rejected safely without deleting doc1
  const doc2 = await documents.create({
    user_id: ownerId,
    title: 'Neon PG Doc 2',
    original_text: 'Overflow content',
    word_count: 2,
    token_cost: 1,
    file_name: 'doc2.pdf',
  });
  await assert.rejects(
    () => saveOriginalUploadPersistent(doc2.id, {
      userId: ownerId,
      buffer: Buffer.alloc(1200, 'B'),
      ext: 'pdf',
      originalName: 'doc2.pdf',
      env: tightPgEnv,
    }),
    (err) => err?.code === 'POSTGRES_STORAGE_CAPACITY_LIMIT' && err?.status === 503,
  );

  // Second download exceeding 2048 byte outbound transfer cap MUST be rejected safely
  await assert.rejects(
    () => getOriginalUploadPersistent(doc1.id, { userId: ownerId, env: tightPgEnv }),
    (err) => err?.code === 'POSTGRES_OUTBOUND_LIMIT' && err?.status === 503,
  );
});

test('Simple Deploy 2: Render Free 512 MB RAM conversion limiter serializes jobs, bounds queue, and guards low memory', async () => {
  // Low-memory guard rejects immediately when RSS >= maxRssMb
  const lowMemLimiter = createConversionLimiter({
    maxConcurrent: 1,
    maxQueue: 2,
    maxRssMb: 380,
    getRssBytes: () => 400 * 1024 * 1024,
  });
  const memBlocked = await lowMemLimiter.run(async () => ({ ok: true }));
  assert.equal(memBlocked.ok, false);
  assert.equal(memBlocked.code, 'INSUFFICIENT_MEMORY');

  // Single-concurrency + bounded queue (1 active + 1 queued; 3rd rejected immediately)
  let running = 0;
  let maxObserved = 0;
  const limiter = createConversionLimiter({
    maxConcurrent: 1,
    maxQueue: 1,
    maxRssMb: 380,
    getRssBytes: () => 150 * 1024 * 1024,
  });

  const job = () => limiter.run(async () => {
    running += 1;
    maxObserved = Math.max(maxObserved, running);
    await new Promise((r) => setTimeout(r, 40));
    running -= 1;
    return { ok: true };
  });

  const [r1, r2, r3] = await Promise.all([job(), job(), job()]);
  assert.equal(r1.ok, true);
  assert.equal(r2.ok, true);
  assert.equal(r3.ok, false);
  assert.equal(r3.code, 'CONVERSION_QUEUE_FULL');
  assert.equal(maxObserved, 1, 'Never run more than 1 concurrent conversion on Render Free');
});

test('Simple Deploy 3: render.yaml uses Free Docker plan, Neon PostgreSQL storage, sandbox Midtrans, and 512 MB RAM guards', () => {
  const raw = readFileSync(path.join(REPO_ROOT, 'render.yaml'), 'utf8');
  assert.match(raw, /plan:\s*free/);
  assert.match(raw, /runtime:\s*docker/);
  assert.match(raw, /key:\s*OBJECT_STORAGE_PROVIDER[\s\S]*?value:\s*"postgres"/);
  assert.match(raw, /key:\s*MAX_CONCURRENT_CONVERSIONS[\s\S]*?value:\s*"1"/);
  assert.match(raw, /key:\s*CONVERSION_MAX_RSS_MB[\s\S]*?value:\s*"380"/);
  assert.match(raw, /key:\s*MIDTRANS_IS_PRODUCTION[\s\S]*?value:\s*"false"/);
  assert.match(raw, /key:\s*STRICT_FREE_AI_ONLY[\s\S]*?value:\s*"true"/);
});
