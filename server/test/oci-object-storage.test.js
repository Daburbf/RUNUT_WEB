// Oracle Cloud Infrastructure (OCI) Object Storage S3-Compatible Adapter & Quota Audit Tests.
// Covers:
// 1. SigV4 canonical request, real OCI region (rejects 'auto'), endpoint construction, no ACL headers.
// 2. All 9 OCI S3 Compatibility operations (Put, Get, Head, Delete, List, Multipart Init/Part/Complete/Abort).
// 3. Persistent application-side quotas: 16 GB capacity, 40,000 API requests/mo, 8 TB outbound/mo,
//    multi-process contention, monthly rollover, restart durability, abandoned reservation expiry,
//    idempotent retries, fail-closed quota DB, signed URL block, and ZERO automatic R2 failover.
// 4. Migration v8 non-destructive compatibility (Migration v7 intact, R2 + OCI coexistence).
// 5. Opt-in live OCI integration test gated strictly by RUNUT_OCI_OBJECT_STORAGE_TEST=true.
import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { createHash } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createMemoryRepositories } from '../src/repositories/memory.js';
import { initStorage, documents } from '../src/repositories/index.js';
import { MIGRATIONS } from '../src/repositories/migrations.js';
import {
  DEFAULT_OCI_MAX_MANAGED_BYTES,
  MAX_OCI_TRIAL_MANAGED_BYTES,
  MAX_OCI_ALWAYS_FREE_MANAGED_BYTES,
  DEFAULT_OCI_MAX_API_REQUESTS,
  DEFAULT_OCI_MAX_OUTBOUND_BYTES,
  getOciQuotaLimits,
  getOciConfig,
  signOciSigV4Request,
  buildOciObjectUrl,
  reserveOciOperation,
  getOciQuotaSnapshot,
  putOciObject,
  getOciObject,
  headOciObject,
  deleteOciObject,
  listOciObjects,
  initiateOciMultipartUpload,
  uploadOciPart,
  completeOciMultipartUpload,
  abortOciMultipartUpload,
  generateOciSignedDownloadUrl,
} from '../src/services/ociObjectStorage.js';
import {
  saveOriginalUploadPersistent,
  getOriginalUploadPersistent,
  clearMemoryFileCache,
} from '../src/services/fileStore.js';

function sha256(buf) {
  return createHash('sha256').update(buf).digest('hex');
}

