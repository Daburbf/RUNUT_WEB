// Immutable original uploaded file store backed by Cloudflare R2 (private objects)
// + Neon PostgreSQL metadata (`document_files`, Migration v6).
// Keeps original uploaded DOCX/PDF files untouched so downloads apply approved edits
// directly onto the original template without overwriting the original upload.
// In production, Render ephemeral local disk is NEVER treated as authoritative storage.
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync, unlinkSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { documentFiles, objectStorageUsage, storage } from '../repositories/index.js';
import { HttpError } from '../middleware/errors.js';
import {
  shouldUseR2Storage,
  isR2Configured,
  buildPrivateObjectKey,
  putR2Object,
  getR2Object,
  deleteR2Object,
} from './r2Storage.js';
import {
  isOciConfigured,
  putOciObject,
  getOciObject,
  deleteOciObject,
} from './ociObjectStorage.js';
import { recordR2Delete } from './r2Quota.js';

// Conservative Neon Free PostgreSQL application-side safety limits (NOT provider-side billing caps):
//   - Managed document data : 700 MB    (Neon Free: 1 GB storage/project)
//   - Total DB size ceiling : 850 MB    (leaves headroom for users/tokens/metadata below 1 GB)
//   - Monthly outbound data : 4 GB/mo   (Neon Free: 5 GB public network transfer/project/mo)
export const DEFAULT_PG_MAX_MANAGED_BYTES = 700 * 1024 * 1024;
export const DEFAULT_PG_MAX_DATABASE_BYTES = 850 * 1024 * 1024;
export const DEFAULT_PG_MAX_OUTBOUND_BYTES = 4 * 1024 * 1024 * 1024;

export function getPostgresStorageLimits(env = process.env) {
  const rawManaged = Number(env.PG_MAX_MANAGED_BYTES);
  const rawDb = Number(env.PG_MAX_DATABASE_BYTES);
  const rawOutbound = Number(env.PG_MAX_OUTBOUND_BYTES);
  return {
    maxManagedBytes: Math.min(
      DEFAULT_PG_MAX_MANAGED_BYTES,
      Math.max(1024, Number.isFinite(rawManaged) && rawManaged > 0 ? rawManaged : DEFAULT_PG_MAX_MANAGED_BYTES),
    ),
    maxDatabaseBytes: Math.min(
      DEFAULT_PG_MAX_DATABASE_BYTES,
      Math.max(1024, Number.isFinite(rawDb) && rawDb > 0 ? rawDb : DEFAULT_PG_MAX_DATABASE_BYTES),
    ),
    maxOutboundBytes: Math.min(
      DEFAULT_PG_MAX_OUTBOUND_BYTES,
      Math.max(1024, Number.isFinite(rawOutbound) && rawOutbound > 0 ? rawOutbound : DEFAULT_PG_MAX_OUTBOUND_BYTES),
    ),
    maxApiRequests: 10_000_000,
  };
}

function currentUtcMonth() {
  return new Date().toISOString().slice(0, 7);
}

export function resolveObjectStorageProvider(env = process.env) {
  const explicit = String(env.OBJECT_STORAGE_PROVIDER || env.FILE_STORAGE_PROVIDER || 'auto').trim().toLowerCase();
  if (explicit === 'oci') return 'oci';
  if (explicit === 'r2') return 'r2';
  if (explicit === 'postgres' || explicit === 'local') return explicit;
  if (isOciConfigured(env)) return 'oci';
  if (shouldUseR2Storage(env)) return 'r2';
  return 'postgres';
}

export function getDocumentStorageStatus(env = process.env) {
  const provider = resolveObjectStorageProvider(env);
  const configured = provider === 'oci'
    ? isOciConfigured(env)
    : (provider === 'r2' ? isR2Configured(env) : true);
  return {
    provider,
    configured,
    strict_quota_mode: String(env.STRICT_STORAGE_QUOTA_MODE ?? env.STRICT_R2_QUOTA_MODE ?? 'true').trim().toLowerCase() !== 'false',
    automatic_failover: false,
  };
}

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const UPLOADS_DIR = path.resolve(__dirname, '../../.data/uploads');
const memoryFiles = new Map();

function useLocalDiskCache() {
  return process.env.NODE_ENV !== 'test' && process.env.NODE_ENV !== 'production';
}

