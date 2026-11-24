// Persistent, atomic application-side safety quota tracker & Cloudflare R2 Analytics reconciler.
// Authoritative counters live in Neon PostgreSQL (`r2_monthly_usage` & `r2_quota_reservations`, Migration v7)
// so counters survive restarts, redeploys, and multi-process concurrency.
//
// IMPORTANT: These are application-side safety limits (80% of published Cloudflare R2 Free allowances),
// NOT a provider-side hard billing cap. Cloudflare R2 bills overages beyond the free tier if exceeded.
import { HttpError } from '../middleware/errors.js';
import { r2Usage as defaultR2UsageRepo } from '../repositories/index.js';

export const DEFAULT_R2_MAX_MANAGED_BYTES = 8 * 1024 * 1024 * 1024; // 8 GB safety limit (Free: 10 GB-month)
export const DEFAULT_R2_CLASS_A_LIMIT = 800_000; // 80% of 1,000,000/mo free Class A ops
export const DEFAULT_R2_CLASS_B_LIMIT = 8_000_000; // 80% of 10,000,000/mo free Class B ops

// Explicit Cloudflare R2 operation registry per official R2 pricing classification.
// Every R2 request must map through this registry so no storage method silently bypasses accounting.
export const R2_OPERATION_REGISTRY = Object.freeze({
  PutObject: 'class_a',
  CopyObject: 'class_a',
  CreateMultipartUpload: 'class_a',
  UploadPart: 'class_a',
  CompleteMultipartUpload: 'class_a',
  ListObjectsV2: 'class_a',
  ListBuckets: 'class_a',
  ListMultipartUploads: 'class_a',
  GetObject: 'class_b',
  HeadObject: 'class_b',
  HeadBucket: 'class_b',
  DeleteObject: 'free',
  AbortMultipartUpload: 'free',
});

export function currentUtcMonth(now = new Date()) {
  return now.toISOString().slice(0, 7); // YYYY-MM
}

export function getR2QuotaLimits(env = process.env) {
  return {
    maxManagedBytes: Math.max(1024, Number(env.R2_MAX_MANAGED_BYTES || DEFAULT_R2_MAX_MANAGED_BYTES)),
    maxClassAOps: Math.max(1, Number(env.R2_CLASS_A_MONTHLY_LIMIT || DEFAULT_R2_CLASS_A_LIMIT)),
    maxClassBOps: Math.max(1, Number(env.R2_CLASS_B_MONTHLY_LIMIT || DEFAULT_R2_CLASS_B_LIMIT)),
  };
}

export function classifyR2Operation(operation) {
  const opClass = R2_OPERATION_REGISTRY[operation];
  if (!opClass) {
    throw new HttpError(500, `Operasi R2 "${operation}" tidak terdaftar pada R2_OPERATION_REGISTRY.`, {
      code: 'UNREGISTERED_R2_OPERATION',
    });
  }
  return opClass;
}

export async function getR2QuotaSnapshot({ env = process.env, month = currentUtcMonth(), repo = defaultR2UsageRepo } = {}) {
  const limits = getR2QuotaLimits(env);
  const snap = await repo.getSnapshot(month);
  return {
    ...snap,
    max_managed_bytes: limits.maxManagedBytes,
    max_class_a_ops: limits.maxClassAOps,
    max_class_b_ops: limits.maxClassBOps,
    disclaimer: 'Application-side safety limit (80% dari kuota gratis Cloudflare R2). Bukan provider-side hard billing cap; aktifkan billing alert di Cloudflare.',
  };
}

// Fail-closed atomic quota reservation backed by PostgreSQL (or persistent test repo).
export async function reserveR2Operation(operation, {
  bytes = 0,
  idempotencyKey = null,
  ttlSeconds = 180,
  month = currentUtcMonth(),
  env = process.env,
  repo = defaultR2UsageRepo,
} = {}) {
  const opClass = classifyR2Operation(operation);
  const limits = getR2QuotaLimits(env);

  let result;
  try {
    result = await repo.reserve({
      month,
      operation,
      op_class: opClass,
      bytes,
      idempotency_key: idempotencyKey,
      ttl_seconds: ttlSeconds,
      limits,
    });
  } catch (err) {
    // Fail closed: if quota service/DB is unavailable, never allow unmetered R2 writes/reads
    throw new HttpError(
      503,
      'Layanan pencatatan kuota R2 tidak tersedia. Operasi penyimpanan dihentikan sementara demi menjaga batas aman gratis.',
      { code: 'QUOTA_SERVICE_UNAVAILABLE', reason: err?.message || 'quota_db_error' },
    );
  }

  if (!result?.ok) {
    const code = result?.code || 'R2_STORAGE_QUOTA_LIMIT';
    const msg = code === 'R2_CLASS_A_QUOTA_LIMIT'
      ? 'Batas aman aplikasi operasi tulis bulanan Cloudflare R2 (Class A: 800.000) telah tercapai. Operasi ditunda untuk mencegah biaya overage.'
      : (code === 'R2_CLASS_B_QUOTA_LIMIT'
        ? 'Batas aman aplikasi operasi baca bulanan Cloudflare R2 (Class B: 8.000.000) telah tercapai.'
        : (code === 'R2_QUOTA_HALTED_BY_RECONCILIATION'
          ? 'Operasi R2 dihentikan sementara karena rekonsiliasi Cloudflare Analytics mendeteksi batas aman tercapai.'
          : 'Batas aman aplikasi penyimpanan Cloudflare R2 (8 GB) telah tercapai. Unggahan baru ditolak; dokumen yang sudah ada tetap aman.'));
    throw new HttpError(503, msg, { code });
  }

  const reservationId = result.reservation?.id;
  let settled = Boolean(result.duplicate);

  return {
    id: reservationId,
    duplicate: Boolean(result.duplicate),
    opClass,
    async commit({ actualBytes = null } = {}) {
      if (settled || !reservationId) return;
      settled = true;
      await repo.commit(reservationId, { actual_bytes: actualBytes });
    },
    async release({ billableRequestSent = false } = {}) {
      if (settled || !reservationId) return;
      settled = true;
      await repo.release(reservationId, { billable_request_sent: billableRequestSent });
    },
  };
}

