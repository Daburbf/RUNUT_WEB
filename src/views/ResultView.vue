<script setup>
import { ref, computed, onMounted, onBeforeUnmount, watch, nextTick } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import BaseButton from '../components/BaseButton.vue'
import HighlightedText from '../components/HighlightedText.vue'
import SuggestionCard from '../components/SuggestionCard.vue'
import { documents } from '../store/documents'
import { auth } from '../store/auth'
import { api, downloadFile } from '../utils/api'
import { canon, CATEGORIES } from '../utils/categories'

const route = useRoute()
const router = useRouter()
const draft = ref(documents.getCurrent())
const loading = ref(!draft.value)
const loadError = ref('')

const filter = ref(null)            // null = semua kategori
const tab = ref('asli')             // asli | perbaikan
const pane = ref('doc')             // ponsel: doc | temuan
const selected = ref(null)
const activeSection = ref('tulisan-asli')
const showSummaryDrawer = ref(false)
const showDownloadDrawer = ref(false)
const temuanPulse = ref(false)
const notice = ref('')
const error = ref('')
const busyId = ref(null)
const busyAll = ref(false)
const pendingDownload = ref(null)
const dlEl = ref(null)
const reportEl = ref(null)
const moreEl = ref(null)
const preservation = ref(null)

const REPORT_COLORS = [
  { color: 'var(--hl-ai-color)', bg: 'var(--hl-ai-bg)', text: 'var(--hl-ai-text)', label: 'Indikator Gaya AI' },
  { color: 'var(--hl-strong-color)', bg: 'var(--hl-strong-bg)', text: 'var(--hl-strong-text)', label: 'Kecocokan Kuat Tanpa Sitasi' },
  { color: 'var(--hl-citation-color)', bg: 'var(--hl-citation-bg)', text: 'var(--hl-citation-text)', label: 'Masalah Sitasi & Pustaka' },
  { color: 'var(--hl-sim-color)', bg: 'var(--hl-sim-bg)', text: 'var(--hl-sim-text)', label: 'Kemiripan Umum' },
  { color: 'var(--hl-safe-color)', bg: 'var(--hl-safe-bg)', text: 'var(--hl-safe-text)', label: 'Aman / Kutipan Bersitasi Benar' },
  { color: 'var(--hl-neutral-color)', bg: 'var(--hl-neutral-bg)', text: 'var(--hl-neutral-text)', label: 'Ungkapan Umum / Dikecualikan' },
]

function formatThresholdScore(metric) {
  const pct = Math.max(0, Math.min(100, Math.round(Number(metric?.percent) || 0)))
  const isAi = metric?.key === 'ai_usage'
  if (pct === 0) {
    return {
      display: '0%',
      badge: 'Aman',
      color: 'var(--hl-safe-color)',
      bg: 'var(--hl-safe-bg)',
      text: 'var(--hl-safe-text)',
      note: 'Tidak ditemukan indikator yang memenuhi kriteria deteksi.',
      safe: true,
      showPassages: false,
    }
  }
  if (pct < 20) {
    return {
      display: '*%',
      badge: 'Aman (<20%)',
      color: 'var(--hl-safe-color)',
      bg: 'var(--hl-safe-bg)',
      text: 'var(--hl-safe-text)',
      note: 'Indikasi rendah (<20%) dengan potensi false positive — masih tergolong aman.',
      safe: true,
      showPassages: false,
    }
  }
  if (isAi) {
    return {
      display: `${pct}%`,
      badge: 'Indikator Gaya AI',
      color: 'var(--hl-ai-color)',
      bg: 'var(--hl-ai-bg)',
      text: 'var(--hl-ai-text)',
      note: metric?.note || 'Terdeteksi pola penulisan yang memenuhi kriteria indikator gaya AI (bukan bukti pasti penulisan AI).',
      safe: false,
      showPassages: true,
    }
  }
  const strong = pct >= 40
  return {
    display: `${pct}%`,
    badge: strong ? 'Pengulangan Tinggi' : 'Kemiripan Umum',
    color: strong ? 'var(--hl-strong-color)' : 'var(--hl-sim-color)',
    bg: strong ? 'var(--hl-strong-bg)' : 'var(--hl-sim-bg)',
    text: strong ? 'var(--hl-strong-text)' : 'var(--hl-sim-text)',
    note: metric?.note || 'Terdeteksi pengulangan atau kemiripan teks yang memenuhi kriteria indikator.',
    safe: false,
    showPassages: true,
  }
}

function signalColor(metricKey, pct) {
  const n = Math.max(0, Math.round(Number(pct) || 0))
  if (n < 20) return { color: 'var(--hl-safe-color)', bg: 'var(--hl-safe-bg)', text: 'var(--hl-safe-text)', display: n === 0 ? '0%' : '*%', tag: 'Aman' }
  if (metricKey === 'ai_usage') return { color: 'var(--hl-ai-color)', bg: 'var(--hl-ai-bg)', text: 'var(--hl-ai-text)', display: `${n}%`, tag: 'Indikator AI' }
  if (n >= 40) return { color: 'var(--hl-strong-color)', bg: 'var(--hl-strong-bg)', text: 'var(--hl-strong-text)', display: `${n}%`, tag: 'Tinggi' }
  return { color: 'var(--hl-sim-color)', bg: 'var(--hl-sim-bg)', text: 'var(--hl-sim-text)', display: `${n}%`, tag: 'Sedang' }
}

function passagesForMetric(metricKey) {
  if (metricKey === 'similarity') {
    const out = []
    for (const p of (stats.value.top_phrases || []).slice(0, 3)) {
      out.push(`Frasa "${p.phrase}" (${p.count}x)`)
    }
    for (const o of (stats.value.repeated_openings || []).slice(0, 2)) {
      out.push(`Pembuka "${o.opening}" (${o.count}x)`)
    }
    for (const w of (stats.value.top_words || []).filter((x) => !x.common && x.count > 2).slice(0, 3)) {
      out.push(`Kata "${w.word}" (${w.count}x)`)
    }
    return out.slice(0, 5)
  }
  return issues.value
    .filter((i) => ['sentence_pattern', 'uniform_structure', 'transition', 'repetition'].includes(i.category))
    .slice(0, 4)
    .map((i) => `"${String(i.snippet || '').slice(0, 90)}"`)
}

async function downloadAnalysisReport(format) {
  if (!doc.value?.id) return
  if (reportEl.value) reportEl.value.open = false
  try {
    const base = (doc.value.title || 'dokumen').replace(/[^\p{L}\p{N}\- ]+/gu, '').trim().slice(0, 60) || 'dokumen'
    const ext = format === 'annotated' ? (preservation.value?.format || 'pdf') : format
    const name = format === 'annotated' ? `${base}-annotated.${ext}` : `${base}-analysis-report.${ext}`
    await downloadFile(`/api/documents/${doc.value.id}/analysis-report?format=${format}`, name)
    say(`Laporan analisis (${format.toUpperCase()}) berhasil diunduh.`)
  } catch (e) {
    fail(e.message || 'Gagal mengunduh laporan analisis.')
  }
}

