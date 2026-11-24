import { documents, refreshTokens, downloadTransactions } from '../repositories/index.js';
import { deleteOriginalUpload } from './fileStore.js';

// Retensi SRS (FR-11): dokumen kedaluwarsa 30 hari setelah analisis terakhir
// kecuali dihapus lebih awal oleh pengguna, sekaligus pembersihan refresh token
// kedaluwarsa, berkas unggahan yatim di disk, dan pelepasan reservasi unduhan kedaluwarsa.
export async function cleanupExpiredDocuments() {
  const deletedIds = await documents.deleteExpired();
  const ids = Array.isArray(deletedIds) ? deletedIds : [];
  for (const id of ids) {
    deleteOriginalUpload(id);
  }
  const expiredTokens = typeof refreshTokens.deleteExpired === 'function'
    ? await refreshTokens.deleteExpired()
    : 0;
  const releasedReservations = typeof downloadTransactions.releaseExpired === 'function'
    ? await downloadTransactions.releaseExpired()
    : 0;
  if (ids.length > 0 || expiredTokens > 0 || releasedReservations > 0) {
    console.log(JSON.stringify({
      event: 'retention_cleanup',
      deleted_documents: ids.length,
      deleted_refresh_tokens: expiredTokens,
      released_download_reservations: releasedReservations,
    }));
  }
  return ids.length;
}

export function startRetentionJob(intervalMs = 6 * 3600 * 1000) {
  const run = () => cleanupExpiredDocuments().catch((e) => console.error('[retention]', e.message));
  const timer = setInterval(run, intervalMs);
  timer.unref?.();
  return timer;
}