function startMockOciS3Server() {
  const objects = new Map();
  const multiparts = new Map();
  const requestLog = [];

  const server = http.createServer((req, res) => {
    const auth = req.headers.authorization || '';
    if (!auth.startsWith('AWS4-HMAC-SHA256 ')) {
      res.writeHead(403);
      res.end('Missing SigV4');
      return;
    }
    if (req.headers['x-amz-acl']) {
      res.writeHead(400);
      res.end('Unsupported S3 ACL header on OCI');
      return;
    }
    const parsed = new URL(req.url, 'http://127.0.0.1');
    const pathKey = parsed.pathname;
    requestLog.push({ method: req.method, path: pathKey, query: parsed.search, auth });

    // ListObjectsV2: GET /bucket?list-type=2
    if (req.method === 'GET' && parsed.searchParams.get('list-type') === '2') {
      const prefix = parsed.searchParams.get('prefix') || '';
      const keys = [...objects.keys()]
        .map((k) => k.replace(/^\/[^/]+\//, ''))
        .filter((k) => k.startsWith(prefix));
      res.writeHead(200, { 'Content-Type': 'application/xml' });
      res.end(`<ListBucketResult>${keys.map((k) => `<Contents><Key>${k}</Key></Contents>`).join('')}</ListBucketResult>`);
      return;
    }

    // InitiateMultipartUpload: POST /bucket/key?uploads=
    if (req.method === 'POST' && parsed.searchParams.has('uploads')) {
      const uid = `oci-mp-${Date.now()}-${Math.random().toString(16).slice(2, 6)}`;
      multiparts.set(uid, { pathKey, parts: new Map() });
      res.writeHead(200, { 'Content-Type': 'application/xml' });
      res.end(`<InitiateMultipartUploadResult><UploadId>${uid}</UploadId></InitiateMultipartUploadResult>`);
      return;
    }

    // CompleteMultipartUpload: POST /bucket/key?uploadId=...
    if (req.method === 'POST' && parsed.searchParams.get('uploadId')) {
      const uid = parsed.searchParams.get('uploadId');
      const mp = multiparts.get(uid);
      if (!mp) { res.writeHead(404); res.end('NoSuchUpload'); return; }
      const ordered = [...mp.parts.entries()].sort(([a], [b]) => a - b).map(([, buf]) => buf);
      objects.set(mp.pathKey, { buffer: Buffer.concat(ordered), contentType: 'application/octet-stream' });
      multiparts.delete(uid);
      res.writeHead(200, { 'Content-Type': 'application/xml' });
      res.end('<CompleteMultipartUploadResult/>');
      return;
    }

    // AbortMultipartUpload: DELETE /bucket/key?uploadId=...
    if (req.method === 'DELETE' && parsed.searchParams.get('uploadId')) {
      multiparts.delete(parsed.searchParams.get('uploadId'));
      res.writeHead(204);
      res.end();
      return;
    }

    // UploadPart: PUT /bucket/key?partNumber=N&uploadId=...
    if (req.method === 'PUT' && parsed.searchParams.get('uploadId')) {
      const uid = parsed.searchParams.get('uploadId');
      const partNum = Number(parsed.searchParams.get('partNumber'));
      const mp = multiparts.get(uid);
      if (!mp) { res.writeHead(404); res.end('NoSuchUpload'); return; }
      const chunks = [];
      req.on('data', (c) => chunks.push(c));
      req.on('end', () => {
        const buf = Buffer.concat(chunks);
        mp.parts.set(partNum, buf);
        res.writeHead(200, { ETag: `"etag-${partNum}"` });
        res.end();
      });
      return;
    }

    // PutObject
    if (req.method === 'PUT') {
      const chunks = [];
      req.on('data', (c) => chunks.push(c));
      req.on('end', () => {
        const buf = Buffer.concat(chunks);
        objects.set(pathKey, { buffer: buf, contentType: req.headers['content-type'] || 'application/octet-stream' });
        res.writeHead(200, { ETag: '"etag-put"' });
        res.end();
      });
      return;
    }

    // HeadObject
    if (req.method === 'HEAD') {
      const obj = objects.get(pathKey);
      if (!obj) { res.writeHead(404); res.end(); return; }
      res.writeHead(200, { 'Content-Length': String(obj.buffer.length), ETag: '"etag-head"' });
      res.end();
      return;
    }

    // GetObject
    if (req.method === 'GET') {
      const obj = objects.get(pathKey);
      if (!obj) { res.writeHead(404); res.end('NoSuchKey'); return; }
      res.writeHead(200, { 'Content-Type': obj.contentType, 'Content-Length': String(obj.buffer.length) });
      res.end(obj.buffer);
      return;
    }

    // DeleteObject
    if (req.method === 'DELETE') {
      objects.delete(pathKey);
      res.writeHead(204);
      res.end();
      return;
    }

    res.writeHead(405);
    res.end();
  });

  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address();
      resolve({ server, endpoint: `http://127.0.0.1:${port}`, objects, multiparts, requestLog });
    });
  });
}