async function loadPreservation(id = doc.value?.id) {
  if (!id) return
  try {
    preservation.value = await api(`/api/documents/${id}/preservation`)
  } catch {
    preservation.value = null
  }
}

// Refs untuk animasi sliding pill pada sub-navbar
const navContainerRef = ref(null)
const navBtnMap = new Map()
const pillStyle = ref({ width: '0px', transform: 'translateX(0px)', opacity: 0 })

function setNavBtnRef(id, el) {
  if (el) navBtnMap.set(id, el)
  else navBtnMap.delete(id)
}

function updatePillPosition() {
  const el = navBtnMap.get(activeSection.value)
  if (!el || !navContainerRef.value) return
  pillStyle.value = {
    width: `${el.offsetWidth}px`,
    transform: `translateX(${el.offsetLeft}px)`,
    opacity: 1,
  }
}

async function hydrate(id = route.params.id || draft.value?.document?.id) {
  if (!id) { router.replace('/analisis'); return }
  if (draft.value?.document?.id === id && draft.value?.issues) {
    loading.value = false
    nextTick(updatePillPosition)
    return
  }
  loading.value = true
  try {
    const fresh = await documents.get(id)
    draft.value = fresh
    documents.setCurrent(fresh)
    loadError.value = ''
  } catch (e) {
    loadError.value = e.message || 'Hasil tidak bisa dimuat.'
    if (draft.value?.document?.id !== id) draft.value = null
  } finally {
    loading.value = false
    nextTick(updatePillPosition)
  }
}

onMounted(async () => {
  window.addEventListener('resize', updatePillPosition)
  await hydrate()
  await loadPreservation()
  auth.refreshProfile()
  nextTick(updatePillPosition)
})

onBeforeUnmount(() => {
  window.removeEventListener('resize', updatePillPosition)
})

watch(() => route.params.id, (id) => {
  if (id && id !== draft.value?.document?.id) {
    selected.value = null
    filter.value = null
    hydrate(id)
  }
})

const doc = computed(() => draft.value?.document)
const analysis = computed(() => draft.value?.analysis)
const stats = computed(() => analysis.value?.stats || {})
const issues = computed(() => draft.value?.issues || [])
const statusOf = (i) => i.decision || 'active'
const decided = computed(() => issues.value.filter((i) => statusOf(i) !== 'active'))
const appliedIssues = computed(() => issues.value.filter((i) => statusOf(i) === 'applied'))
const activeSafeIssues = computed(() => issues.value.filter((i) => statusOf(i) === 'active' && !i.needs_manual_review))
const visible = computed(() => issues.value.filter((i) => !filter.value || canon(i.category || i.type) === filter.value))
const revised = computed(() => doc.value?.revised_text || draft.value?.revised_text || doc.value?.original_text || '')
const hasFix = computed(() => Boolean(revised.value) && revised.value !== (doc.value?.original_text || ''))
const tokenCost = computed(() => doc.value?.token_cost || draft.value?.meta?.token_cost || analysis.value?.token_cost || 1)

const navItems = computed(() => [
  { id: 'tulisan-asli', label: 'Teks Asli', icon: 'fa-file-lines', count: null },
  { id: 'perbaikan', label: 'Perbaikan', icon: 'fa-wand-magic-sparkles', count: appliedIssues.value.length },
  { id: 'ringkasan', label: 'Ringkasan', icon: 'fa-chart-simple', count: null },
])

watch([activeSection, () => issues.value.length, () => appliedIssues.value.length], () => {
  nextTick(updatePillPosition)
})

const summary = computed(() => {
  const map = new Map()
  for (const i of issues.value) {
    const k = canon(i.category || i.type)
    map.set(k, (map.get(k) || 0) + 1)
  }
  return [...map.entries()].map(([type, count]) => ({ type, count }))
})

const scores = computed(() => stats.value.scores || {})
const scoresList = computed(() => ['similarity', 'ai_usage']
  .map((key) => ({ key, ...(scores.value[key] || {}) }))
  .filter((m) => Number.isFinite(m.percent)))
const similarityReport = computed(() => stats.value.similarity_report || null)
const citationReport = computed(() => stats.value.citation_report || null)
const ocrReport = computed(() => stats.value.ocr_report || null)

const figures = computed(() => [
  { label: 'Kata', value: stats.value.word_count ?? doc.value?.word_count ?? 0 },
  { label: 'Paragraf', value: stats.value.paragraph_count ?? 0 },
  { label: 'Kalimat', value: stats.value.sentence_count ?? 0 },
  { label: 'Temuan', value: issues.value.length },
  { label: 'Biaya Analisis', value: `${tokenCost.value} Token` },
])

const progress = computed(() => (issues.value.length ? Math.round((decided.value.length / issues.value.length) * 100) : 100))
const busy = computed(() => busyAll.value || busyId.value !== null)
const bar = (v) => Math.max(0, Math.min(100, Number(v) || 0))
const numberOf = (i) => issues.value.indexOf(i) + 1
const narrow = () => window.innerWidth < 1024

function say(msg) {
  notice.value = msg
  clearTimeout(say.t)
  say.t = setTimeout(() => { notice.value = '' }, 3200)
}

function fail(msg) {
  error.value = msg
  clearTimeout(fail.t)
  fail.t = setTimeout(() => { error.value = '' }, 6000)
}

function sync(d) {
  draft.value = d
  documents.setCurrent(d)
}

function scrollWithin(el) {
  if (!el) return
  const box = el.closest('[data-scroll]')
  if (!box) return
  const top = el.getBoundingClientRect().top - box.getBoundingClientRect().top + box.scrollTop - (box.clientHeight - el.offsetHeight) / 2
  box.scrollTop = Math.max(0, top)
}

const goTo = (prefix, id) => scrollWithin(document.getElementById(prefix + id))

