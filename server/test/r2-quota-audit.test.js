// Final Pre-Deployment Audit Tests:
// - Persistent R2 monthly counters surviving process restart & multi-process contention
// - Abandoned reservation expiration & recovery
// - Failed R2 operations not committing storage bytes
// - Strict signed URL blocking (no Class B bypass)
// - Standard storage class enforcement & incomplete multipart abort
// - Cloudflare R2 GraphQL Analytics reconciliation discrepancy detection & halt
// - Quota service fail-closed behavior
// - Oracle Always Free (2 OCPU / 12 GB RAM) & Neon Free (1 GB / 100 CU-hours / 20 GB) verification
import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createMemoryRepositories } from '../src/repositories/memory.js';
import { MIGRATIONS } from '../src/repositories/migrations.js';
import {
  reserveR2Operation,
  getR2QuotaSnapshot,
  reconcileR2UsageWithAnalytics,
  R2_OPERATION_REGISTRY,
} from '../src/services/r2Quota.js';
import {
  putR2Object,
  abortR2MultipartUpload,
  generateR2SignedDownloadUrl,
} from '../src/services/r2Storage.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '../..');

test('Audit 1: Monthly R2 counters survive process restart and prevent two independent processes from double-reserving quota', async () => {
  const tmpDir = mkdtempSync(path.join(os.tmpdir(), 'runut-r2-audit-'));
  const storePath = path.join(tmpDir, 'shared-store.json');
  const limitsEnv = { R2_MAX_MANAGED_BYTES: '2000', R2_CLASS_A_MONTHLY_LIMIT: '10', R2_CLASS_B_MONTHLY_LIMIT: '10' };

  try {
    // Process A reserves & commits 1200 bytes
    const procA = createMemoryRepositories({ persistPath: storePath });
    const resA = await reserveR2Operation('PutObject', { bytes: 1200, idempotencyKey: 'upload-A', env: limitsEnv, repo: procA.r2Usage });
    await resA.commit();

    // Idempotent retry does not double-count
    const retryA = await reserveR2Operation('PutObject', { bytes: 1200, idempotencyKey: 'upload-A', env: limitsEnv, repo: procA.r2Usage });
    assert.equal(retryA.duplicate, true);

    // Simulated restart / independent Process B opens the same persistent store
    const procB = createMemoryRepositories({ persistPath: storePath });
    const snapB = await getR2QuotaSnapshot({ env: limitsEnv, repo: procB.r2Usage });
    assert.equal(snapB.managed_bytes, 1200, 'Monthly managed_bytes must survive restart');
    assert.equal(snapB.class_a_ops, 1, 'Monthly class_a_ops must survive restart');

    // Process B cannot reserve another 1000 bytes (1200 + 1000 > 2000)
    await assert.rejects(
      () => reserveR2Operation('PutObject', { bytes: 1000, env: limitsEnv, repo: procB.r2Usage }),
      (err) => err?.code === 'R2_STORAGE_QUOTA_LIMIT' && err?.status === 503,
    );

    // Process B CAN reserve 500 bytes; Process A then cannot reserve 500 more concurrently
    const resB = await reserveR2Operation('PutObject', { bytes: 500, env: limitsEnv, repo: procB.r2Usage });
    await assert.rejects(
      () => reserveR2Operation('PutObject', { bytes: 500, env: limitsEnv, repo: procA.r2Usage }),
      (err) => err?.code === 'R2_STORAGE_QUOTA_LIMIT' && err?.status === 503,
    );
    await resB.release({ billableRequestSent: false });
  } finally {
    rmSync(tmpDir, { recursive: true, force: true });
  }
});