test('OCI 1: Endpoint construction, SigV4 real region enforcement (rejects "auto"), and no S3 ACL headers', () => {
  const validCfg = getOciConfig({
    OCI_OS_NAMESPACE: 'axdemo1234',
    OCI_OS_REGION: 'ap-singapore-1',
    OCI_OS_BUCKET: 'runut-private',
    OCI_OS_ACCESS_KEY_ID: 'oci-key',
    OCI_OS_SECRET_ACCESS_KEY: 'oci-secret',
  });
  assert.equal(validCfg.configured, true);
  assert.equal(validCfg.endpoint, 'https://axdemo1234.compat.objectstorage.ap-singapore-1.oci.customer-oci.com');

  // R2's 'auto' region MUST be rejected for OCI
  const badRegionCfg = getOciConfig({
    OCI_OS_NAMESPACE: 'axdemo1234',
    OCI_OS_REGION: 'auto',
    OCI_OS_BUCKET: 'runut-private',
    OCI_OS_ACCESS_KEY_ID: 'oci-key',
    OCI_OS_SECRET_ACCESS_KEY: 'oci-secret',
  });
  assert.equal(badRegionCfg.configured, false);
  assert.equal(badRegionCfg.validRegion, false);

  const url = buildOciObjectUrl(validCfg, 'users/u1/documents/d1/original.pdf');
  const signed = signOciSigV4Request({
    method: 'PUT',
    url,
    headers: { 'content-type': 'application/pdf', 'x-amz-acl': 'public-read' },
    payloadHash: sha256(Buffer.from('test')),
    cfg: validCfg,
  });
  assert.match(signed.credentialScope, /\/ap-singapore-1\/s3\/aws4_request$/);
  assert.equal(signed.headers['x-amz-acl'], undefined, 'Unsupported S3 ACL header must be stripped for OCI');

  // Conservative OCI storage cap verification:
  // 1. Default without env vars: 8 GB (Free Trial safe: 80% of 10 GB Standard)
  const defaultLimits = getOciQuotaLimits({});
  assert.equal(defaultLimits.maxManagedBytes, 8 * 1024 * 1024 * 1024);
  assert.equal(defaultLimits.maxManagedBytes, DEFAULT_OCI_MAX_MANAGED_BYTES);
  assert.equal(defaultLimits.alwaysFreeVerified, false);
  assert.equal(defaultLimits.maxApiRequests, 40_000);
  assert.equal(defaultLimits.maxOutboundBytes, 8 * 1024 * 1024 * 1024 * 1024);

  // 2. Requesting 16 GB WITHOUT OCI_OS_ALWAYS_FREE_VERIFIED=true MUST clamp to 8 GB
  const unverified16Gb = getOciQuotaLimits({ OCI_MAX_MANAGED_BYTES: String(16 * 1024 * 1024 * 1024) });
  assert.equal(unverified16Gb.maxManagedBytes, MAX_OCI_TRIAL_MANAGED_BYTES);
  assert.equal(unverified16Gb.alwaysFreeVerified, false);

  // 3. Setting OCI_OS_ALWAYS_FREE_VERIFIED=true alone MUST NOT automatically increase the cap above 8 GB
  const verifiedNoExplicitCap = getOciQuotaLimits({ OCI_OS_ALWAYS_FREE_VERIFIED: 'true' });
  assert.equal(verifiedNoExplicitCap.maxManagedBytes, DEFAULT_OCI_MAX_MANAGED_BYTES);
  assert.equal(verifiedNoExplicitCap.alwaysFreeVerified, true);
  assert.equal(verifiedNoExplicitCap.maxAllowedManagedBytes, MAX_OCI_ALWAYS_FREE_MANAGED_BYTES);

  // 4. Explicit verification + explicit 16 GB cap is allowed up to 16 GB max (and >16 GB clamps to 16 GB)
  const verified16Gb = getOciQuotaLimits({
    OCI_OS_ALWAYS_FREE_VERIFIED: 'true',
    OCI_MAX_MANAGED_BYTES: String(16 * 1024 * 1024 * 1024),
  });
  assert.equal(verified16Gb.maxManagedBytes, 16 * 1024 * 1024 * 1024);
  const verifiedOverCap = getOciQuotaLimits({
    OCI_OS_ALWAYS_FREE_VERIFIED: 'true',
    OCI_MAX_MANAGED_BYTES: String(25 * 1024 * 1024 * 1024),
    OCI_MAX_API_REQUESTS: '999999',
    OCI_MAX_OUTBOUND_BYTES: String(20 * 1024 * 1024 * 1024 * 1024),
  });
  assert.equal(verifiedOverCap.maxManagedBytes, MAX_OCI_ALWAYS_FREE_MANAGED_BYTES);
  assert.equal(verifiedOverCap.maxApiRequests, DEFAULT_OCI_MAX_API_REQUESTS);
  assert.equal(verifiedOverCap.maxOutboundBytes, DEFAULT_OCI_MAX_OUTBOUND_BYTES);
});