function jumpToSection(sectionId) {
  if (sectionId === 'ringkasan') {
    const nextState = activeSection.value === 'ringkasan' ? !showSummaryDrawer.value : true
    showSummaryDrawer.value = nextState
    showDownloadDrawer.value = false
    activeSection.value = nextState ? 'ringkasan' : (tab.value === 'perbaikan' ? 'perbaikan' : 'tulisan-asli')
  } else if (sectionId === 'unduh') {
    const nextState = activeSection.value === 'unduh' ? !showDownloadDrawer.value : true
    showDownloadDrawer.value = nextState
    showSummaryDrawer.value = false
    activeSection.value = nextState ? 'unduh' : (tab.value === 'perbaikan' ? 'perbaikan' : 'tulisan-asli')
  } else if (sectionId === 'tulisan-asli') {
    activeSection.value = 'tulisan-asli'
    tab.value = 'asli'
    pane.value = 'doc'
    showSummaryDrawer.value = false
    showDownloadDrawer.value = false
  } else if (sectionId === 'perbaikan') {
    activeSection.value = 'perbaikan'
    tab.value = 'perbaikan'
    pane.value = 'doc'
    showSummaryDrawer.value = false
    showDownloadDrawer.value = false
  } else if (sectionId === 'temuan') {
    activeSection.value = 'temuan'
    pane.value = 'temuan'
    showSummaryDrawer.value = false
    showDownloadDrawer.value = false
    temuanPulse.value = true
    clearTimeout(jumpToSection.t)
    jumpToSection.t = setTimeout(() => { temuanPulse.value = false }, 700)
  }

  nextTick(() => {
    updatePillPosition()
    if (sectionId === 'ringkasan' || sectionId === 'unduh') {
      const el = document.getElementById(sectionId)
      if (el) el.scrollIntoView({ behavior: 'smooth', block: 'nearest' })
    }
  })
}

function pickFromDoc(id) {
  selected.value = id
  if (narrow()) {
    pane.value = 'temuan'
    activeSection.value = 'temuan'
  }
  nextTick(() => goTo('s-', id))
}

function pickFromCard(id) {
  selected.value = id
  if (!narrow()) {
    tab.value = 'asli'
    nextTick(() => goTo('m-', id))
  }
}

function locate(id) {
  selected.value = id
  tab.value = 'asli'
  pane.value = 'doc'
  activeSection.value = 'tulisan-asli'
  nextTick(() => goTo('m-', id))
}

async function sendDecision(body, okMsg, id = null) {
  busyId.value = id
  busyAll.value = id === null
  try {
    const res = await documents.decide(doc.value.id, body)
    sync({
      ...draft.value,
      issues: res.issues,
      revised_text: res.revised_text,
      document: { ...doc.value, revised_text: res.revised_text, status: res.document?.status || doc.value.status },
    })
    say(okMsg)
  } catch (e) {
    fail(e.message || 'Gagal menyimpan keputusan.')
  } finally {
    busyId.value = null
    busyAll.value = false
  }
}

function accept(issue) {
  if (issue.needs_manual_review && !confirm('Saran ini ditandai PERLU CEK MANUAL karena berisiko mengubah makna. Terapkan tetap?')) return
  sendDecision({ decisions: [{ id: issue.id, decision: 'applied', confirm_manual: true }] }, 'Saran diterapkan.', issue.id)
}

function reject(issue) {
  sendDecision({ decisions: [{ id: issue.id, decision: 'rejected' }] }, 'Saran ditolak.', issue.id)
}

function resetIssue(issue) {
  sendDecision({ decisions: [{ id: issue.id, decision: 'active' }] }, 'Status saran dikembalikan ke aktif.', issue.id)
}

function acceptAll() {
  moreEl.value?.removeAttribute('open')
  if (!activeSafeIssues.value.length) {
    say('Tidak ada saran aman yang belum diterapkan.')
    return
  }
  sendDecision({ accept_all: true }, `${activeSafeIssues.value.length} saran aman diterapkan sekaligus.`)
}

async function restore() {
  moreEl.value?.removeAttribute('open')
  if (!decided.value.length) return
  if (!confirm('Pulihkan teks asli dan kembalikan semua keputusan saran menjadi aktif?')) return
  busyAll.value = true
  try {
    const res = await documents.restore(doc.value.id)
    const fresh = await documents.get(doc.value.id)
    sync({
      document: fresh.document,
      analysis: fresh.analysis,
      issues: fresh.issues,
      revised_text: res.revised_text,
      meta: fresh.meta || draft.value.meta,
    })
    say('Teks asli berhasil dipulihkan.')
  } catch (e) {
    fail(e.message)
  } finally {
    busyAll.value = false
  }
}

async function download(format) {
  dlEl.value?.removeAttribute('open')
  const bal = Math.max(0, Number(auth.user?.token_balance) || 0)
  if (bal < 1) {
    fail('Token Anda tidak mencukupi untuk mengunduh file ini. Silakan isi token terlebih dahulu.')
    return
  }
  try {
    const res = await documents.download(doc.value.id, format, `${doc.value.title}-revisi.${format}`)
    if (res?.status === 'cancelled') {
      say(res.message || 'Unduhan dibatalkan. Token Anda tidak dipotong.')
      return
    }
    if (res?.status === 'awaiting_confirmation') {
      pendingDownload.value = res
      say(res.message)
      return
    }
    if (res?.status === 'busy') {
      say(res.message)
      return
    }
    say(`Dokumen (.${format.toUpperCase()}) berhasil disimpan (-1 token).`)
  } catch (e) {
    fail(e.message || 'File gagal dibuat. Silakan coba kembali.')
  }
}

async function confirmPendingDownload() {
  if (!pendingDownload.value) return
  const { documentId, transactionId } = pendingDownload.value
  try {
    await documents.confirmDownload(documentId, transactionId)
    pendingDownload.value = null
    say('Unduhan dikonfirmasi (-1 token).')
  } catch (e) {
    fail(e.message || 'Konfirmasi unduhan belum berhasil. Status transaksi akan diperiksa kembali.')
  }
}

async function cancelPendingDownload() {
  if (!pendingDownload.value) return
  const { documentId, transactionId } = pendingDownload.value
  try {
    const res = await documents.cancelDownload(documentId, transactionId, 'user_cancelled_fallback')
    pendingDownload.value = null
    say(res?.message || 'Unduhan dibatalkan. Token Anda tidak dipotong.')
  } catch (e) {
    fail(e.message || 'Gagal membatalkan reservasi unduhan.')
  }
}

async function copyRevised() {
  moreEl.value?.removeAttribute('open')
  try {
    await navigator.clipboard.writeText(revised.value)
    say('Teks hasil perbaikan disalin ke clipboard.')
  } catch {
    fail('Gagal menyalin teks.')
  }
}
</script>

