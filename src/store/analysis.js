// Job analisis global & draf tulisan.
// Proses dipegang store, bukan komponen, supaya pindah halaman (mis. ke halaman
// Pembelian Token) tidak membatalkan permintaan atau menghapus draf tulisan.
import { reactive, watch } from 'vue'
import { api } from '../utils/api'
import { documents } from './documents'
import { auth } from './auth'

const DRAFT_STORAGE_KEY = 'runut_editor_draft_v1'

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
    job.status = 'done'
    return data
  } catch (e) {
    job.error = e.message || 'Analisis gagal. Coba lagi.'
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

export function clearJob() {
  stopTick()
  job.status = 'idle'
  job.error = ''
  job.errorCode = ''
  job.errorDetails = null
  job.documentId = null
  job.elapsed = 0
}