function safeDocId(docId) {
  return String(docId || '').replace(/[^a-zA-Z0-9_-]/g, '');
}

function sha256Hex(buffer) {
  return createHash('sha256').update(buffer).digest('hex');
}

function mimeForExt(ext) {
  if (ext === 'pdf') return 'application/pdf';
  if (ext === 'docx') return 'application/vnd.openxmlformats-officedocument.wordprocessingml.document';
  if (ext === 'doc') return 'application/msword';
  return 'application/octet-stream';
}

export function clearMemoryFileCache() {
  memoryFiles.clear();
}

export function saveOriginalUpload(docId, { buffer, ext, originalName, userId = null }) {
  const id = safeDocId(docId);
  const cleanExt = String(ext || '').toLowerCase().replace(/[^a-z0-9]/g, '');
  if (!id || !buffer || !Buffer.isBuffer(buffer) || !cleanExt) return null;

  const meta = {
    docId: id,
    userId: userId || null,
    ext: cleanExt,
    originalName: String(originalName || `document.${cleanExt}`).slice(0, 255),
    size: buffer.length,
    sha256: sha256Hex(buffer),
    savedAt: new Date().toISOString(),
  };

  if (useLocalDiskCache()) {
    mkdirSync(UPLOADS_DIR, { recursive: true });
    const filePath = path.join(UPLOADS_DIR, `${id}.${cleanExt}`);
    if (!existsSync(filePath)) {
      writeFileSync(filePath, buffer);
    }
    memoryFiles.set(id, { ...meta, filePath });
    return meta;
  }

  if (!memoryFiles.has(id)) {
    memoryFiles.set(id, { ...meta, buffer: Buffer.from(buffer) });
  }
  return meta;
}