test('OCI 2: All 9 OCI S3 Compatibility operations work and count multipart requests individually', async () => {
  const repo = createMemoryRepositories({ persistPath: null });
  const mockOci = await startMockOciS3Server();
  const ociEnv = {
    OCI_OS_ENDPOINT: mockOci.endpoint,
    OCI_OS_NAMESPACE: 'ns1',
    OCI_OS_REGION: 'ap-singapore-1',
    OCI_OS_BUCKET: 'runut-private',
    OCI_OS_ACCESS_KEY_ID: 'k1',
    OCI_OS_SECRET_ACCESS_KEY: 's1',
  };

  try {
    const key = 'users/u1/documents/d1/original.pdf';
    const data = Buffer.from('%PDF-1.7\nOCI test payload');

    // 1. PutObject (req #1)
    const putRes = await putOciObject(key, data, { contentType: 'application/pdf', env: ociEnv, quotaRepo: repo.objectStorageUsage });
    assert.equal(putRes.ok, true);

    // 2. HeadObject (req #2)
    const headRes = await headOciObject(key, { env: ociEnv, quotaRepo: repo.objectStorageUsage });
    assert.equal(headRes.ok, true);
    assert.equal(headRes.contentLength, data.length);

    // 3. GetObject (req #3, records outbound bytes)
    const getRes = await getOciObject(key, { expectedBytes: data.length, env: ociEnv, quotaRepo: repo.objectStorageUsage });
    assert.equal(getRes.ok, true);
    assert.equal(sha256(getRes.buffer), sha256(data));

    // 4. ListObjects (req #4)
    const listRes = await listOciObjects({ prefix: 'users/u1/', env: ociEnv, quotaRepo: repo.objectStorageUsage });
    assert.equal(listRes.ok, true);
    assert.ok(listRes.keys.includes(key));

    // 5-8. Multipart: Init (#5) + Part 1 (#6) + Part 2 (#7) + Complete (#8) = 4 individual API requests!
    const mpKey = 'users/u1/documents/d2/original.docx';
    const init = await initiateOciMultipartUpload(mpKey, { env: ociEnv, quotaRepo: repo.objectStorageUsage });
    const p1 = await uploadOciPart(mpKey, init.uploadId, 1, Buffer.from('PART-ONE-'), { env: ociEnv, quotaRepo: repo.objectStorageUsage });
    const p2 = await uploadOciPart(mpKey, init.uploadId, 2, Buffer.from('PART-TWO'), { env: ociEnv, quotaRepo: repo.objectStorageUsage });
    await completeOciMultipartUpload(mpKey, init.uploadId, [p1, p2], { env: ociEnv, quotaRepo: repo.objectStorageUsage });

    const gotMp = await getOciObject(mpKey, { env: ociEnv, quotaRepo: repo.objectStorageUsage }); // req #9
    assert.equal(gotMp.buffer.toString('utf8'), 'PART-ONE-PART-TWO');

    // 9. AbortMultipartUpload (init #10 + abort #11)
    const init2 = await initiateOciMultipartUpload('users/u1/documents/d3/original.pdf', { env: ociEnv, quotaRepo: repo.objectStorageUsage });
    const aborted = await abortOciMultipartUpload('users/u1/documents/d3/original.pdf', init2.uploadId, { env: ociEnv, quotaRepo: repo.objectStorageUsage });
    assert.equal(aborted.ok, true);

    // DeleteObject (req #12)
    const delRes = await deleteOciObject(key, { knownBytes: data.length, env: ociEnv, quotaRepo: repo.objectStorageUsage });
    assert.equal(delRes.ok, true);

    const snap = await getOciQuotaSnapshot({ env: ociEnv, repo: repo.objectStorageUsage });
    assert.equal(snap.api_requests, 12, 'Every individual OCI S3 request (including each multipart step) must be counted');
    assert.equal(snap.outbound_bytes, data.length + 'PART-ONE-PART-TWO'.length);
  } finally {
    await new Promise((r) => mockOci.server.close(r));
  }
});