test('Audit 2: Abandoned reservations expire safely and release reserved bytes', async () => {
  const repo = createMemoryRepositories({ persistPath: null });
  const env = { R2_MAX_MANAGED_BYTES: '1500' };

  // Reserve 1200 bytes with 1-second TTL and abandon (never commit/release)
  await reserveR2Operation('PutObject', { bytes: 1200, ttlSeconds: 1, env, repo: repo.r2Usage });
  await assert.rejects(
    () => reserveR2Operation('PutObject', { bytes: 1000, env, repo: repo.r2Usage }),
    (err) => err?.code === 'R2_STORAGE_QUOTA_LIMIT',
  );

  // Wait for expiration (>1s) and verify abandoned reservation is automatically recovered
  await new Promise((r) => setTimeout(r, 1100));
  const recovered = await reserveR2Operation('PutObject', { bytes: 1000, env, repo: repo.r2Usage });
  assert.ok(recovered.id);
  await recovered.release();
});

test('Audit 3: Standard storage class enforced, failed R2 upload does not commit bytes, and incomplete multipart abort works', async () => {
  const repo = createMemoryRepositories({ persistPath: null });
  let seenStorageClass = null;
  let seenAbortUploadId = null;
  let forceFail = false;

  const mockServer = http.createServer((req, res) => {
    if (req.method === 'PUT') {
      seenStorageClass = req.headers['x-amz-storage-class'] || null;
      if (forceFail) {
        res.writeHead(500);
        res.end('Internal Error');
        return;
      }
      res.writeHead(200);
      res.end();
      return;
    }
    if (req.method === 'DELETE' && req.url.includes('uploadId=')) {
      seenAbortUploadId = new URL(req.url, 'http://127.0.0.1').searchParams.get('uploadId');
      res.writeHead(204);
      res.end();
      return;
    }
    res.writeHead(200);
    res.end();
  });

  await new Promise((r) => mockServer.listen(0, '127.0.0.1', r));
  const { port } = mockServer.address();
  const r2Env = {
    R2_ENDPOINT: `http://127.0.0.1:${port}`,
    R2_ACCESS_KEY_ID: 'k',
    R2_SECRET_ACCESS_KEY: 's',
    R2_BUCKET: 'b',
  };

  try {
    // Successful upload enforces x-amz-storage-class: STANDARD
    const okRes = await putR2Object('users/u1/documents/d1/original.pdf', Buffer.from('hello'), {
      env: r2Env,
      quotaRepo: repo.r2Usage,
    });
    assert.equal(okRes.storageClass, 'STANDARD');
    assert.equal(seenStorageClass, 'STANDARD');

    // Failed R2 upload must NOT add managed_bytes
    forceFail = true;
    await assert.rejects(
      () => putR2Object('users/u1/documents/d2/original.pdf', Buffer.from('0123456789'), { env: r2Env, quotaRepo: repo.r2Usage }),
      (err) => err?.code === 'R2_UPLOAD_FAILED' && err?.status === 503,
    );
    const snap = await getR2QuotaSnapshot({ env: r2Env, repo: repo.r2Usage });
    assert.equal(snap.managed_bytes, 5, 'Failed upload must not commit storage bytes');

    // Incomplete multipart upload abort is registered as free op and sends DELETE?uploadId=...
    const aborted = await abortR2MultipartUpload('users/u1/documents/d2/original.pdf', 'mp-upload-99', {
      env: r2Env,
      quotaRepo: repo.r2Usage,
    });
    assert.equal(aborted.ok, true);
    assert.equal(seenAbortUploadId, 'mp-upload-99');
  } finally {
    await new Promise((r) => mockServer.close(r));
  }
});

