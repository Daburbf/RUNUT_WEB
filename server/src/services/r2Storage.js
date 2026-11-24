// Cloudflare R2 private persistent object storage client (S3-compatible AWS SigV4).
// Uses Node.js built-in node:crypto and fetch with zero extra npm dependencies.
// Objects are stored in private per-user namespaces:
//   users/<userId>/documents/<docId>/original.<ext>
import { createHash, createHmac } from 'node:crypto';
import { HttpError } from '../middleware/errors.js';

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
    amzDate: iso, // YYYYMMDDTHHMMSSZ
    dateStamp: iso.slice(0, 8), // YYYYMMDD
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
  env = process.env,
  fetchImpl = fetch,
  timeoutMs = 30_000,
} = {}) {
  const cfg = getR2Config(env);
  if (!cfg.configured) {
    throw new HttpError(503, 'Penyimpanan dokumen persisten Cloudflare R2 belum dikonfigurasi.', { code: 'R2_NOT_CONFIGURED' });
  }
  const payloadHash = sha256 || sha256Hex(buffer);
  const url = buildObjectUrl(cfg, objectKey);
  const headers = signHeaderRequest({
    method: 'PUT',
    url,
    headers: { 'content-type': contentType },
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
    throw new HttpError(503, 'Gagal menghubungi penyimpanan persisten Cloudflare R2. Berkas belum tersimpan.', {
      code: 'R2_STORAGE_UNAVAILABLE',
      reason: err?.message || 'network_error',
    });
  }

  if (!res.ok) {
    throw new HttpError(503, `Cloudflare R2 menolak unggahan dokumen (HTTP ${res.status}).`, {
      code: 'R2_UPLOAD_FAILED',
      upstream_status: res.status,
    });
  }
  return { ok: true, key: objectKey, sha256: payloadHash, size: buffer.length };
}

export async function getR2Object(objectKey, {
  env = process.env,
  fetchImpl = fetch,
  timeoutMs = 30_000,
} = {}) {
  const cfg = getR2Config(env);
  if (!cfg.configured) {
    return { ok: false, code: 'R2_NOT_CONFIGURED', status: 503 };
  }
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
    return { ok: false, code: 'R2_STORAGE_UNAVAILABLE', status: 503, reason: err?.message || 'network_error' };
  }

  if (res.status === 404) {
    return { ok: false, code: 'R2_OBJECT_MISSING', status: 404 };
  }
  if (!res.ok) {
    return { ok: false, code: 'R2_FETCH_FAILED', status: res.status };
  }
  const buffer = Buffer.from(await res.arrayBuffer());
  return {
    ok: true,
    buffer,
    contentType: res.headers.get('content-type') || 'application/octet-stream',
  };
}

export async function deleteR2Object(objectKey, {
  env = process.env,
  fetchImpl = fetch,
  timeoutMs = 15_000,
} = {}) {
  const cfg = getR2Config(env);
  if (!cfg.configured) return { ok: false, code: 'R2_NOT_CONFIGURED' };
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
    return { ok: res.ok || res.status === 404, status: res.status };
  } catch {
    return { ok: false, code: 'R2_DELETE_FAILED' };
  }
}

export function generateR2SignedDownloadUrl(objectKey, {
  expiresInSeconds = 300,
  env = process.env,
  now = new Date(),
} = {}) {
  const cfg = getR2Config(env);
  if (!cfg.configured) {
    throw new HttpError(503, 'Cloudflare R2 belum dikonfigurasi untuk membuat tautan unduhan bertanda tangan.', { code: 'R2_NOT_CONFIGURED' });
  }
  const ttl = Math.max(30, Math.min(Number(expiresInSeconds) || 300, 3600));
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
