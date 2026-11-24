// Oracle Cloud Infrastructure (OCI) Object Storage S3-Compatible Adapter (Always Free Primary).
// Uses Node.js built-in node:crypto AWS SigV4 with real OCI region (NEVER R2's 'auto' region).
// Endpoint format: https://<namespace>.compat.objectstorage.<region>.oci.customer-oci.com
//
// Persistent application-side safety limits (conservative; NOT provider-side billing caps):
//   - Stored objects : 8 GB default (80% of 10 GB Standard during OCI Free Trial);
//                      up to 16 GB max ONLY after explicit operator verification
//                      (OCI_OS_ALWAYS_FREE_VERIFIED=true + explicit OCI_MAX_MANAGED_BYTES,
//                       80% of 20 GB combined in an Always Free-only account).
//                      Never assumes trial completion and never increases automatically.
//   - API requests   : 40,000/mo   (Always Free: 50,000/month)
//   - Outbound bytes : 8 TB/mo     (Always Free: 10 TB/month)
//
// Enforces private bucket access (no unsupported S3 ACL headers), strict quota mode
// (no reusable direct signed download URLs), and zero automatic failover to R2.
import { createHash, createHmac } from 'node:crypto';
import { HttpError } from '../middleware/errors.js';
import { objectStorageUsage as defaultUsageRepo } from '../repositories/index.js';

export const DEFAULT_OCI_MAX_MANAGED_BYTES = 8 * 1024 * 1024 * 1024; // 8 GB default (Free Trial safe)
export const MAX_OCI_TRIAL_MANAGED_BYTES = 8 * 1024 * 1024 * 1024; // 8 GB ceiling unless Always Free-only verified
export const MAX_OCI_ALWAYS_FREE_MANAGED_BYTES = 16 * 1024 * 1024 * 1024; // 16 GB ceiling after explicit Always Free-only verification
export const DEFAULT_OCI_MAX_API_REQUESTS = 40_000; // 40,000/mo
export const DEFAULT_OCI_MAX_OUTBOUND_BYTES = 8 * 1024 * 1024 * 1024 * 1024; // 8 TB/mo

export const OCI_SUPPORTED_OPERATIONS = new Set([
  'PutObject',
  'GetObject',
  'HeadObject',
  'DeleteObject',
  'ListObjects',
  'InitiateMultipartUpload',
  'UploadPart',
  'CompleteMultipartUpload',
  'AbortMultipartUpload',
]);

function sha256Hex(data) {
  return createHash('sha256').update(data).digest('hex');
}

function hmacSha256(key, data) {
  return createHmac('sha256', key).update(data).digest();
}

