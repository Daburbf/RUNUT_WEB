// Cloudflare R2 private persistent object storage client (S3-compatible AWS SigV4).
// Uses Node.js built-in node:crypto and fetch with zero extra npm dependencies.
// Every R2 request is routed through the persistent R2 quota registry (`r2Quota.js`).
// Enforces Standard storage class (`x-amz-storage-class: STANDARD`) — never Infrequent Access.
// In strict quota mode (default), direct reusable signed download URLs are DISABLED so
// every download is authenticated and metered through the backend.
import { createHash, createHmac } from 'node:crypto';
import { HttpError } from '../middleware/errors.js';
import { reserveR2Operation } from './r2Quota.js';

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
  return {
    amzDate: iso,
    dateStamp: iso.slice(0, 8),
  };
}

function getSigningKey(secretAccessKey, dateStamp, region = 'auto', service = 's3') {
  const kDate = hmacSha256(`AWS4${secretAccessKey}`, dateStamp);
  const kRegion = hmacSha256(kDate, region);
  const kService = hmacSha256(kRegion, service);
  return hmacSha256(kService, 'aws4_request');
}

export function getR2Config(env = process.env) {
  const accountId = String(env.R2_ACCOUNT_ID || '').trim();
  const accessKeyId = String(env.R2_ACCESS_KEY_ID || '').trim();
  const secretAccessKey = String(env.R2_SECRET_ACCESS_KEY || '').trim();
  const bucket = String(env.R2_BUCKET || '').trim();
  const rawEndpoint = String(env.R2_ENDPOINT || '').trim().replace(/\/+$/, '');
  const endpoint = rawEndpoint || (accountId ? `https://${accountId}.r2.cloudflarestorage.com` : '');
  const configured = Boolean(endpoint && accessKeyId && secretAccessKey && bucket);
  return { accountId, accessKeyId, secretAccessKey, bucket, endpoint, region: 'auto', configured };
}

export function isR2Configured(env = process.env) {
  return getR2Config(env).configured;
}

export function isStrictR2QuotaMode(env = process.env) {
  return String(env.STRICT_R2_QUOTA_MODE ?? 'true').trim().toLowerCase() !== 'false';
}

export function shouldUseR2Storage(env = process.env) {
  const mode = String(env.FILE_STORAGE_PROVIDER || 'auto').trim().toLowerCase();
  if (mode === 'r2') return true;
  if (mode === 'postgres' || mode === 'local') return false;
  return isR2Configured(env);
}

export function buildPrivateObjectKey(userId, docId, ext) {
  const safeUser = String(userId || '').replace(/[^a-zA-Z0-9_-]/g, '');
  const safeDoc = String(docId || '').replace(/[^a-zA-Z0-9_-]/g, '');
  const safeExt = String(ext || '').toLowerCase().replace(/[^a-z0-9]/g, '');
  if (!safeUser || !safeDoc || !safeExt) {
    throw new HttpError(400, 'Parameter kunci objek penyimpanan tidak valid.', { code: 'INVALID_STORAGE_KEY' });
  }
  return `users/${safeUser}/documents/${safeDoc}/original.${safeExt}`;
}

function buildObjectUrl(cfg, objectKey) {
  return new URL(`${cfg.endpoint}/${encodeRfc3986(cfg.bucket)}/${encodePath(objectKey)}`);
}

