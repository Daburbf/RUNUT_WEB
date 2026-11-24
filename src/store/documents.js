// Akses dokumen via backend dengan transaksi unduhan 2-fase (reserve -> save -> commit/cancel)
// agar pembatalan Save As / penutupan File Explorer / kegagalan ekspor tidak memotong token permanen.
import { api, fetchBlob, saveBlob } from '../utils/api';
import { auth } from './auth';

const DRAFT_KEY = 'runut_current_v2';
const inFlightDownloads = new Set();

const PICKER_TYPES = {
  pdf: [{ description: 'PDF Document', accept: { 'application/pdf': ['.pdf'] } }],
  docx: [{ description: 'Word Document', accept: { 'application/vnd.openxmlformats-officedocument.wordprocessingml.document': ['.docx'] } }],
  txt: [{ description: 'Text Document', accept: { 'text/plain': ['.txt'] } }],
};

function makeIdemKey(id, format) {
  const rand = typeof crypto !== 'undefined' && crypto.randomUUID
    ? crypto.randomUUID()
    : `${Date.now()}-${Math.random().toString(16).slice(2)}`;
  return `dl:${id}:${format}:${rand}`;
}

export const documents = {
  setCurrent(doc) {
    try { sessionStorage.setItem(DRAFT_KEY, JSON.stringify(doc)); } catch { /* abaikan */ }
  },
  getCurrent() {
    try { return JSON.parse(sessionStorage.getItem(DRAFT_KEY) || 'null'); } catch { return null; }
  },
  clearCurrent() {
    try { sessionStorage.removeItem(DRAFT_KEY); } catch { /* abaikan */ }
  },

  list: (q = '', status = '') => {
    const params = new URLSearchParams();
    if (q) params.set('q', q);
    if (status) params.set('status', status);
    const qs = params.toString();
    return api(`/api/documents${qs ? `?${qs}` : ''}`);
  },
  get: (id) => api(`/api/documents/${id}`),
  decide: (id, body) => api(`/api/documents/${id}/issues`, { method: 'PATCH', body }),
  restore: (id) => api(`/api/documents/${id}/restore`, { method: 'POST', body: {} }),
  rename: (id, title) => api(`/api/documents/${id}/title`, { method: 'PATCH', body: { title } }),
  removeMany: (ids) => api('/api/documents', { method: 'DELETE', body: { ids } }),

  async confirmDownload(id, txId) {
    const res = await api(`/api/documents/${id}/download/${txId}/commit`, { method: 'POST', body: {} });
    if (res?.balance !== undefined) auth.setBalance(res.balance);
    await auth.refreshProfile();
    return res;
  },

  async cancelDownload(id, txId, reason = 'user_cancelled') {
    const res = await api(`/api/documents/${id}/download/${txId}/cancel`, {
      method: 'POST',
      body: { reason },
    });
    if (res?.balance !== undefined) auth.setBalance(res.balance);
    await auth.refreshProfile();
    return res;
  },

  async download(id, format, filename) {
    const lockKey = `${id}:${format}`;
    if (inFlightDownloads.has(lockKey)) {
      return { status: 'busy', message: 'Unduhan sedang diproses. Mohon tunggu sebentar.' };
    }
    inFlightDownloads.add(lockKey);

    const suggestedName = filename || `runut-revisi.${format}`;
    let txId = null;

    try {
      // Phase A: Reservasi token sementara (BELUM memotong saldo permanen)
      const reserved = await api(`/api/documents/${id}/download/reserve`, {
        method: 'POST',
        body: { format, idempotency_key: makeIdemKey(id, format) },
      });
      txId = reserved?.transaction?.id;
      if (!txId) {
        throw new Error('Gagal memulai transaksi unduhan. Silakan coba kembali.');
      }

      // Jalur 1: Browser mendukung File System Access API (konfirmasi penyimpanan fisik nyata)
      if (typeof window !== 'undefined' && typeof window.showSaveFilePicker === 'function') {
        let handle;
        try {
          handle = await window.showSaveFilePicker({
            suggestedName,
            types: PICKER_TYPES[format] || undefined,
          });
        } catch (pickerErr) {
          if (pickerErr?.name === 'AbortError') {
            await this.cancelDownload(id, txId, 'user_cancelled_picker').catch(() => {});
            return {
              status: 'cancelled',
              cancelled: true,
              transactionId: txId,
              message: 'Unduhan dibatalkan. Token Anda tidak dipotong.',
            };
          }
          await this.cancelDownload(id, txId, 'picker_error').catch(() => {});
          throw pickerErr;
        }

        let blob;
        try {
          blob = await fetchBlob(`/api/documents/${id}/download/file?tx=${encodeURIComponent(txId)}`);
        } catch (fetchErr) {
          await this.cancelDownload(id, txId, 'file_fetch_failed').catch(() => {});
          throw fetchErr;
        }

        try {
          const writable = await handle.createWritable();
          await writable.write(blob);
          await writable.close();
        } catch (writeErr) {
          await this.cancelDownload(id, txId, 'file_write_failed').catch(() => {});
          if (writeErr?.name === 'AbortError') {
            return {
              status: 'cancelled',
              cancelled: true,
              transactionId: txId,
              message: 'Unduhan dibatalkan. Token Anda tidak dipotong.',
            };
          }
          throw new Error('Gagal menyimpan file ke perangkat Anda. Token Anda tidak dipotong.');
        }

        // Phase B: File benar-benar selesai ditulis & ditutup -> commit token atomik
        await this.confirmDownload(id, txId);
        return {
          status: 'committed',
          transactionId: txId,
          message: `Dokumen (${format.toUpperCase()}) berhasil disimpan.`,
        };
      }

      // Jalur 2: Fallback untuk browser tanpa File System Access API (Firefox / Safari / Mobile).
      // Tidak memotong token permanen secara diam-diam sebelum konfirmasi eksplisit pengguna.
      let blob;
      try {
        blob = await fetchBlob(`/api/documents/${id}/download/file?tx=${encodeURIComponent(txId)}`);
      } catch (fetchErr) {
        await this.cancelDownload(id, txId, 'file_fetch_failed').catch(() => {});
        throw fetchErr;
      }

      saveBlob(blob, suggestedName);
      await auth.refreshProfile();
      return {
        status: 'awaiting_confirmation',
        transactionId: txId,
        documentId: id,
        filename: suggestedName,
        message: 'File dikirim ke browser. Konfirmasi jika file berhasil disimpan, atau batalkan agar reservasi token dilepaskan.',
      };
    } finally {
      inFlightDownloads.delete(lockKey);
    }
  },
};