export async function saveOriginalUploadPersistent(docId, {
  userId = null,
  buffer,
  ext,
  originalName,
  env = process.env,
  fetchImpl = fetch,
} = {}) {
  const id = safeDocId(docId);
  const cleanExt = String(ext || '').toLowerCase().replace(/[^a-z0-9]/g, '');
  if (!id || !buffer || !Buffer.isBuffer(buffer) || !cleanExt) return null;

  const digest = sha256Hex(buffer);
  const cleanName = String(originalName || `document.${cleanExt}`).slice(0, 255);
  const provider = resolveObjectStorageProvider(env);

  // OCI Object Storage primary path — ZERO automatic failover to R2!
  if (provider === 'oci') {
    if (!isOciConfigured(env)) {
      throw new HttpError(
        503,
        'Penyimpanan OCI Object Storage diaktifkan (OBJECT_STORAGE_PROVIDER=oci) tetapi kredensial OCI belum lengkap. Tidak ada failover otomatis ke R2.',
        { code: 'OCI_NOT_CONFIGURED' },
      );
    }
    if (!userId) {
      throw new HttpError(400, 'ID pemilik dokumen wajib tersedia untuk penyimpanan OCI privat.', { code: 'MISSING_OWNER' });
    }
    const objectKey = buildPrivateObjectKey(userId, id, cleanExt);
    await putOciObject(objectKey, buffer, {
      contentType: mimeForExt(cleanExt),
      sha256: digest,
      env,
      fetchImpl,
    });
    if (typeof documentFiles?.save === 'function') {
      await documentFiles.save({
        document_id: id,
        user_id: userId,
        ext: cleanExt,
        original_name: cleanName,
        size_bytes: buffer.length,
        sha256: digest,
        content: null,
        storage_provider: 'oci',
        storage_key: objectKey,
      });
    }
    return {
      docId: id,
      userId,
      ext: cleanExt,
      originalName: cleanName,
      size: buffer.length,
      sha256: digest,
      storageProvider: 'oci',
      storageKey: objectKey,
      savedAt: new Date().toISOString(),
    };
  }

  if (provider === 'r2') {
    if (!isR2Configured(env)) {
      throw new HttpError(
        503,
        'Penyimpanan dokumen Cloudflare R2 diaktifkan (FILE_STORAGE_PROVIDER=r2) tetapi kredensial R2 belum lengkap. Unggahan ditolak agar berkas tidak hilang.',
        { code: 'R2_NOT_CONFIGURED' },
      );
    }
    if (!userId) {
      throw new HttpError(400, 'ID pemilik dokumen wajib tersedia untuk penyimpanan R2 privat.', { code: 'MISSING_OWNER' });
    }
    const objectKey = buildPrivateObjectKey(userId, id, cleanExt);
    // Upload to private R2 bucket FIRST; throws 503 if R2 is unavailable (never silently falls back to ephemeral disk!)
    await putR2Object(objectKey, buffer, {
      contentType: mimeForExt(cleanExt),
      sha256: digest,
      env,
      fetchImpl,
    });
    if (typeof documentFiles?.save === 'function') {
      await documentFiles.save({
        document_id: id,
        user_id: userId,
        ext: cleanExt,
        original_name: cleanName,
        size_bytes: buffer.length,
        sha256: digest,
        content: null,
        storage_provider: 'r2',
        storage_key: objectKey,
      });
    }
    return {
      docId: id,
      userId,
      ext: cleanExt,
      originalName: cleanName,
      size: buffer.length,
      sha256: digest,
      storageProvider: 'r2',
      storageKey: objectKey,
      savedAt: new Date().toISOString(),
    };
  }

  // PostgreSQL BYTEA persistent storage (Neon Free primary for simple zero-cost deploy)
  // or local memory/disk cache in dev/test.
  const isPostgresAuthoritative = provider === 'postgres' || storage.driver === 'postgresql';
  let pgReservationId = null;
  const pgLimits = getPostgresStorageLimits(env);
  if (isPostgresAuthoritative && userId && typeof objectStorageUsage?.reserve === 'function') {
    const metrics = typeof documentFiles?.getStorageMetrics === 'function'
      ? await documentFiles.getStorageMetrics().catch(() => null)
      : null;
    if (metrics && (
      metrics.managed_bytes + buffer.length > pgLimits.maxManagedBytes
      || metrics.total_db_bytes + buffer.length > pgLimits.maxDatabaseBytes
    )) {
      throw new HttpError(
        503,
        'Batas aman aplikasi kapasitas penyimpanan PostgreSQL (700 MB / batas Neon Free 1 GB) telah tercapai; dokumen lama tetap aman.',
        { code: 'POSTGRES_STORAGE_CAPACITY_LIMIT' },
      );
    }
    const res = await objectStorageUsage.reserve({
      provider: 'postgres',
      month: currentUtcMonth(),
      operation: 'PutObject',
      bytes: buffer.length,
      requests: 1,
      outbound_bytes: 0,
      limits: pgLimits,
    });
    if (!res?.ok) {
      throw new HttpError(
        503,
        'Batas aman aplikasi kapasitas penyimpanan PostgreSQL (700 MB / batas Neon Free 1 GB) telah tercapai; dokumen lama tetap aman.',
        { code: 'POSTGRES_STORAGE_CAPACITY_LIMIT' },
      );
    }
    pgReservationId = res.reservation?.id || null;
  }

  const meta = saveOriginalUpload(id, { userId, buffer, ext: cleanExt, originalName: cleanName });
  if (!meta) {
    if (pgReservationId) await objectStorageUsage.release(pgReservationId, { billable_request_sent: false }).catch(() => {});
    return null;
  }
  if (userId && typeof documentFiles?.save === 'function') {
    try {
      await documentFiles.save({
        document_id: meta.docId,
        user_id: userId,
        ext: meta.ext,
        original_name: meta.originalName,
        size_bytes: meta.size,
        sha256: meta.sha256,
        content: buffer,
        storage_provider: 'postgres',
        storage_key: null,
      });
      if (pgReservationId) {
        await objectStorageUsage.commit(pgReservationId, { actual_bytes: meta.size, object_delta: 1 }).catch(() => {});
      }
    } catch (err) {
      if (pgReservationId) {
        await objectStorageUsage.release(pgReservationId, { billable_request_sent: false }).catch(() => {});
      }
      if (storage.driver === 'postgresql' || provider === 'postgres') {
        throw new HttpError(503, `Gagal menyimpan dokumen asli ke penyimpanan persisten: ${err.message}`, {
          code: 'PERSISTENT_STORAGE_FAILED',
        });
      }
    }
  }
  return { ...meta, storageProvider: isPostgresAuthoritative ? 'postgres' : 'local' };
}

