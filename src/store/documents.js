// Akses dokumen via backend. Draf analisis aktif tetap di sessionStorage agar
// refresh di halaman hasil tidak menghilangkan konteks.
import { api, downloadFile } from '../utils/api';
import { auth } from './auth';

const DRAFT_KEY = 'runut_current_v2';

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

  async download(id, format, filename) {
    await downloadFile(`/api/documents/${id}/download?format=${format}`, filename || `runut-revisi.${format}`);
    await auth.refreshProfile();
  },
};
