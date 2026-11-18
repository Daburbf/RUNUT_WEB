<script setup>
import { ref, computed, onMounted, onBeforeUnmount, watch, nextTick } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import BaseButton from '../components/BaseButton.vue'
import HighlightedText from '../components/HighlightedText.vue'
import SuggestionCard from '../components/SuggestionCard.vue'
import { documents } from '../store/documents'
import { auth } from '../store/auth'
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
const dlEl = ref(null)
const moreEl = ref(null)

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
  { id: 'temuan', label: 'Temuan', icon: 'fa-list-check', count: issues.value.length },
  { id: 'ringkasan', label: 'Ringkasan', icon: 'fa-chart-simple', count: null },
  { id: 'unduh', label: 'Unduh', icon: 'fa-download', count: null },
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
    fail('Saldo token tidak mencukupi untuk mengunduh dokumen (butuh 1 token). Silakan isi token terlebih dahulu.')
    return
  }
  try {
    await documents.download(doc.value.id, format, `${doc.value.title}-revisi.${format}`)
    say(`Dokumen (.${format.toUpperCase()}) berhasil diunduh (-1 token).`)
  } catch (e) {
    fail(e.message)
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
            <span class="text-black/55">{{ m.label }}:</span>
            <strong class="text-sm font-black tabular-nums text-black">{{ m.percent }}%</strong>
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
                <div class="flex items-baseline justify-between gap-4">
                  <p class="font-mono text-xs font-bold uppercase tracking-widest text-black/70">{{ m.label }}</p>
                  <p class="text-3xl font-black leading-none tabular-nums">{{ m.percent }}<span class="text-base">%</span></p>
                </div>
                <div class="mt-2.5 h-1.5 w-full bg-black/10" role="progressbar" :aria-label="m.label" :aria-valuenow="bar(m.percent)" aria-valuemin="0" aria-valuemax="100">
                  <div class="h-full bg-[#FF3000]" :style="{ width: bar(m.percent) + '%' }"></div>
                </div>
                <p class="mt-2 text-xs leading-relaxed text-black/60">{{ m.note }}</p>
                <details v-if="m.signals?.length" class="mt-2.5" open>
                  <summary class="summary-plain inline-flex cursor-pointer items-center gap-1.5 py-1 font-mono text-[10px] font-bold uppercase tracking-widest text-black/65 hover:text-black">
                    <i class="fa-solid fa-chevron-down text-[9px] text-[#FF3000]"></i>Rincian analisis
                  </summary>
                  <ul class="mt-2 space-y-2 border-t border-black/10 pt-2">
                    <li v-for="s in m.signals" :key="s.key">
                      <div class="flex justify-between gap-2 font-mono text-[10px] uppercase tracking-wider text-black/65">
                        <span class="min-w-0 truncate">{{ s.label }}</span><span class="shrink-0 tabular-nums">{{ s.percent }}%</span>
                      </div>
                      <div class="mt-1 h-1 w-full bg-black/10"><div class="h-full bg-black/55" :style="{ width: bar(s.percent) + '%' }"></div></div>
                    </li>
                  </ul>
                </details>
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
          :class="[
            pane === 'doc' ? 'flex' : 'hidden lg:flex',
            'scroll-mt-32 min-w-0 flex-col border border-black/25 bg-white lg:sticky lg:top-[7.75rem] lg:h-[calc(100vh-8.75rem)] lg:min-h-[540px]',
          ]"
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
                    <HighlightedText :text="doc.original_text" :issues="issues" :selected="selected" @pick="pickFromDoc" />
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
            pane === 'temuan' ? 'flex' : 'hidden lg:flex',
            'scroll-mt-32 min-w-0 flex-col border bg-white transition-colors duration-300 lg:sticky lg:top-[7.75rem] lg:h-[calc(100vh-8.75rem)] lg:min-h-[540px]',
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