<template>
  <section v-if="loading" class="mx-auto max-w-6xl px-4 py-24 text-center font-mono text-sm uppercase tracking-widest sm:px-6">
    <i class="fa-solid fa-circle-notch fa-spin mr-2"></i>Memuat hasil analisis...
  </section>

  <section v-else-if="!draft || !doc" class="mx-auto max-w-3xl px-4 py-24 text-center sm:px-6">
    <p class="font-black uppercase tracking-tight">Hasil tidak ditemukan.</p>
    <p class="mt-2 text-sm text-black/60">{{ loadError || 'Dokumen mungkin sudah dihapus atau melewati masa retensi 30 hari.' }}</p>
    <div class="mt-8 flex flex-wrap justify-center gap-2">
      <BaseButton to="/riwayat">Buka Riwayat</BaseButton>
      <BaseButton variant="secondary" to="/analisis">Analisis Baru</BaseButton>
    </div>
  </section>

  <div v-else class="pb-16">
    <!-- Konfirmasi Penyimpanan Fallback (untuk browser tanpa File System Access API) -->
    <transition name="fade">
      <div
        v-if="pendingDownload"
        class="fixed bottom-20 right-5 z-50 max-w-md border-2 border-black bg-white p-4 text-black shadow-[4px_4px_0_#000]"
        role="dialog"
        aria-label="Konfirmasi penyimpanan unduhan"
      >
        <p class="font-mono text-[11px] font-bold uppercase tracking-wider text-[#FF3000]">Konfirmasi Unduhan (1 Token Direservasi)</p>
        <p class="mt-1.5 text-xs leading-relaxed text-black/80">
          Berkas <strong>{{ pendingDownload.filename }}</strong> telah dikirim ke browser. Konfirmasi jika berkas berhasil disimpan, atau batalkan agar token tidak dipotong.
        </p>
        <div class="mt-3 flex flex-wrap gap-2">
          <button
            type="button"
            class="swiss-snap border-2 border-black bg-black px-3 py-1.5 font-mono text-[11px] font-bold uppercase tracking-wider text-white hover:border-[#FF3000] hover:bg-[#FF3000]"
            @click="confirmPendingDownload"
          >
            Konfirmasi Tersimpan (-1 Token)
          </button>
          <button
            type="button"
            class="swiss-snap border-2 border-black bg-white px-3 py-1.5 font-mono text-[11px] font-bold uppercase tracking-wider text-black hover:bg-[#F2F2F2]"
            @click="cancelPendingDownload"
          >
            Batalkan
          </button>
        </div>
      </div>
    </transition>

    <!-- Toast Notifikasi Melayang (Tidak Menggeser Layout / Scroll) -->
    <transition name="fade">
      <div
        v-if="notice || error"
        class="fixed bottom-5 right-5 z-50 max-w-md border-2 border-black px-4 py-3"
        :class="error ? 'bg-[#FF3000] text-white' : 'bg-black text-white'"
        :role="error ? 'alert' : 'status'"
      >
        <div class="flex items-center gap-3 text-xs font-bold uppercase tracking-wide">
          <i :class="['fa-solid', error ? 'fa-triangle-exclamation text-white' : 'fa-circle-check text-[#FF3000]']"></i>
          <span>{{ error || notice }}</span>
          <button type="button" class="ml-auto pl-2 opacity-70 hover:opacity-100" @click="notice = ''; error = ''">
            <i class="fa-solid fa-xmark"></i>
          </button>
        </div>
      </div>
    </transition>

    <!-- SUB-NAVIGATION BAR BERANIMASI (SLIDING PILL INDICATOR) -->
    <div class="sticky top-16 z-30 border-b border-black/15 bg-white/95 backdrop-blur-md">
      <div class="mx-auto flex max-w-[1520px] flex-wrap items-center justify-between gap-3 px-4 py-2.5 sm:px-6 lg:px-8">
        <!-- Kiri: Kembali + Judul Dokumen Ringkas -->
        <div class="flex min-w-0 items-center gap-2.5">
          <router-link
            to="/analisis"
            class="swiss-snap flex h-9 w-9 shrink-0 items-center justify-center border border-black/25 bg-white text-xs hover:border-black hover:bg-black hover:text-white"
            title="Kembali ke Editor Analisis"
          >
            <i class="fa-solid fa-arrow-left"></i>
          </router-link>
          <div class="min-w-0">
            <h1 class="max-w-[180px] truncate text-sm font-black uppercase tracking-tight sm:max-w-[260px]" :title="doc.title">
              {{ doc.title }}
            </h1>
            <p class="font-mono text-[10px] uppercase tracking-wider text-black/50">
              {{ doc.word_count }} kata · {{ issues.length }} temuan
            </p>
          </div>
        </div>

        <!-- Tengah: Segmented Navigation dengan Sliding Pill Halus -->
        <nav
          ref="navContainerRef"
          aria-label="Navigasi ruang kerja hasil"
          class="relative flex max-w-full items-center overflow-x-auto border border-black/20 bg-[#F4F4F4] p-1"
        >
          <!-- Indikator Latar Hitam + Garis Aksen Oranye yang Meluncur Halus -->
          <span
            aria-hidden="true"
            class="swiss-pill-glide pointer-events-none absolute bottom-1 top-1 left-0 border-b-2 border-[#FF3000] bg-black"
            :style="pillStyle"
          ></span>

          <button
            v-for="item in navItems"
            :key="item.id"
            :ref="(el) => setNavBtnRef(item.id, el)"
            type="button"
            :aria-current="activeSection === item.id ? 'page' : undefined"
            :class="[
              'relative z-10 flex min-h-[34px] shrink-0 items-center gap-1.5 px-3.5 py-1 font-mono text-[11px] font-bold uppercase tracking-wider transition-colors duration-200',
              activeSection === item.id
                ? 'text-white'
                : 'text-black/65 hover:text-black',
            ]"
            @click="jumpToSection(item.id)"
          >
            <i
              :class="[
                'fa-solid text-[10px] transition-transform duration-200',
                item.icon,
                activeSection === item.id ? 'scale-110 text-[#FF3000]' : 'opacity-60',
              ]"
            ></i>
            <span>{{ item.label }}</span>
            <span
              v-if="item.count !== null"
              :class="[
                'ml-0.5 px-1.5 py-0.5 font-mono text-[9px] font-black leading-none tabular-nums transition-colors duration-200',
                activeSection === item.id
                  ? 'bg-[#FF3000] text-white'
                  : 'bg-black/10 text-black/75',
              ]"
            >
              {{ item.count }}
            </span>
          </button>
        </nav>

        <!-- Kanan: Tombol Utama + Menu Fitur Lainnya + Dropdown Unduh -->
        <div class="flex items-center gap-2">
          <button
            v-if="activeSafeIssues.length"
            type="button"
            :disabled="busy"
            class="swiss-snap min-h-[36px] border-2 border-[#FF3000] bg-[#FF3000] px-3 py-1 font-mono text-[11px] font-bold uppercase tracking-wider text-white hover:border-black hover:bg-black disabled:opacity-40"
            @click="acceptAll"
          >
            <i class="fa-solid fa-check-double mr-1"></i>Terapkan Semua
          </button>

          <!-- Dropdown Download Analysis Report -->
          <details ref="reportEl" class="relative">
            <summary class="summary-plain swiss-snap flex min-h-[36px] cursor-pointer list-none items-center gap-1.5 border-2 border-black bg-white px-3 py-1 font-mono text-[11px] font-bold uppercase tracking-wider text-black hover:bg-black hover:text-white">
              <i class="fa-solid fa-file-shield text-[10px] text-[#FF3000]"></i>Download Analysis Report<i class="fa-solid fa-chevron-down text-[9px]"></i>
            </summary>
            <div class="absolute right-0 z-40 mt-1 w-56 border-2 border-black bg-white">
              <div class="border-b border-black/10 bg-[#F2F2F2] px-3 py-1.5 font-mono text-[10px] uppercase tracking-wider text-black/55">
                Laporan Analisis Terpisah
              </div>
              <button
                type="button"
                class="flex w-full items-center justify-between gap-2 border-b border-black/10 px-3 py-2.5 text-left font-mono text-[11px] font-bold uppercase tracking-wider hover:bg-black hover:text-white"
                @click="downloadAnalysisReport('pdf')"
              >
                <span>PDF Report</span>
                <i class="fa-regular fa-file-pdf text-[#FF3000]"></i>
              </button>
              <button
                type="button"
                class="flex w-full items-center justify-between gap-2 border-b border-black/10 px-3 py-2.5 text-left font-mono text-[11px] font-bold uppercase tracking-wider hover:bg-black hover:text-white"
                @click="downloadAnalysisReport('docx')"
              >
                <span>DOCX Report</span>
                <i class="fa-regular fa-file-word text-blue-700"></i>
              </button>
              <button
                v-if="preservation?.has_original_file"
                type="button"
                class="flex w-full items-center justify-between gap-2 px-3 py-2.5 text-left font-mono text-[11px] font-bold uppercase tracking-wider hover:bg-black hover:text-white"
                @click="downloadAnalysisReport('annotated')"
              >
                <span>Annotated Original</span>
                <i class="fa-solid fa-highlighter text-amber-600"></i>
              </button>
            </div>
          </details>

          <!-- Dropdown Unduh (1 Token) -->
          <details ref="dlEl" class="relative">
            <summary class="summary-plain swiss-snap flex min-h-[36px] cursor-pointer list-none items-center gap-1.5 border-2 border-black bg-black px-3 py-1 font-mono text-[11px] font-bold uppercase tracking-wider text-white hover:border-[#FF3000] hover:bg-[#FF3000]">
              <i class="fa-solid fa-download text-[10px]"></i>Unduh<i class="fa-solid fa-chevron-down text-[9px]"></i>
            </summary>
            <div class="absolute right-0 z-40 mt-1 w-52 border-2 border-black bg-white">
              <div class="border-b border-black/10 bg-[#F2F2F2] px-3 py-1.5 font-mono text-[10px] uppercase tracking-wider text-black/55">
                Ekspor Revisi · 1 Token
              </div>
              <button
                v-for="f in ['pdf', 'docx', 'txt']"
                :key="f"
                type="button"
                class="flex w-full items-center justify-between gap-2 border-b border-black/10 px-3 py-2.5 text-left font-mono text-[11px] font-bold uppercase tracking-widest last:border-b-0 hover:bg-black hover:text-white"
                @click="download(f)"
              >
                <span>Format .{{ f.toUpperCase() }}</span>
                <span class="text-[#FF3000]">1 Token</span>
              </button>
            </div>
          </details>

          <!-- Menu Alat Tambahan -->
          <details ref="moreEl" class="relative">
            <summary
              class="summary-plain swiss-snap flex h-9 w-9 cursor-pointer list-none items-center justify-center border-2 border-black bg-white text-xs text-black hover:bg-black hover:text-white"
              title="Menu fitur lainnya"
              aria-label="Menu fitur lainnya"
            >
              <i class="fa-solid fa-ellipsis-vertical"></i>
            </summary>
            <div class="absolute right-0 z-40 mt-1 w-56 border-2 border-black bg-white">
              <button
                type="button"
                class="flex w-full items-center gap-2.5 border-b border-black/10 px-3.5 py-2.5 text-left font-mono text-[11px] font-bold uppercase tracking-wider hover:bg-[#F2F2F2]"
                @click="copyRevised"
              >
                <i class="fa-regular fa-copy w-4 text-center"></i>Salin Teks Perbaikan
              </button>
              <router-link
                :to="`/bandingkan/${doc.id}`"
                class="flex w-full items-center gap-2.5 border-b border-black/10 px-3.5 py-2.5 text-left font-mono text-[11px] font-bold uppercase tracking-wider hover:bg-[#F2F2F2]"
              >
                <i class="fa-solid fa-code-compare w-4 text-center"></i>Bandingkan Asli vs Revisi
              </router-link>
              <router-link
                :to="`/dokumen/${doc.id}`"
                class="flex w-full items-center gap-2.5 border-b border-black/10 px-3.5 py-2.5 text-left font-mono text-[11px] font-bold uppercase tracking-wider hover:bg-[#F2F2F2]"
              >
                <i class="fa-solid fa-pen w-4 text-center"></i>Ganti Judul / Detail
              </router-link>
              <button
                v-if="decided.length"
                type="button"
                :disabled="busy"
                class="flex w-full items-center gap-2.5 border-b border-black/10 px-3.5 py-2.5 text-left font-mono text-[11px] font-bold uppercase tracking-wider text-[#FF3000] hover:bg-[#F2F2F2]"
                @click="restore"
              >
                <i class="fa-solid fa-rotate-left w-4 text-center"></i>Pulihkan Teks Asli
              </button>
              <router-link
                to="/riwayat"
                class="flex w-full items-center gap-2.5 px-3.5 py-2.5 text-left font-mono text-[11px] font-bold uppercase tracking-wider hover:bg-[#F2F2F2]"
              >
                <i class="fa-solid fa-clock-rotate-left w-4 text-center"></i>Semua Riwayat
              </router-link>
            </div>
          </details>
        </div>
      </div>
    </div>

    <section class="mx-auto max-w-[1520px] px-4 pt-5 sm:px-6 lg:px-8">
      <!-- Bar Ringkasan Satu Baris yang Bersih & Minimalis -->
      <div class="flex flex-wrap items-center justify-between gap-3 border border-black/15 bg-[#F8F8F8] px-4 py-2.5">
        <div class="flex flex-wrap items-center gap-x-6 gap-y-1 font-mono text-xs uppercase tracking-wider">
          <span v-for="m in scoresList" :key="m.key" class="flex items-center gap-1.5">
            <span class="h-2.5 w-2.5 shrink-0" :style="{ backgroundColor: formatThresholdScore(m).color }"></span>
            <span class="text-black/55">{{ m.label }}:</span>
            <strong class="text-sm font-black tabular-nums" :style="{ color: formatThresholdScore(m).color }">
              {{ formatThresholdScore(m).display }}
            </strong>
            <span
              class="px-1.5 py-0.5 text-[9px] font-bold uppercase tracking-wider"
              :style="{ backgroundColor: formatThresholdScore(m).bg, color: formatThresholdScore(m).color }"
            >
              {{ formatThresholdScore(m).safe ? 'Aman' : 'Tinjau' }}
            </span>
          </span>
          <span class="hidden text-black/20 sm:inline">|</span>
          <span>
            <span class="text-black/55">Ditinjau:</span>
            <strong class="ml-1 font-black tabular-nums">{{ decided.length }}/{{ issues.length }}</strong>
          </span>
          <span>
            <span class="text-black/55">Diterapkan:</span>
            <strong class="ml-1 font-black tabular-nums text-[#FF3000]">{{ appliedIssues.length }}</strong>
          </span>
        </div>

        <button
          type="button"
          class="swiss-snap-fast font-mono text-[11px] font-bold uppercase tracking-widest text-black/80 underline decoration-[#FF3000] decoration-2 underline-offset-4 hover:text-[#FF3000]"
          @click="jumpToSection('ringkasan')"
        >
          {{ showSummaryDrawer ? 'Sembunyikan Rincian Analisis' : 'Buka Rincian Analisis' }}
        </button>
      </div>

      <!-- PANEL RINGKASAN & RINCIAN ANALISIS -->
      <div id="ringkasan" class="scroll-mt-32">
        <transition name="drawer-slide">
          <div v-if="showSummaryDrawer" class="mt-4 border-2 border-black bg-white p-5">
            <div class="flex items-center justify-between border-b-2 border-black/10 pb-3">
              <p class="font-mono text-xs font-bold uppercase tracking-widest text-[#FF3000]">Ringkasan & Rincian Analisis</p>
              <button type="button" class="font-mono text-[10px] font-bold uppercase tracking-widest text-black/50 hover:text-black" @click="jumpToSection('ringkasan')">
                Tutup ✕
              </button>
            </div>

            <dl class="mt-4 grid grid-cols-2 gap-3 sm:grid-cols-5">
              <div v-for="f in figures" :key="f.label" class="border border-black/15 bg-[#F2F2F2] px-3.5 py-2.5">
                <dt class="font-mono text-[10px] uppercase tracking-widest text-black/50">{{ f.label }}</dt>
                <dd class="mt-1 text-lg font-black tabular-nums">{{ f.value }}</dd>
              </div>
            </dl>

            <div class="mt-4 grid gap-4 sm:grid-cols-2">
              <div v-for="m in scoresList" :key="m.key" class="border-2 border-black p-4">
                <div class="flex items-start justify-between gap-3">
                  <div>
                    <p class="font-mono text-xs font-bold uppercase tracking-widest text-black/70">{{ m.label }}</p>
                    <span
                      class="mt-1 inline-flex items-center gap-1.5 border border-black/15 px-2 py-0.5 font-mono text-[10px] font-bold uppercase tracking-wider"
                      :style="{ backgroundColor: formatThresholdScore(m).bg, color: formatThresholdScore(m).color }"
                    >
                      <span class="h-2 w-2 shrink-0" :style="{ backgroundColor: formatThresholdScore(m).color }"></span>
                      {{ formatThresholdScore(m).badge }}
                    </span>
                  </div>
                  <p class="text-3xl font-black leading-none tabular-nums" :style="{ color: formatThresholdScore(m).color }">
                    {{ formatThresholdScore(m).display }}
                  </p>
                </div>
                <div class="mt-2.5 h-1.5 w-full bg-black/10" role="progressbar" :aria-label="m.label" :aria-valuenow="bar(m.percent)" aria-valuemin="0" aria-valuemax="100">
                  <div class="h-full" :style="{ width: bar(m.percent) + '%', backgroundColor: formatThresholdScore(m).color }"></div>
                </div>
                <p class="mt-2 text-xs leading-relaxed text-black/70">{{ formatThresholdScore(m).note }}</p>

                <!-- Bagian teks yang memenuhi kriteria indikator (hanya ditampilkan bila >= 20%) -->
                <div v-if="formatThresholdScore(m).showPassages && passagesForMetric(m.key).length" class="mt-2.5 border-l-4 pl-3" :style="{ borderColor: formatThresholdScore(m).color }">
                  <p class="font-mono text-[10px] font-bold uppercase tracking-wider text-black/60">Bagian teks yang memenuhi kriteria:</p>
                  <ul class="mt-1 space-y-1 text-xs text-black/80">
                    <li v-for="(p, idx) in passagesForMetric(m.key)" :key="idx" class="truncate">• {{ p }}</li>
                  </ul>
                </div>

                <details v-if="m.signals?.length" class="mt-2.5" open>
                  <summary class="summary-plain inline-flex cursor-pointer items-center gap-1.5 py-1 font-mono text-[10px] font-bold uppercase tracking-widest text-black/65 hover:text-black">
                    <i class="fa-solid fa-chevron-down text-[9px] text-[#FF3000]"></i>Rincian analisis
                  </summary>
                  <ul class="mt-2 space-y-2 border-t border-black/10 pt-2">
                    <li v-for="s in m.signals" :key="s.key">
                      <div class="flex items-center justify-between gap-2 font-mono text-[10px] uppercase tracking-wider text-black/75">
                        <span class="flex min-w-0 items-center gap-1.5 truncate">
                          <span class="h-2 w-2 shrink-0" :style="{ backgroundColor: signalColor(m.key, s.percent).color }"></span>
                          <span class="truncate">{{ s.label }}</span>
                        </span>
                        <span class="flex shrink-0 items-center gap-1.5 tabular-nums font-bold" :style="{ color: signalColor(m.key, s.percent).color }">
                          <span>{{ signalColor(m.key, s.percent).display }}</span>
                          <span class="px-1 py-0.5 text-[9px]" :style="{ backgroundColor: signalColor(m.key, s.percent).bg }">
                            {{ signalColor(m.key, s.percent).tag }}
                          </span>
                        </span>
                      </div>
                      <div class="mt-1 h-1 w-full bg-black/10">
                        <div class="h-full" :style="{ width: bar(s.percent) + '%', backgroundColor: signalColor(m.key, s.percent).color }"></div>
                      </div>
                    </li>
                  </ul>
                </details>
              </div>
            </div>

            <!-- LAPORAN ORISINALITAS, SITASI, & PRESERVASI DOKUMEN -->
            <div class="mt-4 grid gap-4 lg:grid-cols-3">
              <!-- Orisinalitas & Kemiripan -->
              <div v-if="similarityReport" class="border-2 border-black p-4">
                <p class="font-mono text-xs font-bold uppercase tracking-widest text-[#FF3000]">Orisinalitas & Kemiripan</p>
                <p class="mt-2 text-xs leading-relaxed text-black/65">{{ similarityReport.scope_note }}</p>
                <dl class="mt-3 grid grid-cols-2 gap-2 font-mono text-[10px] uppercase">
                  <div class="border border-black/15 bg-[#F8F8F8] p-2">
                    <dt class="text-black/50">Total Temuan</dt>
                    <dd class="mt-0.5 text-sm font-black">{{ similarityReport.summary?.total_findings ?? 0 }}</dd>
                  </div>
                  <div class="border border-black/15 bg-[#F8F8F8] p-2">
                    <dt class="text-black/50">Tanpa Sitasi</dt>
                    <dd class="mt-0.5 text-sm font-black text-[#FF3000]">{{ similarityReport.summary?.unattributed_overlaps ?? 0 }}</dd>
                  </div>
                  <div class="border border-black/15 bg-[#F8F8F8] p-2">
                    <dt class="text-black/50">Parafrase Dekat</dt>
                    <dd class="mt-0.5 text-sm font-black">{{ similarityReport.summary?.close_paraphrases ?? 0 }}</dd>
                  </div>
                  <div class="border border-black/15 bg-[#F8F8F8] p-2">
                    <dt class="text-black/50">Kutipan Langsung</dt>
                    <dd class="mt-0.5 text-sm font-black">{{ similarityReport.summary?.direct_quotations ?? 0 }}</dd>
                  </div>
                </dl>
                <ul v-if="similarityReport.findings?.length" class="mt-3 max-h-40 space-y-2 overflow-y-auto border-t border-black/10 pt-2 text-xs">
                  <li v-for="(f, idx) in similarityReport.findings.slice(0, 5)" :key="idx" class="border-l-2 border-black pl-2">
                    <p class="font-mono text-[10px] font-bold uppercase text-black/60">{{ f.category }} · {{ f.source_info }}</p>
                    <p class="mt-0.5 text-black/85">{{ f.explanation }}</p>
                  </li>
                </ul>
              </div>

              <!-- Validasi Sitasi & Daftar Pustaka -->
              <div v-if="citationReport" class="border-2 border-black p-4">
                <p class="font-mono text-xs font-bold uppercase tracking-widest text-[#FF3000]">Sitasi & Daftar Pustaka</p>
                <dl class="mt-3 grid grid-cols-2 gap-2 font-mono text-[10px] uppercase">
                  <div class="border border-black/15 bg-[#F8F8F8] p-2">
                    <dt class="text-black/50">Gaya Terdeteksi</dt>
                    <dd class="mt-0.5 text-sm font-black">{{ citationReport.detected_style }}</dd>
                  </div>
                  <div class="border border-black/15 bg-[#F8F8F8] p-2">
                    <dt class="text-black/50">Sitasi / Pustaka</dt>
                    <dd class="mt-0.5 text-sm font-black">{{ citationReport.in_text_count }} / {{ citationReport.bibliography_count }}</dd>
                  </div>
                  <div class="border border-black/15 bg-[#F8F8F8] p-2">
                    <dt class="text-black/50">Pustaka Hilang</dt>
                    <dd class="mt-0.5 text-sm font-black text-[#FF3000]">{{ citationReport.missing_references?.length ?? 0 }}</dd>
                  </div>
                  <div class="border border-black/15 bg-[#F8F8F8] p-2">
                    <dt class="text-black/50">Tidak Dikutip / Duplikat</dt>
                    <dd class="mt-0.5 text-sm font-black">{{ (citationReport.unused_references?.length ?? 0) + (citationReport.duplicate_references?.length ?? 0) }}</dd>
                  </div>
                </dl>
                <p class="mt-2.5 text-xs text-black/65">
                  <i class="fa-solid fa-shield-halved mr-1 text-black"></i>
                  Bagian Daftar Pustaka dilindungi dari penulisan ulang otomatis.
                </p>
              </div>

              <!-- Status Preservasi Dokumen -->
              <div class="border-2 border-black p-4">
                <p class="font-mono text-xs font-bold uppercase tracking-widest text-[#FF3000]">Preservasi Dokumen</p>
                <p v-if="preservation" class="mt-2 text-xs leading-relaxed text-black/70">{{ preservation.note }}</p>
                <ul v-if="preservation?.checks" class="mt-3 space-y-1.5 font-mono text-[10px] uppercase">
                  <li v-for="(ok, key) in preservation.checks" :key="key" class="flex items-center justify-between border-b border-black/10 pb-1">
                    <span class="text-black/70">{{ key.replace(/_/g, ' ') }}</span>
                    <span :class="ok ? 'font-bold text-green-700' : 'font-bold text-[#FF3000]'">
                      {{ ok ? 'TERVERIFIKASI' : 'TIDAK DIKONFIRMASI' }}
                    </span>
                  </li>
                </ul>
                <p v-else class="mt-2 text-xs text-black/50">
                  Unggah berkas .DOCX asli untuk preservasi tata letak, font, tabel, gambar, dan header/footer secara utuh.
                </p>
                <div v-if="ocrReport?.ocr_applied" class="mt-3 border-t border-black/15 pt-2.5 text-xs">
                  <p class="font-mono text-[10px] font-bold uppercase tracking-widest text-black/70">
                    OCR PDF Pindai ({{ ocrReport.language }}) · Keyakinan {{ ocrReport.average_confidence }}%
                  </p>
                  <p v-if="ocrReport.needs_user_verification" class="mt-1 text-[#FF3000]">
                    <i class="fa-solid fa-triangle-exclamation mr-1"></i>
                    {{ ocrReport.uncertain_segments?.length || 0 }} baris hasil OCR memiliki keyakinan rendah — periksa angka, nama, dan istilah teknis secara manual.
                  </p>
                </div>
              </div>
            </div>

            <!-- Warna Laporan Analisis -->
            <div class="mt-4 border border-black/20 bg-[#FAFAFA] p-3.5">
              <p class="font-mono text-[10px] font-bold uppercase tracking-widest text-black/65">Warna Laporan Analisis</p>
              <div class="mt-2 flex flex-wrap gap-2">
                <span
                  v-for="item in REPORT_COLORS"
                  :key="item.label"
                  class="inline-flex items-center gap-1.5 border border-black/15 px-2 py-1 font-mono text-[10px] font-bold uppercase"
                  :style="{ backgroundColor: item.bg, color: item.text }"
                >
                  <span class="h-2 w-2 shrink-0" :style="{ backgroundColor: item.color }"></span>
                  {{ item.label }}
                </span>
              </div>
            </div>
          </div>
        </transition>
      </div>

      <!-- PANEL UNDUH CEPAT -->
      <div id="unduh" class="scroll-mt-32">
        <transition name="drawer-slide">
          <div v-if="showDownloadDrawer" class="mt-4 flex flex-col gap-4 border-2 border-black bg-black p-5 text-white sm:flex-row sm:items-center sm:justify-between">
            <div>
              <p class="font-mono text-[10px] uppercase tracking-widest text-[#FF3000]">Ekspor Dokumen · 1 Token per Unduhan</p>
              <h2 class="mt-1 text-lg font-black uppercase tracking-tight">Unduh Naskah Hasil Revisi ({{ appliedIssues.length }} Saran Diterapkan)</h2>
            </div>
            <div class="flex flex-wrap items-center gap-2">
              <router-link
                v-if="(auth.user?.token_balance || 0) < 1"
                to="/token"
                class="border-2 border-[#FF3000] bg-[#FF3000] px-3.5 py-2 font-mono text-xs font-bold uppercase tracking-widest text-white"
              >
                + Isi Token
              </router-link>
              <button
                v-for="f in ['pdf', 'docx', 'txt']"
                :key="f"
                type="button"
                class="swiss-snap border-2 border-white px-4 py-2 font-mono text-xs font-bold uppercase tracking-widest text-white hover:border-[#FF3000] hover:bg-[#FF3000]"
                @click="download(f)"
              >
                .{{ f.toUpperCase() }} · 1 Token
              </button>
              <button type="button" class="ml-2 font-mono text-xs text-white/60 hover:text-white" @click="jumpToSection('unduh')">
                ✕
              </button>
            </div>
          </div>
        </transition>
      </div>

      <!-- RUANG KERJA UTAMA: 2 KOLOM BERSIH (DOKUMEN DI KIRI, TEMUAN DI KANAN) -->
      <div class="mt-4 grid gap-5 lg:grid-cols-[minmax(0,1.65fr)_minmax(350px,1fr)] lg:items-start">
        <!-- Kolom Kiri: Pembaca Dokumen (Teks Asli Bersorotan / Hasil Perbaikan) -->
        <div
          id="tulisan-asli"
          class="scroll-mt-32 flex min-w-0 flex-col border border-black/25 bg-white lg:sticky lg:top-[7.75rem] lg:h-[calc(100vh-8.75rem)] lg:min-h-[540px]"
        >
          <div id="perbaikan" class="flex flex-wrap items-center justify-between gap-2 border-b border-black/15 bg-[#F8F8F8] px-4 py-2.5">
            <div class="flex items-center gap-2">
              <span class="h-2 w-2 bg-[#FF3000]"></span>
              <span class="font-mono text-xs font-black uppercase tracking-wider">
                {{ tab === 'asli' ? 'Tulisan Asli (Bersorotan)' : `Hasil Perbaikan (${appliedIssues.length} Diterapkan)` }}
              </span>
            </div>

            <button
              v-if="tab === 'perbaikan'"
              type="button"
              class="swiss-snap border border-black bg-white px-2.5 py-1 font-mono text-[10px] font-bold uppercase tracking-widest hover:bg-black hover:text-white"
              @click="copyRevised"
            >
              <i class="fa-regular fa-copy mr-1"></i>Salin
            </button>
            <span v-else class="font-mono text-[10px] uppercase tracking-widest text-black/45">
              Klik sorotan warna untuk memilih saran
            </span>
          </div>

          <div data-scroll class="min-h-0 flex-1 overflow-y-auto">
            <div class="px-6 py-8 sm:px-12 sm:py-10">
              <div class="mx-auto max-w-[84ch]">
                <transition name="view-slide" mode="out-in">
                  <div v-if="tab === 'asli'" key="asli">
                    <HighlightedText :text="doc.original_text" :issues="issues" :stats="stats" :selected="selected" @pick="pickFromDoc" />
                  </div>
                  <div v-else key="perbaikan">
                    <pre class="whitespace-pre-wrap break-words font-sans text-[16px] leading-[1.9] text-black">{{ revised }}</pre>
                    <div v-if="!hasFix" class="mt-8 flex flex-wrap items-center justify-between gap-3 border-t-2 border-black/15 bg-[#F2F2F2] px-4 py-3 text-xs">
                      <span class="font-medium text-black/70">Belum ada saran yang diterapkan.</span>
                      <button
                        v-if="activeSafeIssues.length"
                        type="button"
                        class="swiss-snap border border-black bg-black px-3 py-1.5 font-mono text-[10px] font-bold uppercase tracking-widest text-white hover:border-[#FF3000] hover:bg-[#FF3000]"
                        @click="acceptAll"
                      >
                        Terapkan Semua Saran Aman
                      </button>
                    </div>
                  </div>
                </transition>
              </div>
            </div>
          </div>
        </div>

        <!-- Kolom Kanan: Panel Temuan -->
        <aside
          id="temuan"
          :class="[
            'scroll-mt-32 flex min-w-0 flex-col border bg-white transition-colors duration-300 lg:sticky lg:top-[7.75rem] lg:h-[calc(100vh-8.75rem)] lg:min-h-[540px]',
            temuanPulse ? 'border-2 border-[#FF3000]' : 'border-black/25',
          ]"
        >
          <!-- Header Temuan + Filter Kategori -->
          <div class="flex items-center justify-between gap-2 border-b border-black/15 bg-[#F8F8F8] px-3.5 py-2.5">
            <div class="flex items-center gap-2">
              <h2 class="font-mono text-xs font-black uppercase tracking-wider">
                Temuan ({{ visible.length }}/{{ issues.length }})
              </h2>
            </div>

            <div v-if="summary.length" class="flex items-center gap-1.5">
              <label for="category-filter" class="sr-only">Filter kategori</label>
              <select
                id="category-filter"
                :value="filter || ''"
                class="h-8 border border-black bg-white px-2 font-mono text-[10px] font-bold uppercase tracking-wider text-black focus:outline-none"
                @change="filter = $event.target.value || null"
              >
                <option value="">Semua Kategori ({{ issues.length }})</option>
                <option v-for="s in summary" :key="s.type" :value="s.type">
                  {{ CATEGORIES[s.type].label }} ({{ s.count }})
                </option>
              </select>
            </div>
          </div>

          <!-- Progress Bar Tipis -->
          <div v-if="issues.length" class="h-1 w-full bg-black/10" role="progressbar" aria-label="Progres keputusan" :aria-valuenow="progress" aria-valuemin="0" aria-valuemax="100">
            <div class="h-full bg-[#FF3000] transition-[width] duration-300" :style="{ width: progress + '%' }"></div>
          </div>

          <!-- Daftar Kartu Saran -->
          <div data-scroll class="min-h-0 flex-1 space-y-2.5 overflow-y-auto p-3">
            <SuggestionCard
              v-for="i in visible"
              :key="i.id"
              :issue="i"
              :index="numberOf(i)"
              :selected="selected === i.id"
              :busy="busy"
              @pick="pickFromCard"
              @locate="locate"
              @accept="accept"
              @reject="reject"
              @reset="resetIssue"
            />
            <div v-if="!visible.length" class="border border-black/15 bg-[#F2F2F2] px-4 py-10 text-center">
              <i class="fa-regular fa-circle-check mb-2 block text-2xl"></i>
              <p class="text-xs font-bold uppercase leading-relaxed tracking-wide">
                {{ issues.length ? 'Tidak ada temuan di kategori ini.' : 'Tidak ada masalah pola tulisan pada dokumen ini.' }}
              </p>
              <button
                v-if="filter"
                type="button"
                class="mt-3 font-mono text-[10px] font-bold uppercase tracking-widest underline decoration-[#FF3000] decoration-2 underline-offset-4"
                @click="filter = null"
              >
                Tampilkan semua kategori
              </button>
            </div>
          </div>
        </aside>
      </div>
    </section>
  </div>
</template>
