<script setup>
import { ref, computed, onMounted, watch, nextTick } from 'vue'
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

const filter = ref(null)      // null = semua kategori
const tab = ref('asli')       // asli | perbaikan
const pane = ref('doc')       // ponsel: doc | temuan
const selected = ref(null)
const notice = ref('')
const error = ref('')
const busyId = ref(null)
const busyAll = ref(false)
const fixing = ref(false)
const dlEl = ref(null)

// Sumber kebenaran hasil adalah server: bila URL memuat id dokumen (dari
// analisis baru, riwayat, atau tab baru), muat ulang dari sana. sessionStorage
// hanya jalan pintas agar perpindahan halaman terasa instan.
async function hydrate(id = route.params.id || draft.value?.document?.id) {
  if (!id) { router.replace('/analisis'); return }
  if (draft.value?.document?.id === id && draft.value?.issues) { loading.value = false; return }
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
  }
}

onMounted(async () => {
  await hydrate()
  // Premium: laporan langsung diperbaiki otomatis setelah analisis, sesuai
  // alur "tempel laporan -> teks diperbaiki -> unduh".
  if (isPremium.value && doc.value && !hasFix.value) autoFix()
})

// Halaman hasil dipakai ulang saat pindah antar dokumen (riwayat -> hasil
// lain), jadi data harus dimuat ulang ketika id di URL berubah.
watch(() => route.params.id, (id) => { if (id && id !== draft.value?.document?.id) hydrate(id) })
watch(() => route.params.id, () => { selected.value = null; filter.value = null })

const doc = computed(() => draft.value?.document)
const analysis = computed(() => draft.value?.analysis)
const stats = computed(() => analysis.value?.stats || {})
const issues = computed(() => draft.value?.issues || [])
const statusOf = (i) => i.decision || 'active'
const decided = computed(() => issues.value.filter((i) => statusOf(i) !== 'active'))
const activeCount = computed(() => issues.value.filter((i) => statusOf(i) === 'active').length)
const visible = computed(() => issues.value.filter((i) => !filter.value || canon(i.category || i.type) === filter.value))
const revised = computed(() => doc.value?.revised_text || draft.value?.revised_text || doc.value?.original_text || '')
const summary = computed(() => {
  const map = new Map()
  for (const i of issues.value) {
    const k = canon(i.category || i.type)
    map.set(k, (map.get(k) || 0) + 1)
  }
  return [...map.entries()].map(([type, count]) => ({ type, count }))
})
const scores = computed(() => stats.value.scores || {})
const isPremium = computed(() => Boolean(draft.value?.meta?.is_premium ?? auth.user?.is_premium))
const locked = computed(() => !isPremium.value)
const hasFix = computed(() => Boolean(revised.value) && revised.value !== (doc.value?.original_text || ''))
const scoresList = computed(() => ['similarity', 'ai_usage']
  .map((key) => ({ key, ...(scores.value[key] || {}) }))
  .filter((m) => Number.isFinite(m.percent)))
const figures = computed(() => [
  { label: 'Kata', value: stats.value.word_count ?? 0 },
  { label: 'Paragraf', value: stats.value.paragraph_count ?? 0 },
  { label: 'Kalimat', value: stats.value.sentence_count ?? 0 },
  { label: 'Temuan', value: issues.value.length },
])
const progress = computed(() => (issues.value.length ? Math.round((decided.value.length / issues.value.length) * 100) : 100))
const busy = computed(() => busyAll.value || busyId.value !== null)
const bar = (v) => Math.max(0, Math.min(100, Number(v) || 0))
const numberOf = (i) => issues.value.indexOf(i) + 1
const narrow = () => window.innerWidth < 1024

function say(msg) { notice.value = msg; clearTimeout(say.t); say.t = setTimeout(() => (notice.value = ''), 3200) }
function fail(msg) { error.value = msg; clearTimeout(fail.t); fail.t = setTimeout(() => (error.value = ''), 7000) }
function sync(d) { draft.value = d; documents.setCurrent(d) }

// Scroll di dalam panel masing-masing supaya panel lain tidak ikut bergeser.
function scrollWithin(el) {
  if (!el) return
  const box = el.closest('[data-scroll]')
  if (!box) return
  const top = el.getBoundingClientRect().top - box.getBoundingClientRect().top + box.scrollTop - (box.clientHeight - el.offsetHeight) / 2
  box.scrollTop = Math.max(0, top)
}
const goTo = (prefix, id) => scrollWithin(document.getElementById(prefix + id))