function encodeRfc3986(str) {
  return encodeURIComponent(str).replace(/[!'()*]/g, (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`);
}

function encodePath(objectKey) {
  return String(objectKey || '')
    .split('/')
    .filter(Boolean)
    .map(encodeRfc3986)
    .join('/');
}

function formatAmzDate(date = new Date()) {
  const iso = date.toISOString().replace(/[:-]|\.\d{3}/g, '');
  return { amzDate: iso, dateStamp: iso.slice(0, 8) };
}

function currentUtcMonth(now = new Date()) {
  return now.toISOString().slice(0, 7);
}

export function getOciQuotaLimits(env = process.env) {
  // Never assume the OCI account has completed its Free Trial and never increase the cap automatically.
  // Default cap is always 8 GB. Only when the operator explicitly sets BOTH
  // OCI_OS_ALWAYS_FREE_VERIFIED=true AND an explicit OCI_MAX_MANAGED_BYTES value can the cap
  // be raised, up to a hard application-side ceiling of 16 GB.
  const alwaysFreeVerified = String(env.OCI_OS_ALWAYS_FREE_VERIFIED || '').trim().toLowerCase() === 'true';
  const maxAllowedManagedBytes = alwaysFreeVerified
    ? MAX_OCI_ALWAYS_FREE_MANAGED_BYTES
    : MAX_OCI_TRIAL_MANAGED_BYTES;
  const rawManagedBytes = Number(env.OCI_MAX_MANAGED_BYTES);
  const requestedManagedBytes = Number.isFinite(rawManagedBytes) && rawManagedBytes > 0
    ? rawManagedBytes
    : DEFAULT_OCI_MAX_MANAGED_BYTES;
  const maxManagedBytes = Math.min(maxAllowedManagedBytes, Math.max(1024, requestedManagedBytes));

  const rawApiRequests = Number(env.OCI_MAX_API_REQUESTS);
  const requestedApiRequests = Number.isFinite(rawApiRequests) && rawApiRequests > 0
    ? rawApiRequests
    : DEFAULT_OCI_MAX_API_REQUESTS;
  const maxApiRequests = Math.min(DEFAULT_OCI_MAX_API_REQUESTS, Math.max(1, requestedApiRequests));

  const rawOutboundBytes = Number(env.OCI_MAX_OUTBOUND_BYTES);
  const requestedOutboundBytes = Number.isFinite(rawOutboundBytes) && rawOutboundBytes > 0
    ? rawOutboundBytes
    : DEFAULT_OCI_MAX_OUTBOUND_BYTES;
  const maxOutboundBytes = Math.min(DEFAULT_OCI_MAX_OUTBOUND_BYTES, Math.max(1024, requestedOutboundBytes));

  return {
    maxManagedBytes,
    maxAllowedManagedBytes,
    alwaysFreeVerified,
    maxApiRequests,
    maxOutboundBytes,
  };
}

export function getOciConfig(env = process.env) {
  const namespace = String(env.OCI_OS_NAMESPACE || '').trim();
  const region = String(env.OCI_OS_REGION || '').trim();
  const bucket = String(env.OCI_OS_BUCKET || '').trim();
  const accessKeyId = String(env.OCI_OS_ACCESS_KEY_ID || '').trim();
  const secretAccessKey = String(env.OCI_OS_SECRET_ACCESS_KEY || '').trim();
  const rawEndpoint = String(env.OCI_OS_ENDPOINT || '').trim().replace(/\/+$/, '');
  const endpoint = rawEndpoint || (namespace && region
    ? `https://${namespace}.compat.objectstorage.${region}.oci.customer-oci.com`
    : '');
  // OCI SigV4 requires a real OCI region identifier (e.g. ap-singapore-1), NEVER R2's 'auto'
  const validRegion = Boolean(region && region.toLowerCase() !== 'auto');
  const configured = Boolean(endpoint && validRegion && bucket && accessKeyId && secretAccessKey);
  return { namespace, region, bucket, accessKeyId, secretAccessKey, endpoint, validRegion, configured };
}

export function isOciConfigured(env = process.env) {
  return getOciConfig(env).configured;
}

export function isStrictOciQuotaMode(env = process.env) {
  return String(env.STRICT_STORAGE_QUOTA_MODE ?? env.STRICT_R2_QUOTA_MODE ?? 'true').trim().toLowerCase() !== 'false';
}

export function buildOciObjectUrl(cfg, objectKey = '', queryEntries = []) {
  const basePath = objectKey
    ? `/${encodeRfc3986(cfg.bucket)}/${encodePath(objectKey)}`
    : `/${encodeRfc3986(cfg.bucket)}`;
  const url = new URL(`${cfg.endpoint}${basePath}`);
  for (const [k, v] of queryEntries) {
    url.searchParams.set(k, v);
  }
  return url;
}

export function buildCanonicalQueryString(url) {
  const entries = [];
  for (const [k, v] of url.searchParams.entries()) {
    entries.push([encodeRfc3986(k), encodeRfc3986(v)]);
  }
  entries.sort(([a1, b1], [a2, b2]) => (a1 === a2 ? b1.localeCompare(b2) : a1.localeCompare(a2)));
  return entries.map(([k, v]) => `${k}=${v}`).join('&');
}

export function signOciSigV4Request({ method, url, headers = {}, payloadHash, cfg, now = new Date() }) {
  if (!cfg.validRegion) {
    throw new HttpError(500, 'OCI_OS_REGION wajib menggunakan region OCI yang valid (bukan "auto").', {
      code: 'INVALID_OCI_REGION',
    });
  }
  const { amzDate, dateStamp } = formatAmzDate(now);
  const allHeaders = {
    host: url.host,
    'x-amz-content-sha256': payloadHash,
    'x-amz-date': amzDate,
    ...headers,
  };
  // Strip any unsupported S3 ACL headers (OCI Object Storage uses IAM policies, not S3 ACLs)
  for (const key of Object.keys(allHeaders)) {
    if (key.toLowerCase() === 'x-amz-acl') delete allHeaders[key];
  }

  const lowerEntries = Object.entries(allHeaders)
    .map(([k, v]) => [k.toLowerCase(), String(v).trim().replace(/\s+/g, ' ')])
    .sort(([a], [b]) => a.localeCompare(b));

  const canonicalHeaders = lowerEntries.map(([k, v]) => `${k}:${v}\n`).join('');
  const signedHeaders = lowerEntries.map(([k]) => k).join(';');
  const canonicalQuery = buildCanonicalQueryString(url);
  const canonicalRequest = [
    method.toUpperCase(),
    url.pathname,
    canonicalQuery,
    canonicalHeaders,
    signedHeaders,
    payloadHash,
  ].join('\n');

  const credentialScope = `${dateStamp}/${cfg.region}/s3/aws4_request`;
  const stringToSign = [
    'AWS4-HMAC-SHA256',
    amzDate,
    credentialScope,
    sha256Hex(canonicalRequest),
  ].join('\n');

  const kDate = hmacSha256(`AWS4${cfg.secretAccessKey}`, dateStamp);
  const kRegion = hmacSha256(kDate, cfg.region);
  const kService = hmacSha256(kRegion, 's3');
  const signingKey = hmacSha256(kService, 'aws4_request');
  const signature = createHmac('sha256', signingKey).update(stringToSign).digest('hex');

  const outHeaders = Object.fromEntries(lowerEntries);
  outHeaders.authorization = `AWS4-HMAC-SHA256 Credential=${cfg.accessKeyId}/${credentialScope}, SignedHeaders=${signedHeaders}, Signature=${signature}`;
  delete outHeaders.host;
  return { headers: outHeaders, canonicalRequest, credentialScope, signature };
}

export async function reserveOciOperation(operation, {
  bytes = 0,
  requests = 1,
  outboundBytes = 0,
  idempotencyKey = null,
  ttlSeconds = 180,
  month = currentUtcMonth(),
  env = process.env,
  repo = defaultUsageRepo,
} = {}) {
  if (!OCI_SUPPORTED_OPERATIONS.has(operation)) {
    throw new HttpError(500, `Operasi OCI "${operation}" tidak terdaftar.`, { code: 'UNREGISTERED_OCI_OPERATION' });
  }
  const limits = getOciQuotaLimits(env);
  let res;
  try {
    res = await repo.reserve({
      provider: 'oci',
      month,
      operation,
      bytes,
      requests,
      outbound_bytes: outboundBytes,
      idempotency_key: idempotencyKey,
      ttl_seconds: ttlSeconds,
      limits,
    });
  } catch (err) {
    throw new HttpError(503, 'Layanan pencatatan kuota OCI Object Storage tidak tersedia. Operasi dihentikan demi batas aman gratis.', {
      code: 'QUOTA_SERVICE_UNAVAILABLE',
      reason: err?.message || 'quota_db_error',
    });
  }

  if (!res?.ok) {
    const code = res?.code || 'OBJECT_STORAGE_CAPACITY_LIMIT';
    const capGb = Math.round((limits.maxManagedBytes / (1024 * 1024 * 1024)) * 10) / 10;
    const msg = code === 'OBJECT_STORAGE_REQUEST_LIMIT'
      ? `Batas aman aplikasi permintaan API bulanan OCI Object Storage (${limits.maxApiRequests.toLocaleString('id-ID')}/bulan) telah tercapai.`
      : (code === 'OBJECT_STORAGE_OUTBOUND_LIMIT'
        ? 'Batas aman aplikasi transfer keluar bulanan OCI Object Storage (8 TB/bulan) telah tercapai.'
        : `Batas aman aplikasi kapasitas OCI Object Storage (${capGb} GB) telah tercapai; dokumen lama tetap aman.`);
    throw new HttpError(503, msg, { code });
  }

  const resvId = res.reservation?.id;
  let settled = Boolean(res.duplicate);
  return {
    id: resvId,
    duplicate: Boolean(res.duplicate),
    async commit({ actualBytes = null, actualOutboundBytes = null, objectDelta = null } = {}) {
      if (settled || !resvId) return;
      settled = true;
      await repo.commit(resvId, {
        actual_bytes: actualBytes,
        actual_outbound_bytes: actualOutboundBytes,
        object_delta: objectDelta,
      });
    },
    async release({ billableRequestSent = false } = {}) {
      if (settled || !resvId) return;
      settled = true;
      await repo.release(resvId, { billable_request_sent: billableRequestSent });
    },
  };
}

export async function getOciQuotaSnapshot({ month = currentUtcMonth(), env = process.env, repo = defaultUsageRepo } = {}) {
  const limits = getOciQuotaLimits(env);
  const snap = await repo.getSnapshot({ provider: 'oci', month });
  const capGb = Math.round((limits.maxManagedBytes / (1024 * 1024 * 1024)) * 10) / 10;
  return {
    ...snap,
    max_managed_bytes: limits.maxManagedBytes,
    max_allowed_managed_bytes: limits.maxAllowedManagedBytes,
    always_free_verified: limits.alwaysFreeVerified,
    max_api_requests: limits.maxApiRequests,
    max_outbound_bytes: limits.maxOutboundBytes,
    disclaimer: `Application-side safety limit (${capGb} GB storage [default 8 GB Free Trial safe, max 16 GB hanya setelah verifikasi Always Free-only] / 40.000 req / 8 TB outbound). Bukan provider-side hard billing cap.`,
  };
}

function assertConfigured(env) {
  const cfg = getOciConfig(env);
  if (!cfg.configured) {
    throw new HttpError(503, 'OCI Object Storage belum dikonfigurasi lengkap (OCI_OS_NAMESPACE, OCI_OS_REGION, OCI_OS_BUCKET, OCI_OS_ACCESS_KEY_ID, OCI_OS_SECRET_ACCESS_KEY).', {
      code: 'OCI_NOT_CONFIGURED',
    });
  }
  return cfg;
}

// 1. PutObject (supports net size delta when replacing an existing object via previousBytes)
export async function putOciObject(objectKey, buffer, {
  contentType = 'application/octet-stream',
  sha256 = null,
  previousBytes = 0,
  idempotencyKey = null,
  month = currentUtcMonth(),
  env = process.env,
  fetchImpl = fetch,
  timeoutMs = 30_000,
  quotaRepo = defaultUsageRepo,
} = {}) {
  const cfg = assertConfigured(env);
  const netReserveBytes = Math.max(0, buffer.length - Math.max(0, Number(previousBytes) || 0));
  const quota = await reserveOciOperation('PutObject', {
    bytes: netReserveBytes,
    requests: 1,
    idempotencyKey,
    month,
    env,
    repo: quotaRepo,
  });

  const payloadHash = sha256 || sha256Hex(buffer);
  const url = buildOciObjectUrl(cfg, objectKey);
  const { headers } = signOciSigV4Request({
    method: 'PUT',
    url,
    headers: {
      'content-type': contentType,
      'content-length': String(buffer.length),
    },
    payloadHash,
    cfg,
  });

  let res;
  try {
    res = await fetchImpl(url.toString(), {
      method: 'PUT',
      headers,
      body: buffer,
      redirect: 'error',
      signal: AbortSignal.timeout(timeoutMs),
    });
  } catch (err) {
    await quota.release({ billableRequestSent: false });
    throw new HttpError(503, 'Gagal menghubungi OCI Object Storage. Dokumen belum tersimpan.', {
      code: 'OCI_STORAGE_UNAVAILABLE',
      reason: err?.message || 'network_error',
    });
  }

  if (!res.ok) {
    await quota.release({ billableRequestSent: true });
    throw new HttpError(503, `OCI Object Storage menolak unggahan (HTTP ${res.status}).`, {
      code: 'OCI_UPLOAD_FAILED',
      upstream_status: res.status,
    });
  }

  const netDelta = buffer.length - Math.max(0, Number(previousBytes) || 0);
  await quota.commit({ actualBytes: netDelta, objectDelta: previousBytes > 0 ? 0 : 1 });
  return { ok: true, provider: 'oci', key: objectKey, sha256: payloadHash, size: buffer.length };
}

// 2. GetObject (reserves 1 API request + anticipated outbound bytes; commits actual streamed bytes)
export async function getOciObject(objectKey, {
  expectedBytes = 0,
  month = currentUtcMonth(),
  env = process.env,
  fetchImpl = fetch,
  timeoutMs = 30_000,
  quotaRepo = defaultUsageRepo,
} = {}) {
  const cfg = getOciConfig(env);
  if (!cfg.configured) return { ok: false, code: 'OCI_NOT_CONFIGURED', status: 503 };
  const quota = await reserveOciOperation('GetObject', {
    requests: 1,
    outboundBytes: Math.max(0, Number(expectedBytes) || 0),
    month,
    env,
    repo: quotaRepo,
  });

  const url = buildOciObjectUrl(cfg, objectKey);
  const { headers } = signOciSigV4Request({ method: 'GET', url, payloadHash: sha256Hex(''), cfg });

  let res;
  try {
    res = await fetchImpl(url.toString(), {
      method: 'GET',
      headers,
      redirect: 'error',
      signal: AbortSignal.timeout(timeoutMs),
    });
  } catch (err) {
    await quota.release({ billableRequestSent: false });
    return { ok: false, code: 'OCI_STORAGE_UNAVAILABLE', status: 503, reason: err?.message || 'network_error' };
  }

  if (res.status === 404) {
    await quota.release({ billableRequestSent: true });
    return { ok: false, code: 'OCI_OBJECT_MISSING', status: 404 };
  }
  if (!res.ok) {
    await quota.release({ billableRequestSent: true });
    return { ok: false, code: 'OCI_FETCH_FAILED', status: res.status };
  }
  const buffer = Buffer.from(await res.arrayBuffer());
  await quota.commit({ actualBytes: 0, actualOutboundBytes: buffer.length, objectDelta: 0 });
  return {
    ok: true,
    buffer,
    contentType: res.headers.get('content-type') || 'application/octet-stream',
  };
}

// 3. HeadObject
export async function headOciObject(objectKey, {
  month = currentUtcMonth(),
  env = process.env,
  fetchImpl = fetch,
  timeoutMs = 15_000,
  quotaRepo = defaultUsageRepo,
} = {}) {
  const cfg = getOciConfig(env);
  if (!cfg.configured) return { ok: false, code: 'OCI_NOT_CONFIGURED', status: 503 };
  const quota = await reserveOciOperation('HeadObject', { requests: 1, month, env, repo: quotaRepo });
  const url = buildOciObjectUrl(cfg, objectKey);
  const { headers } = signOciSigV4Request({ method: 'HEAD', url, payloadHash: sha256Hex(''), cfg });
  try {
    const res = await fetchImpl(url.toString(), { method: 'HEAD', headers, redirect: 'error', signal: AbortSignal.timeout(timeoutMs) });
    if (res.ok) {
      await quota.commit({ actualBytes: 0, objectDelta: 0 });
      return { ok: true, contentLength: Number(res.headers.get('content-length') || 0), etag: res.headers.get('etag') || null };
    }
    await quota.release({ billableRequestSent: true });
    return { ok: false, code: res.status === 404 ? 'OCI_OBJECT_MISSING' : 'OCI_HEAD_FAILED', status: res.status };
  } catch {
    await quota.release({ billableRequestSent: false });
    return { ok: false, code: 'OCI_STORAGE_UNAVAILABLE', status: 503 };
  }
}

// 4. DeleteObject
export async function deleteOciObject(objectKey, {
  knownBytes = 0,
  month = currentUtcMonth(),
  env = process.env,
  fetchImpl = fetch,
  timeoutMs = 15_000,
  quotaRepo = defaultUsageRepo,
} = {}) {
  const cfg = getOciConfig(env);
  if (!cfg.configured) return { ok: false, code: 'OCI_NOT_CONFIGURED' };
  const quota = await reserveOciOperation('DeleteObject', { requests: 1, month, env, repo: quotaRepo });
  const url = buildOciObjectUrl(cfg, objectKey);
  const { headers } = signOciSigV4Request({ method: 'DELETE', url, payloadHash: sha256Hex(''), cfg });
  try {
    const res = await fetchImpl(url.toString(), { method: 'DELETE', headers, redirect: 'error', signal: AbortSignal.timeout(timeoutMs) });
    await quota.commit({ actualBytes: 0, objectDelta: 0 });
    if ((res.ok || res.status === 404) && knownBytes > 0) {
      await quotaRepo.recordDelete({ provider: 'oci', month, bytes: knownBytes }).catch(() => {});
    }
    return { ok: res.ok || res.status === 404, status: res.status };
  } catch {
    await quota.release({ billableRequestSent: false });
    return { ok: false, code: 'OCI_DELETE_FAILED' };
  }
}

// 5. ListObjects
export async function listOciObjects({
  prefix = '',
  maxKeys = 100,
  month = currentUtcMonth(),
  env = process.env,
  fetchImpl = fetch,
  timeoutMs = 15_000,
  quotaRepo = defaultUsageRepo,
} = {}) {
  const cfg = assertConfigured(env);
  const quota = await reserveOciOperation('ListObjects', { requests: 1, month, env, repo: quotaRepo });
  const query = [['list-type', '2'], ['max-keys', String(Math.min(1000, Math.max(1, Number(maxKeys) || 100)))]];
  if (prefix) query.push(['prefix', prefix]);
  const url = buildOciObjectUrl(cfg, '', query);
  const { headers } = signOciSigV4Request({ method: 'GET', url, payloadHash: sha256Hex(''), cfg });
  try {
    const res = await fetchImpl(url.toString(), { method: 'GET', headers, redirect: 'error', signal: AbortSignal.timeout(timeoutMs) });
    if (!res.ok) {
      await quota.release({ billableRequestSent: true });
      return { ok: false, code: 'OCI_LIST_FAILED', status: res.status, keys: [] };
    }
    const xml = await res.text();
    await quota.commit({ actualBytes: 0, objectDelta: 0 });
    const keys = [...xml.matchAll(/<Key>([^<]+)<\/Key>/g)].map((m) => m[1]);
    return { ok: true, keys };
  } catch {
    await quota.release({ billableRequestSent: false });
    return { ok: false, code: 'OCI_STORAGE_UNAVAILABLE', status: 503, keys: [] };
  }
}

// 6. InitiateMultipartUpload (1 API request)
export async function initiateOciMultipartUpload(objectKey, {
  contentType = 'application/octet-stream',
  month = currentUtcMonth(),
  env = process.env,
  fetchImpl = fetch,
  timeoutMs = 15_000,
  quotaRepo = defaultUsageRepo,
} = {}) {
  const cfg = assertConfigured(env);
  const quota = await reserveOciOperation('InitiateMultipartUpload', { requests: 1, month, env, repo: quotaRepo });
  const url = buildOciObjectUrl(cfg, objectKey, [['uploads', '']]);
  const { headers } = signOciSigV4Request({ method: 'POST', url, headers: { 'content-type': contentType }, payloadHash: sha256Hex(''), cfg });
  try {
    const res = await fetchImpl(url.toString(), { method: 'POST', headers, redirect: 'error', signal: AbortSignal.timeout(timeoutMs) });
    if (!res.ok) {
      await quota.release({ billableRequestSent: true });
      throw new HttpError(503, `OCI gagal memulai multipart upload (HTTP ${res.status}).`, { code: 'OCI_MULTIPART_INIT_FAILED' });
    }
    const xml = await res.text();
    const match = xml.match(/<UploadId>([^<]+)<\/UploadId>/);
    if (!match) {
      await quota.release({ billableRequestSent: true });
      throw new HttpError(502, 'Respons OCI InitiateMultipartUpload tidak memuat UploadId.', { code: 'OCI_MULTIPART_BAD_XML' });
    }
    await quota.commit({ actualBytes: 0, objectDelta: 0 });
    return { ok: true, uploadId: match[1] };
  } catch (err) {
    if (err instanceof HttpError) throw err;
    await quota.release({ billableRequestSent: false });
    throw new HttpError(503, 'Gagal menghubungi OCI untuk memulai multipart upload.', { code: 'OCI_STORAGE_UNAVAILABLE' });
  }
}

// 7. UploadPart (reserves part bytes + 1 API request individually)
export async function uploadOciPart(objectKey, uploadId, partNumber, buffer, {
  month = currentUtcMonth(),
  env = process.env,
  fetchImpl = fetch,
  timeoutMs = 30_000,
  quotaRepo = defaultUsageRepo,
} = {}) {
  const cfg = assertConfigured(env);
  const quota = await reserveOciOperation('UploadPart', { bytes: buffer.length, requests: 1, month, env, repo: quotaRepo });
  const url = buildOciObjectUrl(cfg, objectKey, [['partNumber', String(partNumber)], ['uploadId', String(uploadId)]]);
  const payloadHash = sha256Hex(buffer);
  const { headers } = signOciSigV4Request({
    method: 'PUT',
    url,
    headers: { 'content-length': String(buffer.length) },
    payloadHash,
    cfg,
  });
  try {
    const res = await fetchImpl(url.toString(), { method: 'PUT', headers, body: buffer, redirect: 'error', signal: AbortSignal.timeout(timeoutMs) });
    if (!res.ok) {
      await quota.release({ billableRequestSent: true });
      throw new HttpError(503, `OCI gagal mengunggah part #${partNumber} (HTTP ${res.status}).`, { code: 'OCI_PART_UPLOAD_FAILED' });
    }
    const etag = res.headers.get('etag') || `"${payloadHash.slice(0, 32)}"`;
    await quota.commit({ actualBytes: buffer.length, objectDelta: 0 });
    return { ok: true, partNumber, etag, size: buffer.length };
  } catch (err) {
    if (err instanceof HttpError) throw err;
    await quota.release({ billableRequestSent: false });
    throw new HttpError(503, 'Gagal menghubungi OCI untuk UploadPart.', { code: 'OCI_STORAGE_UNAVAILABLE' });
  }
}

// 8. CompleteMultipartUpload (1 API request + increments object_count by 1)
export async function completeOciMultipartUpload(objectKey, uploadId, parts = [], {
  month = currentUtcMonth(),
  env = process.env,
  fetchImpl = fetch,
  timeoutMs = 30_000,
  quotaRepo = defaultUsageRepo,
} = {}) {
  const cfg = assertConfigured(env);
  const quota = await reserveOciOperation('CompleteMultipartUpload', { requests: 1, month, env, repo: quotaRepo });
  const xmlBody = `<CompleteMultipartUpload>${parts
    .sort((a, b) => a.partNumber - b.partNumber)
    .map((p) => `<Part><PartNumber>${p.partNumber}</PartNumber><ETag>${p.etag}</ETag></Part>`)
    .join('')}</CompleteMultipartUpload>`;
  const bodyBuf = Buffer.from(xmlBody, 'utf8');
  const url = buildOciObjectUrl(cfg, objectKey, [['uploadId', String(uploadId)]]);
  const { headers } = signOciSigV4Request({
    method: 'POST',
    url,
    headers: { 'content-type': 'application/xml', 'content-length': String(bodyBuf.length) },
    payloadHash: sha256Hex(bodyBuf),
    cfg,
  });
  try {
    const res = await fetchImpl(url.toString(), { method: 'POST', headers, body: bodyBuf, redirect: 'error', signal: AbortSignal.timeout(timeoutMs) });
    if (!res.ok) {
      await quota.release({ billableRequestSent: true });
      throw new HttpError(503, `OCI gagal menyelesaikan multipart upload (HTTP ${res.status}).`, { code: 'OCI_MULTIPART_COMPLETE_FAILED' });
    }
    await quota.commit({ actualBytes: 0, objectDelta: 1 });
    return { ok: true, key: objectKey };
  } catch (err) {
    if (err instanceof HttpError) throw err;
    await quota.release({ billableRequestSent: false });
    throw new HttpError(503, 'Gagal menghubungi OCI untuk CompleteMultipartUpload.', { code: 'OCI_STORAGE_UNAVAILABLE' });
  }
}

// 9. AbortMultipartUpload (1 API request)
export async function abortOciMultipartUpload(objectKey, uploadId, {
  month = currentUtcMonth(),
  env = process.env,
  fetchImpl = fetch,
  timeoutMs = 15_000,
  quotaRepo = defaultUsageRepo,
} = {}) {
  const cfg = getOciConfig(env);
  if (!cfg.configured || !uploadId) return { ok: false, code: 'OCI_NOT_CONFIGURED' };
  const quota = await reserveOciOperation('AbortMultipartUpload', { requests: 1, month, env, repo: quotaRepo });
  const url = buildOciObjectUrl(cfg, objectKey, [['uploadId', String(uploadId)]]);
  const { headers } = signOciSigV4Request({ method: 'DELETE', url, payloadHash: sha256Hex(''), cfg });
  try {
    const res = await fetchImpl(url.toString(), { method: 'DELETE', headers, redirect: 'error', signal: AbortSignal.timeout(timeoutMs) });
    await quota.commit({ actualBytes: 0, objectDelta: 0 });
    return { ok: res.ok || res.status === 404, status: res.status };
  } catch {
    await quota.release({ billableRequestSent: false });
    return { ok: false, code: 'OCI_ABORT_FAILED' };
  }
}

// Strict mode blocks reusable direct signed download URLs so every download is authenticated and metered through backend.
export function generateOciSignedDownloadUrl(_objectKey, { env = process.env } = {}) {
  if (isStrictOciQuotaMode(env)) {
    throw new HttpError(
      403,
      'Tautan unduhan langsung OCI (reusable signed URL) dinonaktifkan pada mode kuota ketat. Gunakan unduhan terautentikasi melalui backend.',
      { code: 'SIGNED_URL_DISABLED_IN_STRICT_QUOTA_MODE' },
    );
  }
  throw new HttpError(
    501,
    'Unduhan OCI harus dialirkan melalui backend terautentikasi untuk menjaga isolasi kepemilikan dan pencatatan kuota.',
    { code: 'BACKEND_STREAM_REQUIRED' },
  );
}