function signHeaderRequest({ method, url, headers = {}, payloadHash, cfg, now = new Date() }) {
  const { amzDate, dateStamp } = formatAmzDate(now);
  const allHeaders = {
    host: url.host,
    'x-amz-content-sha256': payloadHash,
    'x-amz-date': amzDate,
    ...headers,
  };

  const lowerEntries = Object.entries(allHeaders)
    .map(([k, v]) => [k.toLowerCase(), String(v).trim().replace(/\s+/g, ' ')])
    .sort(([a], [b]) => a.localeCompare(b));

  const canonicalHeaders = lowerEntries.map(([k, v]) => `${k}:${v}\n`).join('');
  const signedHeaders = lowerEntries.map(([k]) => k).join(';');
  const canonicalRequest = [
    method.toUpperCase(),
    url.pathname,
    url.searchParams.toString(),
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

  const signingKey = getSigningKey(cfg.secretAccessKey, dateStamp, cfg.region, 's3');
  const signature = createHmac('sha256', signingKey).update(stringToSign).digest('hex');

  const outHeaders = Object.fromEntries(lowerEntries);
  outHeaders.authorization = `AWS4-HMAC-SHA256 Credential=${cfg.accessKeyId}/${credentialScope}, SignedHeaders=${signedHeaders}, Signature=${signature}`;
  delete outHeaders.host;
  return outHeaders;
}

export async function putR2Object(objectKey, buffer, {
  contentType = 'application/octet-stream',
  sha256 = null,
  idempotencyKey = null,
  env = process.env,
  fetchImpl = fetch,
  timeoutMs = 30_000,
  quotaRepo = undefined,
} = {}) {
  const cfg = getR2Config(env);
  if (!cfg.configured) {
    throw new HttpError(503, 'Penyimpanan dokumen persisten Cloudflare R2 belum dikonfigurasi.', { code: 'R2_NOT_CONFIGURED' });
  }
  const quotaGuard = await reserveR2Operation('PutObject', {
    bytes: buffer.length,
    idempotencyKey,
    env,
    ...(quotaRepo ? { repo: quotaRepo } : {}),
  });

  const payloadHash = sha256 || sha256Hex(buffer);
  const url = buildObjectUrl(cfg, objectKey);
  const headers = signHeaderRequest({
    method: 'PUT',
    url,
    headers: {
      'content-type': contentType,
      // Explicitly enforce Standard storage class (free tier applies to Standard, never Infrequent Access)
      'x-amz-storage-class': 'STANDARD',
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
    await quotaGuard.release({ billableRequestSent: false });
    throw new HttpError(503, 'Gagal menghubungi penyimpanan persisten Cloudflare R2. Berkas belum tersimpan.', {
      code: 'R2_STORAGE_UNAVAILABLE',
      reason: err?.message || 'network_error',
    });
  }

  if (!res.ok) {
    // Request reached R2 (potentially billable Class A attempt), but object bytes were NOT stored
    await quotaGuard.release({ billableRequestSent: true });
    throw new HttpError(503, `Cloudflare R2 menolak unggahan dokumen (HTTP ${res.status}).`, {
      code: 'R2_UPLOAD_FAILED',
      upstream_status: res.status,
    });
  }
  await quotaGuard.commit({ actualBytes: buffer.length });
  return { ok: true, key: objectKey, sha256: payloadHash, size: buffer.length, storageClass: 'STANDARD' };
}

export async function getR2Object(objectKey, {
  env = process.env,
  fetchImpl = fetch,
  timeoutMs = 30_000,
  quotaRepo = undefined,
} = {}) {
  const cfg = getR2Config(env);
  if (!cfg.configured) {
    return { ok: false, code: 'R2_NOT_CONFIGURED', status: 503 };
  }
  const quotaGuard = await reserveR2Operation('GetObject', {
    bytes: 0,
    env,
    ...(quotaRepo ? { repo: quotaRepo } : {}),
  });

  const url = buildObjectUrl(cfg, objectKey);
  const payloadHash = sha256Hex('');
  const headers = signHeaderRequest({ method: 'GET', url, payloadHash, cfg });

  let res;
  try {
    res = await fetchImpl(url.toString(), {
      method: 'GET',
      headers,
      redirect: 'error',
      signal: AbortSignal.timeout(timeoutMs),
    });
  } catch (err) {
    await quotaGuard.release({ billableRequestSent: false });
    return { ok: false, code: 'R2_STORAGE_UNAVAILABLE', status: 503, reason: err?.message || 'network_error' };
  }

  if (res.status === 404) {
    await quotaGuard.release({ billableRequestSent: true });
    return { ok: false, code: 'R2_OBJECT_MISSING', status: 404 };
  }
  if (!res.ok) {
    await quotaGuard.release({ billableRequestSent: true });
    return { ok: false, code: 'R2_FETCH_FAILED', status: res.status };
  }
  const buffer = Buffer.from(await res.arrayBuffer());
  await quotaGuard.commit({ actualBytes: 0 });
  return {
    ok: true,
    buffer,
    contentType: res.headers.get('content-type') || 'application/octet-stream',
  };
}

export async function headR2Object(objectKey, {
  env = process.env,
  fetchImpl = fetch,
  timeoutMs = 15_000,
  quotaRepo = undefined,
} = {}) {
  const cfg = getR2Config(env);
  if (!cfg.configured) return { ok: false, code: 'R2_NOT_CONFIGURED', status: 503 };
  const quotaGuard = await reserveR2Operation('HeadObject', {
    bytes: 0,
    env,
    ...(quotaRepo ? { repo: quotaRepo } : {}),
  });
  const url = buildObjectUrl(cfg, objectKey);
  const headers = signHeaderRequest({ method: 'HEAD', url, payloadHash: sha256Hex(''), cfg });
  try {
    const res = await fetchImpl(url.toString(), {
      method: 'HEAD',
      headers,
      redirect: 'error',
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (res.ok) {
      await quotaGuard.commit({ actualBytes: 0 });
      return { ok: true, contentLength: Number(res.headers.get('content-length') || 0) };
    }
    await quotaGuard.release({ billableRequestSent: true });
    return { ok: false, code: res.status === 404 ? 'R2_OBJECT_MISSING' : 'R2_HEAD_FAILED', status: res.status };
  } catch {
    await quotaGuard.release({ billableRequestSent: false });
    return { ok: false, code: 'R2_STORAGE_UNAVAILABLE', status: 503 };
  }
}

export async function deleteR2Object(objectKey, {
  env = process.env,
  fetchImpl = fetch,
  timeoutMs = 15_000,
  quotaRepo = undefined,
} = {}) {
  const cfg = getR2Config(env);
  if (!cfg.configured) return { ok: false, code: 'R2_NOT_CONFIGURED' };
  const quotaGuard = await reserveR2Operation('DeleteObject', {
    bytes: 0,
    env,
    ...(quotaRepo ? { repo: quotaRepo } : {}),
  });
  const url = buildObjectUrl(cfg, objectKey);
  const payloadHash = sha256Hex('');
  const headers = signHeaderRequest({ method: 'DELETE', url, payloadHash, cfg });
  try {
    const res = await fetchImpl(url.toString(), {
      method: 'DELETE',
      headers,
      redirect: 'error',
      signal: AbortSignal.timeout(timeoutMs),
    });
    await quotaGuard.commit({ actualBytes: 0 });
    return { ok: res.ok || res.status === 404, status: res.status };
  } catch {
    await quotaGuard.release({ billableRequestSent: false });
    return { ok: false, code: 'R2_DELETE_FAILED' };
  }
}

export async function abortR2MultipartUpload(objectKey, uploadId, {
  env = process.env,
  fetchImpl = fetch,
  timeoutMs = 15_000,
  quotaRepo = undefined,
} = {}) {
  const cfg = getR2Config(env);
  if (!cfg.configured || !uploadId) return { ok: false, code: 'R2_NOT_CONFIGURED' };
  const quotaGuard = await reserveR2Operation('AbortMultipartUpload', {
    bytes: 0,
    env,
    ...(quotaRepo ? { repo: quotaRepo } : {}),
  });
  const url = buildObjectUrl(cfg, objectKey);
  url.searchParams.set('uploadId', String(uploadId));
  const headers = signHeaderRequest({ method: 'DELETE', url, payloadHash: sha256Hex(''), cfg });
  try {
    const res = await fetchImpl(url.toString(), {
      method: 'DELETE',
      headers,
      redirect: 'error',
      signal: AbortSignal.timeout(timeoutMs),
    });
    await quotaGuard.commit({ actualBytes: 0 });
    return { ok: res.ok || res.status === 404, status: res.status };
  } catch {
    await quotaGuard.release({ billableRequestSent: false });
    return { ok: false, code: 'R2_ABORT_FAILED' };
  }
}

// Compatibility-only signed URL generator.
// DISABLED by default in strict quota mode (`STRICT_R2_QUOTA_MODE=true`) because reusable
// direct-to-R2 signed URLs bypass backend Class B operation accounting.
// In strict quota mode, all downloads MUST stream through the authenticated backend.
export function generateR2SignedDownloadUrl(objectKey, {
  expiresInSeconds = 120,
  allowCompatibilitySignedUrl = false,
  env = process.env,
  now = new Date(),
} = {}) {
  if (isStrictR2QuotaMode(env) || !allowCompatibilitySignedUrl) {
    throw new HttpError(
      403,
      'Tautan unduhan R2 langsung (reusable signed URL) dinonaktifkan pada mode kuota ketat (STRICT_R2_QUOTA_MODE=true). Gunakan unduhan terautentikasi melalui backend agar setiap pembacaan R2 tercatat akurat.',
      { code: 'SIGNED_URL_DISABLED_IN_STRICT_QUOTA_MODE' },
    );
  }
  const cfg = getR2Config(env);
  if (!cfg.configured) {
    throw new HttpError(503, 'Cloudflare R2 belum dikonfigurasi untuk membuat tautan unduhan bertanda tangan.', { code: 'R2_NOT_CONFIGURED' });
  }
  // Keep compatibility signed URLs strictly short-lived (max 300s)
  const ttl = Math.max(30, Math.min(Number(expiresInSeconds) || 120, 300));
  const { amzDate, dateStamp } = formatAmzDate(now);
  const credentialScope = `${dateStamp}/${cfg.region}/s3/aws4_request`;
  const url = buildObjectUrl(cfg, objectKey);

  const queryParams = [
    ['X-Amz-Algorithm', 'AWS4-HMAC-SHA256'],
    ['X-Amz-Credential', `${cfg.accessKeyId}/${credentialScope}`],
    ['X-Amz-Date', amzDate],
    ['X-Amz-Expires', String(ttl)],
    ['X-Amz-SignedHeaders', 'host'],
  ].sort(([a], [b]) => a.localeCompare(b));

  const canonicalQuery = queryParams.map(([k, v]) => `${encodeRfc3986(k)}=${encodeRfc3986(v)}`).join('&');
  const canonicalRequest = [
    'GET',
    url.pathname,
    canonicalQuery,
    `host:${url.host}\n`,
    'host',
    'UNSIGNED-PAYLOAD',
  ].join('\n');

  const stringToSign = [
    'AWS4-HMAC-SHA256',
    amzDate,
    credentialScope,
    sha256Hex(canonicalRequest),
  ].join('\n');

  const signingKey = getSigningKey(cfg.secretAccessKey, dateStamp, cfg.region, 's3');
  const signature = createHmac('sha256', signingKey).update(stringToSign).digest('hex');

  return `${url.origin}${url.pathname}?${canonicalQuery}&X-Amz-Signature=${signature}`;
}