export function getOriginalUpload(docId) {
  const id = safeDocId(docId);
  if (!id) return null;

  const cached = memoryFiles.get(id);
  if (cached) {
    if (cached.buffer) {
      return { ...cached, buffer: Buffer.from(cached.buffer) };
    }
    if (cached.filePath && existsSync(cached.filePath)) {
      return { ...cached, buffer: readFileSync(cached.filePath) };
    }
  }

  if (useLocalDiskCache()) {
    for (const ext of ['docx', 'pdf', 'doc', 'txt']) {
      const filePath = path.join(UPLOADS_DIR, `${id}.${ext}`);
      if (existsSync(filePath)) {
        const buffer = readFileSync(filePath);
        return { docId: id, ext, buffer, size: buffer.length };
      }
    }
  }

  return null;
}

export async function getOriginalUploadPersistent(docId, {
  userId = null,
  env = process.env,
  fetchImpl = fetch,
} = {}) {
  const id = safeDocId(docId);
  if (!id) return null;

  // 1. Authoritative persistent repository lookup (enforces per-user user_id isolation & provider-specific retrieval)
  if (typeof documentFiles?.findByDocumentId === 'function') {
    const row = await documentFiles.findByDocumentId(id, { user_id: userId }).catch(() => null);
    if (row) {
      if (row.storage_provider === 'oci' && row.storage_key) {
        const fetched = await getOciObject(row.storage_key, { expectedBytes: row.size_bytes || 0, env, fetchImpl });
        if (!fetched.ok) {
          throw new HttpError(
            fetched.status === 404 ? 404 : 503,
            fetched.code === 'OCI_OBJECT_MISSING'
              ? 'Berkas dokumen asli tidak ditemukan di OCI Object Storage.'
              : 'OCI Object Storage sedang tidak dapat dijangkau. Coba lagi nanti.',
            { code: fetched.code },
          );
        }
        const actualHash = sha256Hex(fetched.buffer);
        if (row.sha256 && actualHash !== row.sha256) {
          throw new HttpError(500, 'Integritas berkas asli dari OCI Object Storage tidak cocok (SHA-256 mismatch).', {
            code: 'STORAGE_INTEGRITY_MISMATCH',
          });
        }
        return {
          docId: row.document_id,
          userId: row.user_id,
          ext: row.ext,
          originalName: row.original_name,
          size: row.size_bytes,
          sha256: row.sha256,
          storageProvider: 'oci',
          storageKey: row.storage_key,
          buffer: fetched.buffer,
        };
      }
      if (row.storage_provider === 'r2' && row.storage_key) {
        const fetched = await getR2Object(row.storage_key, { env, fetchImpl });
        if (!fetched.ok) {
          throw new HttpError(
            fetched.status === 404 ? 404 : 503,
            fetched.code === 'R2_OBJECT_MISSING'
              ? 'Berkas dokumen asli tidak ditemukan di penyimpanan Cloudflare R2.'
              : 'Penyimpanan Cloudflare R2 sedang tidak dapat dijangkau. Coba lagi nanti.',
            { code: fetched.code },
          );
        }
        const actualHash = sha256Hex(fetched.buffer);
        if (row.sha256 && actualHash !== row.sha256) {
          throw new HttpError(500, 'Integritas berkas asli dari penyimpanan R2 tidak cocok (SHA-256 mismatch).', {
            code: 'STORAGE_INTEGRITY_MISMATCH',
          });
        }
        return {
          docId: row.document_id,
          userId: row.user_id,
          ext: row.ext,
          originalName: row.original_name,
          size: row.size_bytes,
          sha256: row.sha256,
          storageProvider: 'r2',
          storageKey: row.storage_key,
          buffer: fetched.buffer,
        };
      }
      if (Buffer.isBuffer(row.buffer)) {
        const actualHash = sha256Hex(row.buffer);
        if (row.sha256 && actualHash !== row.sha256) {
          throw new HttpError(500, 'Integritas berkas asli dari PostgreSQL tidak cocok (SHA-256 mismatch).', {
            code: 'STORAGE_INTEGRITY_MISMATCH',
          });
        }
        const provider = resolveObjectStorageProvider(env);
        if ((provider === 'postgres' || storage.driver === 'postgresql') && typeof objectStorageUsage?.reserve === 'function') {
          const pgLimits = getPostgresStorageLimits(env);
          const outRes = await objectStorageUsage.reserve({
            provider: 'postgres',
            month: currentUtcMonth(),
            operation: 'GetObject',
            bytes: 0,
            requests: 1,
            outbound_bytes: row.buffer.length,
            limits: pgLimits,
          });
          if (!outRes?.ok) {
            throw new HttpError(
              503,
              'Batas aman aplikasi transfer jaringan bulanan PostgreSQL (4 GB/bulan, target Neon Free 5 GB) telah tercapai.',
              { code: 'POSTGRES_OUTBOUND_LIMIT' },
            );
          }
          if (outRes.reservation?.id) {
            await objectStorageUsage.commit(outRes.reservation.id, {
              actual_bytes: 0,
              actual_outbound_bytes: row.buffer.length,
              object_delta: 0,
            }).catch(() => {});
          }
        }
        return {
          docId: row.document_id,
          userId: row.user_id,
          ext: row.ext,
          originalName: row.original_name,
          size: row.size_bytes,
          sha256: row.sha256,
          storageProvider: 'postgres',
          buffer: row.buffer,
        };
      }
    }
    if (userId) {
      const anyOwner = await documentFiles.findByDocumentId(id).catch(() => null);
      if (anyOwner && anyOwner.user_id && anyOwner.user_id !== userId) {
        return null;
      }
    }
  }

  // 2. In-memory cache (for tests & non-R2 local dev only)
  const cached = memoryFiles.get(id);
  if (cached && (!userId || (cached.userId && cached.userId === userId))) {
    if (cached.buffer) {
      return { ...cached, buffer: Buffer.from(cached.buffer) };
    }
    if (cached.filePath && existsSync(cached.filePath)) {
      return { ...cached, buffer: readFileSync(cached.filePath) };
    }
  }

  // 3. Local disk fallback ONLY outside production (never use Render ephemeral disk as authoritative storage)
  if (useLocalDiskCache()) {
    for (const ext of ['docx', 'pdf', 'doc', 'txt']) {
      const filePath = path.join(UPLOADS_DIR, `${id}.${ext}`);
      if (existsSync(filePath)) {
        const buffer = readFileSync(filePath);
        return { docId: id, ext, buffer, size: buffer.length };
      }
    }
  }

  return null;
}