test('Audit 4: Strict quota mode blocks reusable signed URLs, analytics reconciliation detects discrepancies & halts, and quota DB failure fails closed', async () => {
  // Signed URL blocked in strict mode
  assert.throws(
    () => generateR2SignedDownloadUrl('users/u1/documents/d1/original.pdf', {
      env: { STRICT_R2_QUOTA_MODE: 'true', R2_ACCOUNT_ID: 'a', R2_ACCESS_KEY_ID: 'k', R2_SECRET_ACCESS_KEY: 's', R2_BUCKET: 'b' },
    }),
    (err) => err?.code === 'SIGNED_URL_DISABLED_IN_STRICT_QUOTA_MODE' && err?.status === 403,
  );

  // Quota service failure fails closed (503 QUOTA_SERVICE_UNAVAILABLE)
  const brokenRepo = {
    async reserve() { throw new Error('DB connection lost'); },
  };
  await assert.rejects(
    () => reserveR2Operation('PutObject', { bytes: 100, repo: brokenRepo }),
    (err) => err?.code === 'QUOTA_SERVICE_UNAVAILABLE' && err?.status === 503,
  );

  // R2 GraphQL Analytics reconciliation detects external discrepancy and halts at threshold
  const repo = createMemoryRepositories({ persistPath: null });
  const env = { R2_MAX_MANAGED_BYTES: '1000000', R2_CLASS_A_MONTHLY_LIMIT: '1000', R2_CLASS_B_MONTHLY_LIMIT: '5000' };
  const mockGraphqlFetch = async () => ({
    ok: true,
    async json() {
      return {
        data: {
          viewer: {
            accounts: [{
              r2OperationsAdaptiveGroups: [
                { dimensions: { actionType: 'PutObject' }, sum: { requests: 1200 } },
                { dimensions: { actionType: 'GetObject' }, sum: { requests: 300 } },
              ],
              r2StorageAdaptiveGroups: [{
                max: { payloadSize: 500000, metadataSize: 1000, objectCount: 12, uploadCount: 1 },
              }],
            }],
          },
        },
      };
    },
  });

  const rec = await reconcileR2UsageWithAnalytics({
    accountId: 'acc',
    apiToken: 'tok',
    bucket: 'runut-private-docs',
    env,
    fetchImpl: mockGraphqlFetch,
    repo: repo.r2Usage,
  });
  assert.equal(rec.ok, true);
  assert.equal(rec.discrepancy_detected, true);
  assert.equal(rec.quota_halted, true);
  assert.equal(rec.pending_multipart_uploads, 1);

  // Subsequent write is halted by reconciliation
  await assert.rejects(
    () => reserveR2Operation('PutObject', { bytes: 10, env, repo: repo.r2Usage }),
    (err) => err?.code === 'R2_QUOTA_HALTED_BY_RECONCILIATION' && err?.status === 503,
  );

  // Verify Migration v7 exists and explicit registry covers core operations
  assert.ok(MIGRATIONS.some((m) => m.version === 7 && m.name === 'r2_persistent_usage_quota_accounting'));
  assert.equal(R2_OPERATION_REGISTRY.PutObject, 'class_a');
  assert.equal(R2_OPERATION_REGISTRY.GetObject, 'class_b');
  assert.equal(R2_OPERATION_REGISTRY.DeleteObject, 'free');
});

test('Audit 5: Oracle Always Free config stays within 2 OCPUs / 12 GB RAM and docs report accurate Neon Free limits', () => {
  const ociCompose = readFileSync(path.join(ROOT, 'deploy/oracle-always-free/docker-compose.oci.yml'), 'utf8');
  assert.match(ociCompose, /2 OCPUs total, 12 GB memory total/);
  assert.match(ociCompose, /cpus:\s*1\.5/);
  assert.match(ociCompose, /mem_limit:\s*9g/);
  assert.match(ociCompose, /STRICT_R2_QUOTA_MODE:\s*"true"/);
  assert.doesNotMatch(ociCompose, /4 OCPU|24 GB/i);

  const finalReport = readFileSync(path.join(ROOT, 'docs/FINAL_ZERO_COST_DEPLOYMENT_REPORT.md'), 'utf8');
  assert.match(finalReport, /1 GB storage per project/i);
  assert.match(finalReport, /100 CU-hours/i);
  assert.match(finalReport, /20 GB combined/i);
  assert.match(finalReport, /application-side safety limit/i);
  assert.doesNotMatch(finalReport, /0\.5 GB/i);
  assert.doesNotMatch(finalReport, /4 ARM64 OCPU|24 GB RAM/i);
});