export async function recordR2Delete({ bytes = 0, month = currentUtcMonth(), repo = defaultR2UsageRepo } = {}) {
  await repo.recordDelete({ month, bytes }).catch(() => {});
}

// Reconcile persistent DB counters against Cloudflare R2 GraphQL Analytics API.
// Detects external/untracked requests, updates counters conservatively (Math.max),
// and sets quota_halted=true if provider-reported metrics reach the 80% safety limit.
export async function reconcileR2UsageWithAnalytics({
  accountId = process.env.R2_ACCOUNT_ID,
  apiToken = process.env.CF_ANALYTICS_API_TOKEN || process.env.CLOUDFLARE_API_TOKEN,
  bucket = process.env.R2_BUCKET,
  month = currentUtcMonth(),
  env = process.env,
  fetchImpl = fetch,
  repo = defaultR2UsageRepo,
} = {}) {
  const limits = getR2QuotaLimits(env);
  if (!accountId || !apiToken || !bucket) {
    return {
      ok: false,
      code: 'ANALYTICS_NOT_CONFIGURED',
      reason: 'CF_ANALYTICS_API_TOKEN / R2_ACCOUNT_ID / R2_BUCKET belum dikonfigurasi untuk rekonsiliasi R2 Analytics.',
    };
  }

  const startIso = `${month}-01T00:00:00Z`;
  const endIso = new Date().toISOString();
  const query = `
    query R2Reconciliation($accountTag: String!, $bucketName: String!, $start: Time!, $end: Time!) {
      viewer {
        accounts(filter: { accountTag: $accountTag }) {
          r2OperationsAdaptiveGroups(
            filter: { bucketName: $bucketName, datetime_geq: $start, datetime_leq: $end }
            limit: 100
          ) {
            dimensions { actionType }
            sum { requests }
          }
          r2StorageAdaptiveGroups(
            filter: { bucketName: $bucketName, datetime_geq: $start, datetime_leq: $end }
            limit: 10
            orderBy: [datetime_DESC]
          ) {
            max { payloadSize metadataSize objectCount uploadCount }
          }
        }
      }
    }
  `;

  let res;
  try {
    res = await fetchImpl('https://api.cloudflare.com/client/v4/graphql', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${apiToken}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        query,
        variables: { accountTag: accountId, bucketName: bucket, start: startIso, end: endIso },
      }),
      redirect: 'error',
      signal: AbortSignal.timeout(15_000),
    });
  } catch (err) {
    return {
      ok: false,
      code: 'ANALYTICS_UNAVAILABLE',
      reason: `Gagal menghubungi Cloudflare GraphQL Analytics API: ${err?.message || 'network_error'}`,
    };
  }

  if (!res.ok) {
    return { ok: false, code: 'ANALYTICS_HTTP_ERROR', status: res.status };
  }

  const payload = await res.json().catch(() => null);
  const account = payload?.data?.viewer?.accounts?.[0];
  if (!account) {
    return { ok: false, code: 'ANALYTICS_EMPTY_RESPONSE' };
  }

  let providerClassA = 0;
  let providerClassB = 0;
  for (const grp of account.r2OperationsAdaptiveGroups || []) {
    const action = grp?.dimensions?.actionType || '';
    const count = Number(grp?.sum?.requests || 0);
    const opClass = R2_OPERATION_REGISTRY[action];
    if (opClass === 'class_a') providerClassA += count;
    else if (opClass === 'class_b') providerClassB += count;
  }

  const latestStorage = (account.r2StorageAdaptiveGroups || [])[0]?.max || {};
  const providerStorageBytes = Number(latestStorage.payloadSize || 0) + Number(latestStorage.metadataSize || 0);
  const pendingMultipartUploads = Number(latestStorage.uploadCount || 0);

  const before = await repo.getSnapshot(month);
  const discrepancyDetected =
    providerStorageBytes > before.managed_bytes * 1.15 + 1024 * 1024
    || providerClassA > before.class_a_ops + 50
    || providerClassB > before.class_b_ops + 200;

  const shouldHalt =
    providerStorageBytes >= limits.maxManagedBytes
    || providerClassA >= limits.maxClassAOps
    || providerClassB >= limits.maxClassBOps;

  const status = shouldHalt
    ? 'halted_threshold_reached'
    : (discrepancyDetected ? 'discrepancy_detected' : 'ok');

  const updated = await repo.reconcile({
    month,
    provider_storage_bytes: providerStorageBytes,
    provider_class_a_ops: providerClassA,
    provider_class_b_ops: providerClassB,
    status,
    halt: shouldHalt,
  });

  return {
    ok: true,
    status,
    discrepancy_detected: discrepancyDetected,
    quota_halted: shouldHalt,
    pending_multipart_uploads: pendingMultipartUploads,
    provider_metrics: {
      storage_bytes: providerStorageBytes,
      class_a_ops: providerClassA,
      class_b_ops: providerClassB,
    },
    reconciled: updated,
  };
}