export function deleteOriginalUpload(docId) {
  const id = safeDocId(docId);
  if (!id) return;
  const cached = memoryFiles.get(id);
  memoryFiles.delete(id);
  if (typeof documentFiles?.deleteByDocumentId === 'function') {
    Promise.resolve(documentFiles.deleteByDocumentId(id)).catch(() => {});
  }
  if (cached?.filePath && existsSync(cached.filePath)) {
    try { unlinkSync(cached.filePath); } catch { /* ignore */ }
  }
  if (useLocalDiskCache()) {
    for (const ext of ['docx', 'pdf', 'doc', 'txt']) {
      const filePath = path.join(UPLOADS_DIR, `${id}.${ext}`);
      if (existsSync(filePath)) {
        try { unlinkSync(filePath); } catch { /* ignore */ }
      }
    }
  }
}

export async function deleteOriginalUploadPersistent(docId, { env = process.env, fetchImpl = fetch } = {}) {
  const id = safeDocId(docId);
  if (!id) return;
  if (typeof documentFiles?.findByDocumentId === 'function') {
    const row = await documentFiles.findByDocumentId(id).catch(() => null);
    if (row?.storage_provider === 'oci' && row.storage_key) {
      await deleteOciObject(row.storage_key, { knownBytes: row.size_bytes || 0, env, fetchImpl }).catch(() => {});
    } else if (row?.storage_provider === 'r2' && row.storage_key) {
      await deleteR2Object(row.storage_key, { env, fetchImpl }).catch(() => {});
      await recordR2Delete({ bytes: row.size_bytes || 0 });
    } else if (row?.storage_provider === 'postgres' && row.size_bytes > 0 && typeof objectStorageUsage?.recordDelete === 'function') {
      await objectStorageUsage.recordDelete({ provider: 'postgres', month: currentUtcMonth(), bytes: row.size_bytes }).catch(() => {});
    }
  }
  deleteOriginalUpload(id);
  if (typeof documentFiles?.deleteByDocumentId === 'function') {
    await documentFiles.deleteByDocumentId(id).catch(() => {});
  }
}