// Klik sorotan di dokumen: tandai, lalu tunjukkan kartunya (ponsel pindah tab).
function pickFromDoc(id) {
  selected.value = id
  if (narrow()) pane.value = 'temuan'
  nextTick(() => goTo('s-', id))
}
// Pilih kartu: di desktop dokumen ikut bergeser ke sorotannya.
function pickFromCard(id) {
  selected.value = id
  if (!narrow()) nextTick(() => goTo('m-', id))
}
function locate(id) {
  selected.value = id
  pane.value = 'doc'
  nextTick(() => goTo('m-', id))
}

async function sendDecision(body, okMsg, id = null) {
  busyId.value = id
  busyAll.value = id === null
  try {
    const res = await documents.decide(doc.value.id, body)
    sync({ ...draft.value, issues: res.issues, revised_text: res.revised_text, document: { ...doc.value, revised_text: res.revised_text } })
    say(okMsg)
  } catch (e) {
    if (e.status === 403) fail('Saran terkunci untuk akun gratis. Buka halaman Premium untuk membuka semuanya.')
    else if (e.status === 409) fail(e.message)
    else fail(e.message || 'Gagal menyimpan keputusan.')
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
function acceptAll() {
  if (!confirm('Terapkan semua saran yang aman sekaligus? Saran yang perlu cek manual dilewati.')) return
  sendDecision({ accept_all: true }, 'Semua saran aman diterapkan.')
}

// Perbaikan otomatis: menerapkan semua saran yang lolos validasi. Saran yang
// ditandai perlu cek manual tetap dilewati agar makna tulisan tidak berubah.
async function autoFix(manual = false) {
  if (!isPremium.value || fixing.value || busy.value) return
  if (!issues.value.some((i) => statusOf(i) === 'active' && !i.needs_manual_review)) {
    if (manual) fail('Tidak ada saran yang bisa diterapkan otomatis.')
    return
  }
  fixing.value = true
  try {
    const res = await documents.decide(doc.value.id, { accept_all: true })
    sync({
      ...draft.value,
      issues: res.issues,
      revised_text: res.revised_text,
      document: { ...doc.value, revised_text: res.revised_text, status: res.document?.status || doc.value.status },
    })
    if (manual) say('Semua saran aman diterapkan. Laporan siap diunduh.')
    else { tab.value = 'perbaikan'; say('Teks sudah diperbaiki otomatis. Tinjau di tab Teks perbaikan.') }
  } catch (e) {
    if (e.status === 403) fail('Perbaikan otomatis khusus Premium. Buka halaman Premium untuk mengaktifkannya.')
    else fail(e.message || 'Gagal menerapkan saran.')
  } finally {
    fixing.value = false
  }
}

async function restore() {
  if (!confirm('Pulihkan teks asli dan ubah semua keputusan menjadi aktif lagi?')) return
  busyAll.value = true
  try {
    const res = await documents.restore(doc.value.id)
    const fresh = await documents.get(doc.value.id)
    sync({ document: fresh.document, analysis: fresh.analysis, issues: fresh.issues, revised_text: res.revised_text, meta: fresh.meta || draft.value.meta })
    tab.value = 'asli'
    say('Teks asli dipulihkan.')
  } catch (e) { fail(e.message) } finally { busyAll.value = false }
}

async function download(format) {
  dlEl.value?.removeAttribute('open')
  if (!hasFix.value) { fail('Belum ada teks perbaikan untuk diunduh. Terapkan saran dulu.'); return }
  try {
    await documents.download(doc.value.id, format, `${doc.value.title}-revisi.${format}`)
    say(`Laporan perbaikan (.${format}) terunduh.`)
  } catch (e) { fail(e.message) }
}
</script>

<template>
  <section v-if="loading" class="mx-auto max-w-6xl px-4 py-24 text-center font-mono text-sm uppercase tracking-widest sm:px-6">
    <i class="fa-solid fa-circle-notch fa-spin mr-2"></i>Memuat hasil...
  </section>

  <section v-else-if="!draft || !doc" class="mx-auto max-w-3xl px-4 py-24 text-center sm:px-6">
    <p class="font-black uppercase tracking-tight">Hasil tidak ditemukan.</p>
    <p class="mt-2 text-sm text-black/60">{{ loadError || 'Dokumen mungkin sudah dihapus atau kedaluwarsa setelah 30 hari.' }}</p>
    <div class="mt-8 flex flex-wrap justify-center gap-2">
      <BaseButton to="/riwayat">Buka riwayat</BaseButton>
      <BaseButton variant="secondary" to="/analisis">Analisis baru</BaseButton>
    </div>
  </section>

  <section v-else class="mx-auto max-w-[1600px] px-4 pb-16 pt-6 sm:px-6 lg:px-8">
    <!-- Bar judul + aksi -->
    <div class="flex flex-col gap-4 border-b-2 border-black pb-4 lg:flex-row lg:items-end lg:justify-between lg:gap-8">
      <div class="min-w-0">
        <p class="flex items-center gap-2 font-mono text-[10px] uppercase tracking-widest text-black/45">
          <router-link to="/riwayat" class="hover:text-black"><i class="fa-solid fa-arrow-left mr-1"></i>Riwayat</router-link>
          <span aria-hidden="true">/</span><span>Hasil analisis</span>
        </p>
        <h1 class="mt-1.5 truncate text-2xl font-black uppercase leading-none tracking-tighter sm:text-3xl" :title="doc.title">{{ doc.title }}</h1>
        <p class="mt-1.5 flex flex-wrap items-center gap-x-2 font-mono text-[10px] uppercase tracking-widest text-black/45">
          <span>{{ doc.word_count }} kata</span><span aria-hidden="true">·</span><span>{{ issues.length }} temuan</span>
          <template v-if="draft.meta?.total_found > draft.meta?.shown">
            <span aria-hidden="true">·</span><span class="text-[#FF3000]">{{ draft.meta.total_found - draft.meta.shown }} terkunci</span>
          </template>
        </p>
      </div>

      <div class="flex flex-wrap items-center gap-2">
        <details ref="dlEl" class="relative">
          <summary class="summary-plain flex h-10 cursor-pointer list-none items-center gap-2 border-2 border-black bg-black px-4 text-xs font-bold uppercase tracking-widest text-white hover:border-[#FF3000] hover:bg-[#FF3000]">
            <i class="fa-solid fa-download text-[11px]"></i>Unduh<i class="fa-solid fa-chevron-down text-[9px]"></i>
          </summary>
          <div class="absolute left-0 z-20 mt-1 w-52 border-2 border-black bg-white sm:left-auto sm:right-0">
            <button v-for="f in ['pdf', 'docx', 'txt']" :key="f" :disabled="!hasFix" class="flex w-full items-center justify-between gap-2 border-b-2 border-black/10 px-3 py-2.5 text-left text-[11px] font-bold uppercase tracking-widest last:border-b-0 hover:bg-black hover:text-white disabled:opacity-40 disabled:hover:bg-white disabled:hover:text-black" @click="download(f)">
              <span>{{ f }}</span><i class="fa-solid fa-arrow-right text-[10px]"></i>
            </button>
            <p v-if="!hasFix" class="border-t-2 border-black/10 bg-[#F2F2F2] px-3 py-2 text-[10px] leading-snug text-black/50">Belum ada teks perbaikan.</p>
          </div>
        </details>
        <BaseButton variant="secondary" size="sm" :to="`/bandingkan/${doc.id}`"><i class="fa-solid fa-code-compare text-[11px]"></i>Bandingkan</BaseButton>
        <BaseButton variant="secondary" size="sm" to="/analisis"><i class="fa-solid fa-plus text-[11px]"></i>Teks baru</BaseButton>
      </div>
    </div>

    <div class="mt-3 space-y-2 empty:hidden">
      <p v-if="notice" role="status" class="flex items-center gap-3 border-2 border-black bg-black px-4 py-2.5 text-xs font-bold uppercase tracking-wide text-white sm:text-sm">
        <i class="fa-solid fa-check text-[#FF3000]"></i>{{ notice }}
      </p>
      <p v-if="error" role="alert" class="flex items-start gap-3 border-2 border-[#FF3000] bg-[#FFF6F3] px-4 py-2.5 text-xs font-bold uppercase leading-relaxed tracking-wide text-black sm:text-sm">
        <i class="fa-solid fa-triangle-exclamation mt-0.5 text-[#FF3000]"></i>{{ error }}
      </p>
      <div v-if="draft.meta?.locked_note" class="flex flex-col gap-2 border-2 border-black bg-[#F2F2F2] px-4 py-2.5 sm:flex-row sm:items-center sm:justify-between">
        <p class="text-sm leading-relaxed"><strong class="uppercase tracking-wide">Mode gratis.</strong> {{ draft.meta.locked_note }}</p>
        <router-link to="/premium" class="shrink-0 py-1 font-bold uppercase tracking-wide underline decoration-[#FF3000] decoration-2 underline-offset-4">Buka Premium</router-link>
      </div>
    </div>

    <!-- Ringkasan: dua skor terpisah + statistik dokumen -->
    <div class="mt-4 grid gap-px border-2 border-black bg-black sm:grid-cols-2">
      <div v-for="m in scoresList" :key="m.key" class="bg-white p-4 sm:p-5">
        <div class="flex items-baseline justify-between gap-4">
          <p class="font-mono text-[10px] uppercase tracking-widest text-black/50">{{ m.label }}</p>
          <p class="text-4xl font-black leading-none tabular-nums">{{ m.percent }}<span class="text-lg">%</span></p>
        </div>
        <div class="mt-3 h-1.5 w-full bg-black/10" role="progressbar" :aria-label="m.label" :aria-valuenow="bar(m.percent)" aria-valuemin="0" aria-valuemax="100">
          <div class="h-full bg-[#FF3000]" :style="{ width: bar(m.percent) + '%' }"></div>
        </div>
        <p class="mt-2 text-[11px] leading-relaxed text-black/55">{{ m.note }}</p>
        <details v-if="m.signals?.length" class="mt-2">
          <summary class="summary-plain inline-flex cursor-pointer items-center gap-1.5 py-1 font-mono text-[10px] uppercase tracking-widest text-black/45 hover:text-black">
            <i class="fa-solid fa-chevron-down text-[9px]"></i>Rincian
          </summary>
          <ul class="mt-2 space-y-2">
            <li v-for="s in m.signals" :key="s.key">
              <div class="flex justify-between gap-2 font-mono text-[10px] uppercase tracking-wider text-black/55">
                <span class="min-w-0 truncate">{{ s.label }}</span><span class="shrink-0 tabular-nums">{{ s.percent }}%</span>
              </div>
              <div class="mt-1 h-1 w-full bg-black/10"><div class="h-full bg-black/45" :style="{ width: bar(s.percent) + '%' }"></div></div>
            </li>
          </ul>
        </details>
      </div>
      <p v-if="!scoresList.length" class="bg-white p-4 text-sm text-black/55">Skor teks belum tersedia untuk dokumen ini.</p>
    </div>

    <dl class="mt-2 grid grid-cols-2 gap-px border-2 border-black bg-black sm:grid-cols-4">
      <div v-for="f in figures" :key="f.label" class="bg-white px-3 py-2.5">
        <dt class="font-mono text-[10px] uppercase leading-tight tracking-widest text-black/50">{{ f.label }}</dt>
        <dd class="mt-1 text-xl font-black leading-none tabular-nums">{{ f.value }}</dd>
      </div>
    </dl>

    <details v-if="stats.top_words?.length" class="mt-2 border-2 border-black bg-white">
      <summary class="summary-plain flex cursor-pointer items-center justify-between gap-2 px-3 py-2 font-mono text-[10px] uppercase tracking-widest text-black/50 hover:text-black">
        <span>Kata tersering</span><i class="fa-solid fa-chevron-down text-[9px]"></i>
      </summary>
      <div class="flex flex-wrap gap-1.5 border-t-2 border-black/10 px-3 py-2.5">
        <span v-for="w in stats.top_words.slice(0, 10)" :key="w.word" class="border-2 border-black/15 px-2 py-1 font-mono text-[11px] leading-none"><span class="font-bold">{{ w.word }}</span> <span class="text-black/45">×{{ w.count }}</span></span>
      </div>
    </details>

    <!-- Ponsel: pilih panel -->
    <div class="mt-4 grid grid-cols-2 gap-1.5 lg:hidden" role="tablist" aria-label="Pilih panel">
      <button role="tab" :aria-selected="pane === 'doc'" :class="['flex min-h-[44px] items-center justify-center gap-2 border-2 text-[11px] font-bold uppercase tracking-widest', pane === 'doc' ? 'border-black bg-black text-white' : 'border-black/20 text-black/60']" @click="pane = 'doc'">
        <i class="fa-solid fa-file-lines text-[11px]"></i>Dokumen
      </button>
      <button role="tab" :aria-selected="pane === 'temuan'" :class="['flex min-h-[44px] items-center justify-center gap-2 border-2 text-[11px] font-bold uppercase tracking-widest', pane === 'temuan' ? 'border-black bg-black text-white' : 'border-black/20 text-black/60']" @click="pane = 'temuan'">
        <i class="fa-solid fa-list-check text-[11px]"></i>Temuan<span class="font-mono">{{ issues.length }}</span>
      </button>
    </div>

    <div class="mt-3 grid gap-5 lg:mt-4 lg:grid-cols-[minmax(0,1.62fr)_minmax(340px,1fr)] lg:items-start xl:gap-6">
      <!-- Panel dokumen -->
      <div :class="[pane === 'doc' ? 'flex' : 'hidden lg:flex', 'min-w-0 flex-col border-2 border-black bg-white lg:sticky lg:top-[5.5rem] lg:h-[calc(100vh-6.5rem)] lg:min-h-[520px]']">
        <div class="flex flex-wrap items-center justify-between gap-2 border-b-2 border-black px-2 py-2 sm:px-3">
          <div class="flex gap-1" role="tablist" aria-label="Pilih tampilan teks">
            <button role="tab" :aria-selected="tab === 'asli'" :class="['min-h-[40px] px-3 text-[11px] font-bold uppercase tracking-widest transition-colors', tab === 'asli' ? 'bg-black text-white' : 'text-black/55 hover:text-black']" @click="tab = 'asli'">Teks asli</button>
            <button role="tab" :aria-selected="tab === 'perbaikan'" :class="['min-h-[40px] px-3 text-[11px] font-bold uppercase tracking-widest transition-colors', tab === 'perbaikan' ? 'bg-black text-white' : 'text-black/55 hover:text-black']" @click="tab = 'perbaikan'">
              Teks perbaikan<i v-if="hasFix" class="fa-solid fa-check ml-1.5 text-[10px] text-[#FF3000]"></i>
            </button>
          </div>
          <p class="pr-1 font-mono text-[10px] uppercase tracking-widest text-black/40">{{ figures[1].value }} paragraf</p>
        </div>

        <div data-scroll class="min-h-0 flex-1 overflow-y-auto">
          <div class="px-4 py-6 sm:px-8 sm:py-8">
            <div class="mx-auto max-w-[68ch]">
              <template v-if="tab === 'asli'">
                <HighlightedText :text="doc.original_text" :issues="issues" :selected="selected" @pick="pickFromDoc" />
                <p class="mt-6 border-t-2 border-black/10 pt-3 font-mono text-[10px] uppercase leading-relaxed tracking-widest text-black/40">
                  Klik sorotan berwarna untuk melihat temuan terkait.
                </p>
              </template>
              <template v-else>
                <p v-if="fixing" class="flex items-center gap-2 border-2 border-black bg-[#F2F2F2] px-4 py-3 font-mono text-[10px] uppercase tracking-widest text-black/60">
                  <i class="fa-solid fa-circle-notch fa-spin"></i>Menerapkan saran perbaikan...
                </p>
                <pre v-else-if="hasFix" class="whitespace-pre-wrap break-words font-sans text-[16px] leading-[1.85] text-black">{{ revised }}</pre>
                <div v-else class="border-2 border-dashed border-black/25 px-4 py-10 text-center text-sm leading-relaxed">
                  <template v-if="locked">
                    Teks yang sudah diperbaiki terbuka di Premium, termasuk unduhan PDF, DOCX, dan TXT.
                    <router-link to="/premium" class="ml-1 font-bold uppercase tracking-wide underline decoration-[#FF3000] decoration-2 underline-offset-4">Buka Premium</router-link>
                  </template>
                  <template v-else>
                    Belum ada saran yang diterapkan.
                    <button class="font-bold uppercase tracking-wide underline decoration-[#FF3000] decoration-2 underline-offset-4" @click="autoFix(true)">Perbaiki otomatis sekarang</button>
                  </template>
                </div>
              </template>
            </div>
          </div>
        </div>
      </div>

      <!-- Panel temuan -->
      <aside :class="[pane === 'temuan' ? 'flex' : 'hidden lg:flex', 'min-w-0 flex-col border-2 border-black bg-white lg:sticky lg:top-[5.5rem] lg:h-[calc(100vh-6.5rem)] lg:min-h-[520px]']">
        <div class="border-b-2 border-black px-3 py-2.5">
          <div class="flex items-center justify-between gap-3">
            <h2 class="text-sm font-black uppercase leading-none tracking-tight">Temuan<span class="ml-2 font-mono text-xs font-medium text-black/45">{{ issues.length }}</span></h2>
            <button v-if="!locked && activeCount" :disabled="busy" class="shrink-0 min-h-[32px] border-2 border-[#FF3000] px-2.5 py-1 font-mono text-[10px] font-bold uppercase leading-none tracking-widest text-[#FF3000] transition-colors hover:bg-[#FF3000] hover:text-white disabled:opacity-40" @click="acceptAll">
              <i class="fa-solid fa-check-double mr-1"></i>Terapkan semua
            </button>
          </div>
          <template v-if="issues.length">
            <div class="mt-2.5 h-1.5 w-full bg-black/10" role="progressbar" aria-label="Progres keputusan" :aria-valuenow="progress" aria-valuemin="0" aria-valuemax="100">
              <div class="h-full bg-[#FF3000] transition-[width] duration-300" :style="{ width: progress + '%' }"></div>
            </div>
            <p class="mt-1.5 font-mono text-[10px] uppercase tracking-widest text-black/45">{{ decided.length }} dari {{ issues.length }} sudah diputuskan</p>
          </template>
        </div>

        <div v-if="summary.length" class="flex flex-wrap gap-1.5 border-b-2 border-black px-3 py-2.5">
          <button :aria-pressed="filter === null" :class="['flex min-h-[32px] items-center gap-1.5 border-2 px-2 py-1 text-[10px] font-bold uppercase tracking-wider', filter === null ? 'border-black bg-black text-white' : 'border-black/20 text-black/70 hover:border-black hover:text-black']" @click="filter = null">
            Semua<span class="font-mono opacity-60">{{ issues.length }}</span>
          </button>
          <button v-for="s in summary" :key="s.type" :aria-pressed="filter === s.type"
            :class="['flex min-h-[32px] items-center gap-1.5 border-2 px-2 py-1 text-[10px] font-bold uppercase tracking-wider', filter === s.type ? 'border-black bg-black text-white' : 'border-black/20 text-black/70 hover:border-black hover:text-black']"
            @click="filter = filter === s.type ? null : s.type">
            <span class="h-2 w-2 shrink-0" :style="{ background: CATEGORIES[s.type].color }" aria-hidden="true"></span>{{ CATEGORIES[s.type].label }}<span class="font-mono opacity-60">{{ s.count }}</span>
          </button>
        </div>

        <div data-scroll class="min-h-0 flex-1 space-y-2.5 overflow-y-auto p-3">
          <SuggestionCard v-for="i in visible" :key="i.id" :issue="i" :index="numberOf(i)" :selected="selected === i.id" :busy="busy" :locked="locked" @pick="pickFromCard" @locate="locate" @accept="accept" @reject="reject" />
          <div v-if="!visible.length" class="border-2 border-black bg-[#F2F2F2] px-4 py-10 text-center">
            <i class="fa-regular fa-circle-check mb-2 block text-2xl"></i>
            <p class="text-xs font-bold uppercase leading-relaxed tracking-wide">{{ issues.length ? (filter ? 'Tidak ada temuan di kategori ini.' : 'Semua temuan sudah diputuskan.') : 'Tidak ada masalah yang terbukti pada teks ini.' }}</p>
            <button v-if="filter" class="mt-3 font-mono text-[10px] font-bold uppercase tracking-widest underline decoration-[#FF3000] decoration-2 underline-offset-4" @click="filter = null">Tampilkan semua kategori</button>
          </div>
        </div>

        <div class="border-t-2 border-black/10 px-3 py-2">
          <button :disabled="busy || fixing" class="flex min-h-[40px] w-full items-center justify-center gap-2 text-[10px] font-bold uppercase tracking-widest text-black/55 transition-colors hover:text-black disabled:opacity-40" @click="restore">
            <i class="fa-solid fa-rotate-left text-[11px]"></i>Pulihkan teks asli
          </button>
        </div>
      </aside>
    </div>
  </section>
</template>
