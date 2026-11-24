// Job analisis global & draf tulisan.
// Proses dipegang store, bukan komponen, supaya pindah halaman (mis. ke halaman
// Pembelian Token) tidak membatalkan permintaan atau menghapus draf tulisan.
import { reactive, watch } from 'vue'
import { api } from '../utils/api'
import { documents } from './documents'
import { auth } from './auth'

const DRAFT_STORAGE_KEY = 'runut_editor_draft_v1'
const IDB_NAME = 'runut_pending_files_v1'
const IDB_STORE = 'files'
const IDB_KEY = 'pending_upload'

function openFileDb() {
  return new Promise((resolve, reject) => {
    if (typeof indexedDB === 'undefined') return resolve(null)
    const req = indexedDB.open(IDB_NAME, 1)
    req.onupgradeneeded = () => {
      if (!req.result.objectStoreNames.contains(IDB_STORE)) {
        req.result.createObjectStore(IDB_STORE)
      }
    }
    req.onsuccess = () => resolve(req.result)
    req.onerror = () => reject(req.error)
  })
}

async function persistPendingFile(file) {
  try {
    const db = await openFileDb()
    if (!db) return
    await new Promise((resolve, reject) => {
      const tx = db.transaction(IDB_STORE, 'readwrite')
      const store = tx.objectStore(IDB_STORE)
      if (file instanceof File || file instanceof Blob) {
        store.put({
          blob: file,
          name: file.name || 'dokumen',
          type: file.type || 'application/octet-stream',
          lastModified: file.lastModified || Date.now(),
        }, IDB_KEY)
      } else {
        store.delete(IDB_KEY)
      }
      tx.oncomplete = () => resolve()
      tx.onerror = () => reject(tx.error)
    })
    db.close()
  } catch { /* abaikan jika IndexedDB tidak tersedia (mis. mode privat) */ }
}

export async function hydratePendingFile() {
  if (job.pendingFile) return job.pendingFile
  try {
    const db = await openFileDb()
    if (!db) return null
    const record = await new Promise((resolve, reject) => {
      const tx = db.transaction(IDB_STORE, 'readonly')
      const req = tx.objectStore(IDB_STORE).get(IDB_KEY)
      req.onsuccess = () => resolve(req.result || null)
      req.onerror = () => reject(req.error)
    })
    db.close()
    if (record?.blob) {
      const restored = typeof File !== 'undefined'
        ? new File([record.blob], record.name || 'dokumen', {
          type: record.type || record.blob.type || 'application/octet-stream',
          lastModified: record.lastModified || Date.now(),
        })
        : record.blob
      job.pendingFile = restored
      return restored
    }
  } catch { /* abaikan */ }
  return null
}

export function setPendingFile(file) {
  job.pendingFile = file || null
  persistPendingFile(job.pendingFile)
}

function loadStoredDraft() {
  try {
    const raw = JSON.parse(sessionStorage.getItem(DRAFT_STORAGE_KEY) || 'null')
    if (raw && typeof raw === 'object') {
      return {
        title: typeof raw.title === 'string' ? raw.title : '',
        text: typeof raw.text === 'string' ? raw.text : '',
        aiConsent: raw.aiConsent !== false,
      }
    }
  } catch { /* abaikan */ }
  return { title: '', text: '', aiConsent: true }
}

function saveStoredDraft(draft) {
  try {
    sessionStorage.setItem(DRAFT_STORAGE_KEY, JSON.stringify({
      title: draft.title || '',
      text: draft.text || '',
      aiConsent: Boolean(draft.aiConsent),
    }))
  } catch { /* abaikan */ }
}

export const job = reactive({
  status: 'idle', // idle | running | done | error
  elapsed: 0,
  startedAt: 0,
  error: '',
  errorCode: '',
  errorDetails: null,
  documentId: null,
  title: '',
  pendingFile: null, // Pertahankan File DOCX/PDF asli lintas navigasi SPA (mis. ke /token lalu kembali ke /analisis)
  draft: loadStoredDraft(),
})

watch(
  () => ({ ...job.draft }),
  (val) => saveStoredDraft(val),
  { deep: true },
)

let timer = null

function stopTick() {
  if (timer) clearInterval(timer)
  timer = null
}

export async function estimateJob({ text, file }) {
  if (file) {
    const form = new FormData()
    form.append('file', file)
    return api('/api/analysis/estimate', { method: 'POST', form })
  }
  return api('/api/analysis/estimate', { method: 'POST', body: { text: text || '' } })
}

export async function startJob({ text, title, file, aiConsent = true, idempotencyKey = '' }) {
  if (job.status === 'running') return null
  job.status = 'running'
  job.error = ''
  job.errorCode = ''
  job.errorDetails = null
  job.documentId = null
  job.title = title || ''
  job.elapsed = 0
  job.startedAt = Date.now()
  const idemKey = idempotencyKey || `analysis-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`
  stopTick()
  timer = setInterval(() => { job.elapsed = Math.floor((Date.now() - job.startedAt) / 1000) }, 1000)
  try {
    let data
    if (file) {
      const form = new FormData()
      form.append('file', file)
      if (title?.trim()) form.append('title', title.trim())
      form.append('ai_consent', aiConsent ? 'true' : 'false')
      form.append('idempotency_key', idemKey)
      data = await api('/api/analysis', { method: 'POST', form })
    } else {
      data = await api('/api/analysis', {
        method: 'POST',
        body: {
          text,
          title: title?.trim() || 'Dokumen tanpa judul',
          ai_consent: Boolean(aiConsent),
          idempotency_key: idemKey,
        },
      })
    }
    documents.setCurrent(data)
    if (data?.meta?.token_balance !== undefined) {
      auth.setBalance(data.meta.token_balance)
    }
    auth.refreshProfile()
    job.documentId = data.document.id
    setPendingFile(null)
    job.status = 'done'
    return data
  } catch (e) {
    job.error = friendlyAnalysisError(e)
    job.errorCode = e.code || ''
    job.errorDetails = e.details || null
    job.status = 'error'
    auth.refreshProfile()
    return null
  } finally {
    stopTick()
    job.elapsed = Math.floor((Date.now() - job.startedAt) / 1000)
  }
}

function friendlyAnalysisError(e) {
  const code = String(e?.code || '').toUpperCase()
  const raw = String(e?.message || '')
  if (
    code === 'AI_HTTP_503'
    || code === 'AI_HTTP_429'
    || code === 'AI_TIMEOUT'
    || code === 'AI_FREE_QUOTA_EXHAUSTED'
    || /HTTP 503|HTTP 429|UNAVAILABLE|high demand|overloaded/i.test(raw)
  ) {
    return 'Layanan analisis sedang sibuk. Silakan coba lagi beberapa saat lagi (token Anda tidak terpotong).'
  }
  if (code.startsWith('AI_') || /Provider AI|OPENROUTER|GEMINI|GROQ|\{"error"/i.test(raw)) {
    return 'Terjadi kendala sementara saat menganalisis teks. Silakan coba lagi (token Anda tidak terpotong).'
  }
  return raw || 'Analisis gagal. Silakan coba lagi.'
}

export function clearJob() {
  stopTick()
  job.status = 'idle'
  job.error = ''
  job.errorCode = ''
  job.errorDetails = null
  job.documentId = null
  job.elapsed = 0
}