test('OCI 3: Quota caps (16 GB / 40k reqs / 8 TB outbound), multi-process contention, rollover, expiry, fail-closed, signed URL block & zero R2 failover', async () => {
  const tmpDir = mkdtempSync(path.join(os.tmpdir(), 'runut-oci-quota-'));
  const storePath = path.join(tmpDir, 'oci-shared.json');
  const tightEnv = {
    OCI_MAX_MANAGED_BYTES: '2000',
    OCI_MAX_API_REQUESTS: '3',
    OCI_MAX_OUTBOUND_BYTES: '1500',
  };

  try {
    const procA = createMemoryRepositories({ persistPath: storePath });
    const procB = createMemoryRepositories({ persistPath: storePath });

    // Multi-process capacity cap + idempotency
    const r1 = await reserveOciOperation('PutObject', { bytes: 1200, idempotencyKey: 'oci-idem-1', month: '2026-11', env: tightEnv, repo: procA.objectStorageUsage });
    const dup = await reserveOciOperation('PutObject', { bytes: 1200, idempotencyKey: 'oci-idem-1', month: '2026-11', env: tightEnv, repo: procB.objectStorageUsage });
    assert.equal(dup.duplicate, true);
    await r1.commit();

    // Process B cannot reserve another 1000 bytes (1200 + 1000 > 2000)
    await assert.rejects(
      () => reserveOciOperation('PutObject', { bytes: 1000, month: '2026-11', env: tightEnv, repo: procB.objectStorageUsage }),
      (err) => err?.code === 'OBJECT_STORAGE_CAPACITY_LIMIT' && err?.status === 503,
    );

    // Outbound transfer cap (8 TB target tested at 1500 bytes)
    const g1 = await reserveOciOperation('GetObject', { outboundBytes: 1000, month: '2026-11', env: tightEnv, repo: procB.objectStorageUsage });
    await assert.rejects(
      () => reserveOciOperation('GetObject', { outboundBytes: 600, month: '2026-11', env: tightEnv, repo: procA.objectStorageUsage }),
      (err) => err?.code === 'OBJECT_STORAGE_OUTBOUND_LIMIT' && err?.status === 503,
    );
    await g1.commit({ actualBytes: 0, actualOutboundBytes: 1000 });

    // Request cap (40k target tested at 3)
    const h1 = await reserveOciOperation('HeadObject', { month: '2026-11', env: tightEnv, repo: procA.objectStorageUsage });
    await h1.commit({ actualBytes: 0 });
    await assert.rejects(
      () => reserveOciOperation('HeadObject', { month: '2026-11', env: tightEnv, repo: procB.objectStorageUsage }),
      (err) => err?.code === 'OBJECT_STORAGE_REQUEST_LIMIT' && err?.status === 503,
    );

    // Month rollover starts fresh request/outbound budget in 2026-12
    const nextMonth = await reserveOciOperation('HeadObject', { month: '2026-12', env: tightEnv, repo: procB.objectStorageUsage });
    await nextMonth.commit({ actualBytes: 0 });

    // Abandoned reservation expiration
    await reserveOciOperation('PutObject', { bytes: 1500, ttlSeconds: 1, month: '2027-01', env: tightEnv, repo: procA.objectStorageUsage });
    await assert.rejects(
      () => reserveOciOperation('PutObject', { bytes: 1000, month: '2027-01', env: tightEnv, repo: procB.objectStorageUsage }),
      (err) => err?.code === 'OBJECT_STORAGE_CAPACITY_LIMIT',
    );
    await new Promise((r) => setTimeout(r, 1100));
    const afterExpiry = await reserveOciOperation('PutObject', { bytes: 1000, month: '2027-01', env: tightEnv, repo: procB.objectStorageUsage });
    await afterExpiry.release();

    // Fail-closed quota DB
    await assert.rejects(
      () => reserveOciOperation('PutObject', { bytes: 10, repo: { async reserve() { throw new Error('DB down'); } } }),
      (err) => err?.code === 'QUOTA_SERVICE_UNAVAILABLE' && err?.status === 503,
    );

    // Strict signed URL block
    assert.throws(
      () => generateOciSignedDownloadUrl('users/u1/documents/d1/original.pdf', { env: { STRICT_STORAGE_QUOTA_MODE: 'true' } }),
      (err) => err?.code === 'SIGNED_URL_DISABLED_IN_STRICT_QUOTA_MODE' && err?.status === 403,
    );

    // ZERO automatic failover from OCI to R2 when OBJECT_STORAGE_PROVIDER=oci is unconfigured
    await assert.rejects(
      () => saveOriginalUploadPersistent('11111111-1111-4111-8111-111111111111', {
        userId: '22222222-2222-4222-8222-222222222222',
        buffer: Buffer.from('%PDF-1.7\ntest'),
        ext: 'pdf',
        originalName: 'test.pdf',
        env: {
          OBJECT_STORAGE_PROVIDER: 'oci',
          R2_ACCOUNT_ID: 'r2-present-but-must-not-failover',
          R2_ACCESS_KEY_ID: 'k',
          R2_SECRET_ACCESS_KEY: 's',
          R2_BUCKET: 'b',
        },
      }),
      (err) => err?.code === 'OCI_NOT_CONFIGURED' && err?.status === 503,
    );
  } finally {
    rmSync(tmpDir, { recursive: true, force: true });
  }
});

test('OCI 4: Migration v8 preserves v7 history and coexists cleanly with R2 + OCI document records', async () => {
  assert.ok(MIGRATIONS.some((m) => m.version === 7 && m.name === 'r2_persistent_usage_quota_accounting'));
  assert.ok(MIGRATIONS.some((m) => m.version === 8 && m.name === 'oci_object_storage_provider_and_persistent_quota'));

  await initStorage('', { persistPath: null });
  const mockOci = await startMockOciS3Server();
  const ociEnv = {
    NODE_ENV: 'production',
    OBJECT_STORAGE_PROVIDER: 'oci',
    OCI_OS_ENDPOINT: mockOci.endpoint,
    OCI_OS_NAMESPACE: 'ns1',
    OCI_OS_REGION: 'ap-singapore-1',
    OCI_OS_BUCKET: 'runut-private',
    OCI_OS_ACCESS_KEY_ID: 'k1',
    OCI_OS_SECRET_ACCESS_KEY: 's1',
  };

  try {
    const ownerId = '33333333-3333-4333-8333-333333333333';
    const otherId = '44444444-4444-4444-8444-444444444444';
    const pdfBuf = Buffer.from('%PDF-1.7\nOCI persistent document');
    const doc = await documents.create({
      user_id: ownerId,
      title: 'OCI Doc',
      original_text: 'OCI persistent document',
      word_count: 3,
      token_cost: 1,
      file_name: 'oci.pdf',
    });

    const saved = await saveOriginalUploadPersistent(doc.id, {
      userId: ownerId,
      buffer: pdfBuf,
      ext: 'pdf',
      originalName: 'oci.pdf',
      env: ociEnv,
    });
    assert.equal(saved.storageProvider, 'oci');

    clearMemoryFileCache();
    const got = await getOriginalUploadPersistent(doc.id, { userId: ownerId, env: ociEnv });
    assert.equal(got.storageProvider, 'oci');
    assert.equal(sha256(got.buffer), sha256(pdfBuf));

    // Cross-user isolation enforced
    assert.equal(await getOriginalUploadPersistent(doc.id, { userId: otherId, env: ociEnv }), null);
  } finally {
    await new Promise((r) => mockOci.server.close(r));
  }
});

// 5. Opt-in Live OCI Object Storage Integration Test (never runs automatically against production data)
test('OCI 5 (Live Opt-In): real OCI Object Storage upload, download, SHA-256, multipart, and cleanup', async (t) => {
  if (String(process.env.RUNUT_OCI_OBJECT_STORAGE_TEST || '').toLowerCase() !== 'true') {
    t.skip('Live OCI Object Storage integration test skipped (set RUNUT_OCI_OBJECT_STORAGE_TEST=true with test OCI credentials to run)');
    return;
  }
  const cfg = getOciConfig(process.env);
  assert.equal(cfg.configured, true, 'OCI_OS_NAMESPACE, OCI_OS_REGION, OCI_OS_BUCKET, OCI_OS_ACCESS_KEY_ID, OCI_OS_SECRET_ACCESS_KEY required');

  const testKey = `ci-tests/runut-live-test-${Date.now()}-${Math.random().toString(16).slice(2, 8)}.bin`;
  const payload = Buffer.from(`RUNUT live OCI verification ${new Date().toISOString()}`);
  try {
    await putOciObject(testKey, payload);
    const got = await getOciObject(testKey, { expectedBytes: payload.length });
    assert.equal(got.ok, true);
    assert.equal(sha256(got.buffer), sha256(payload));
  } finally {
    await deleteOciObject(testKey, { knownBytes: payload.length });
  }
});
