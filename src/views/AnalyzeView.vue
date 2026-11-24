<script setup>
import { ref, computed, onMounted, onBeforeUnmount, watch } from 'vue'
import { useRouter } from 'vue-router'
import BaseButton from '../components/BaseButton.vue'
import { auth } from '../store/auth'
import {
  MIN_ANALYSIS_WORDS,
  AI_MAX_CHARS,
  MAX_UPLOAD_BYTES,
  countWords,
  calculateTokenCost,
} from '../utils/categories'
import { job, startJob, estimateJob, setPendingFile, hydratePendingFile } from '../store/analysis'

const router = useRouter()
const file = computed({
  get: () => job.pendingFile,
  set: (v) => { setPendingFile(v || null) },
})
const extracting = ref(false)
const showRules = ref(false)
const error = ref('')
const autoFilledTitle = ref('')
let alive = true

onMounted(() => {
  auth.refreshProfile()
  hydratePendingFile()
})

onBeforeUnmount(() => { alive = false })

const text = computed({
  get: () => job.draft.text,
  set: (v) => { job.draft.text = v },
})
const title = computed({
  get: () => job.draft.title,
  set: (v) => { job.draft.title = v },
})
const aiConsent = computed({
  get: () => job.draft.aiConsent !== false,
  set: (v) => { job.draft.aiConsent = Boolean(v) },
})

const words = computed(() => countWords(text.value))
const chars = computed(() => (text.value || '').length)
const tokenCost = computed(() => (words.value > 0 ? calculateTokenCost(words.value) : 0))
const balance = computed(() => Math.max(0, Number(auth.user?.token_balance) || 0))
const balanceAfter = computed(() => balance.value - tokenCost.value)
const isInsufficient = computed(() => words.value >= MIN_ANALYSIS_WORDS && tokenCost.value > balance.value)
const isTooShort = computed(() => words.value > 0 && words.value < MIN_ANALYSIS_WORDS)
const isTooLarge = computed(() => chars.value > AI_MAX_CHARS)
const running = computed(() => job.status === 'running')

const buttonLabel = computed(() => {
  if (running.value) return `Menganalisis... ${job.elapsed} dtk`
  if (tokenCost.value > 0) return `Mulai Analisis · ${tokenCost.value} Token`
  return 'Mulai Analisis'
})

async function run() {
  error.value = ''
  if (!text.value.trim() && !file.value) {
    error.value = 'Masukkan atau unggah tulisan terlebih dahulu.'
    return
  }
  if (words.value < MIN_ANALYSIS_WORDS && !file.value) {
    error.value = `Tulisan minimal ${MIN_ANALYSIS_WORDS} kata agar dapat dianalisis (saat ini ${words.value} kata).`
    return
  }
  if (isTooLarge.value) {
    error.value = `Teks melebihi batas maksimum ${AI_MAX_CHARS.toLocaleString('id-ID')} karakter.`
    return
  }
  if (!aiConsent.value) {
    error.value = 'Centang persetujuan pengiriman teks ke layanan AI terlebih dahulu.'
    return
  }
  if (tokenCost.value > balance.value) {
    error.value = `Saldo token tidak mencukupi. Dibutuhkan ${tokenCost.value} token, saldo tersedia ${balance.value} token.`
    return
  }

  await startJob({
    text: text.value,
    title: title.value,
    file: file.value,
    aiConsent: aiConsent.value,
  })
}

async function onFile(e) {
  const f = e.target.files?.[0]
  e.target.value = ''
  file.value = null
  if (!f) return
  if (f.size > MAX_UPLOAD_BYTES) {
    error.value = 'Ukuran file melebihi batas maksimal 5 MB.'
    return
  }
  if (!/\.(txt|doc|docx|pdf)$/i.test(f.name)) {
    error.value = 'Format file tidak didukung. Gunakan .txt, .doc, .docx, atau .pdf (maksimal 5 MB).'
    return
  }
  error.value = ''
  extracting.value = true
  try {
    const est = await estimateJob({ file: f })
    if (typeof est.extracted_text === 'string') {
      text.value = est.extracted_text
    }
    if (!title.value.trim() || (autoFilledTitle.value && title.value === autoFilledTitle.value)) {
      const nextTitle = est.title || f.name.replace(/\.(txt|doc|docx|pdf)$/i, '')
      title.value = nextTitle
      autoFilledTitle.value = nextTitle
    }
    if (est.balance !== undefined) {
      auth.setBalance(est.balance)
    }
    // Pertahankan file asli (.doc/.docx/.pdf) di global store agar template dokumen dijaga utuh saat analisis & unduhan
    file.value = /\.(doc|docx|pdf)$/i.test(f.name) ? f : null
  } catch (err) {
    error.value = err.message || 'Gagal membaca isi file. Pastikan file tidak rusak.'
  } finally {
    extracting.value = false
  }
}

function clearDraft() {
  title.value = ''
  text.value = ''
  file.value = null
  autoFilledTitle.value = ''
  error.value = ''
}

watch(() => text.value, (val) => {
  if (!String(val || '').trim() && autoFilledTitle.value && title.value === autoFilledTitle.value) {
    title.value = ''
    file.value = null
    autoFilledTitle.value = ''
  }
})
</script>

<template>
  <section class="mx-auto max-w-5xl px-4 py-8 sm:px-6 md:py-12">
    <!-- Header Minimalis + Sub-Navigasi Fitur Editor -->
    <div class="flex flex-col gap-4 border-b-2 border-black pb-5 sm:flex-row sm:items-end sm:justify-between">
      <div>
        <div class="flex items-center gap-2 font-mono text-[11px] uppercase tracking-widest text-black/50">
          <span class="inline-block h-2 w-2 bg-[#FF3000]"></span>
          <span>Ruang Kerja Analisis</span>
        </div>
        <h1 class="mt-1.5 text-3xl font-black uppercase tracking-tighter sm:text-4xl">
          Periksa Tulisan
        </h1>
      </div>

      <!-- Bar Fitur Ringkas (Unggah, Ketentuan, Riwayat Terakhir) -->
      <div class="flex flex-wrap items-center gap-2">
        <label class="swiss-snap-fast inline-flex min-h-[38px] cursor-pointer items-center border-2 border-black bg-white px-3 py-1.5 font-mono text-[11px] font-bold uppercase tracking-wider hover:bg-black hover:text-white">
          <i class="fa-solid fa-file-arrow-up mr-1.5 text-[#FF3000]"></i>Unggah File
          <input type="file" accept=".txt,.doc,.docx,.pdf" class="hidden" @change="onFile" />
        </label>

        <button
          type="button"
          :aria-expanded="showRules"
          :class="[
            'swiss-snap-fast min-h-[38px] border-2 px-3 py-1.5 font-mono text-[11px] font-bold uppercase tracking-wider',
            showRules ? 'border-black bg-black text-white' : 'border-black/25 bg-white text-black/70 hover:border-black hover:text-black',
          ]"
          @click="showRules = !showRules"
        >
          <i class="fa-solid fa-circle-info mr-1.5"></i>Ketentuan
        </button>

        <router-link
          v-if="job.status === 'done' && job.documentId && !running"
          :to="`/hasil/${job.documentId}`"
          class="inline-flex min-h-[38px] items-center border-2 border-[#FF3000] bg-[#FF3000] px-3 py-1.5 font-mono text-[11px] font-bold uppercase tracking-wider text-white hover:border-black hover:bg-black"
        >
          <i class="fa-solid fa-circle-check mr-1.5"></i>Hasil Terakhir
        </router-link>
      </div>
    </div>

    <!-- Panel Ketentuan (Hanya tampil saat tombol Ketentuan diklik agar layar tetap bersih) -->
    <transition name="fade">
      <div v-if="showRules" class="mt-4 flex flex-wrap items-center justify-between gap-4 border-2 border-black bg-[#F2F2F2] px-4 py-3 text-xs">
        <div class="flex flex-wrap items-center gap-x-6 gap-y-1.5 font-mono uppercase tracking-wider text-black/75">
          <span><strong class="text-[#FF3000]">■</strong> Minimal {{ MIN_ANALYSIS_WORDS }} kata</span>
          <span><strong class="text-[#FF3000]">■</strong> Maks {{ AI_MAX_CHARS.toLocaleString('id-ID') }} karakter</span>
          <span><strong class="text-[#FF3000]">■</strong> Berkas .TXT, .DOC, .DOCX, .PDF (Maks 5 MB)</span>
          <span><strong class="text-[#FF3000]">■</strong> Saldo dipotong hanya saat analisis dimulai</span>
        </div>
        <button type="button" class="font-mono text-[10px] font-bold uppercase tracking-widest underline" @click="showRules = false">
          Tutup
        </button>
      </div>
    </transition>

    <!-- Kotak Editor Utama yang Bersih & Lega -->
    <div class="mt-5 border border-black/30 bg-white">
      <!-- Bar Judul Dokumen + Tombol Bersihkan -->
      <div class="flex items-center justify-between gap-3 border-b border-black/15 px-4 py-3.5 sm:px-6">
        <input
          id="doc-title-input"
          v-model="title"
          aria-label="Judul dokumen"
          placeholder="Judul dokumen (opsional)..."
          class="w-full bg-transparent text-base font-bold uppercase tracking-tight placeholder:text-black/30 focus:outline-none sm:text-lg"
        />
        <span
          v-if="file"
          class="hidden shrink-0 items-center gap-1.5 border border-black bg-[#F2F2F2] px-2.5 py-1 font-mono text-[10px] font-bold uppercase tracking-wider sm:inline-flex"
          title="Dokumen asli dipertahankan untuk menjaga format saat diunduh"
        >
          <i class="fa-solid fa-shield-halved text-[#FF3000]"></i>{{ file.name }}
        </span>
        <button
          v-if="text || file || title"
          type="button"
          class="swiss-snap-fast shrink-0 font-mono text-[11px] font-bold uppercase tracking-widest text-black/45 hover:text-[#FF3000]"
          @click="clearDraft"
        >
          Hapus Teks
        </button>
      </div>

      <!-- Area Tulis / Tempel -->
      <div class="relative">
        <textarea
          v-model="text"
          rows="14"
          placeholder="Tempel tulisanmu di sini atau klik 'Unggah File' di kanan atas..."
          class="w-full resize-y bg-transparent px-4 py-5 text-[15px] leading-8 focus:outline-none sm:px-6"
        ></textarea>
        <div v-if="extracting" class="absolute inset-0 flex items-center justify-center bg-white/90 font-mono text-xs font-bold uppercase tracking-widest">
          <i class="fa-solid fa-circle-notch fa-spin mr-2 text-[#FF3000]"></i>Mengekstrak teks dokumen...
        </div>
      </div>

      <!-- Bar Informasi Kata, Biaya Token, & Saldo (Minimalis 4 Kolom) -->
      <div class="grid grid-cols-2 divide-y border-t border-black/15 bg-[#F8F8F8] sm:grid-cols-4 sm:divide-x sm:divide-y-0 divide-black/10">
        <div class="px-4 py-3 sm:px-5">
          <p class="font-mono text-[10px] uppercase tracking-widest text-black/50">Jumlah Kata</p>
          <p class="mt-0.5 font-mono text-sm font-black tabular-nums">{{ words.toLocaleString('id-ID') }} kata</p>
        </div>
        <div class="px-4 py-3 sm:px-5">
          <p class="font-mono text-[10px] uppercase tracking-widest text-black/50">Biaya Analisis</p>
          <p class="mt-0.5 font-mono text-sm font-black tabular-nums text-[#FF3000]">{{ tokenCost }} token</p>
        </div>
        <div class="px-4 py-3 sm:px-5">
          <p class="font-mono text-[10px] uppercase tracking-widest text-black/50">Token Tersedia</p>
          <p class="mt-0.5 font-mono text-sm font-black tabular-nums">{{ balance }} token</p>
        </div>
        <div class="flex items-center justify-between px-4 py-3 sm:px-5">
          <div>
            <p class="font-mono text-[10px] uppercase tracking-widest text-black/50">Sisa Setelah Analisis</p>
            <p :class="['mt-0.5 font-mono text-sm font-black tabular-nums', balanceAfter < 0 ? 'text-[#FF3000]' : 'text-black']">
              {{ balanceAfter >= 0 ? `${balanceAfter} token` : `Kurang ${Math.abs(balanceAfter)} token` }}
            </p>
          </div>
          <router-link
            to="/token?redirect=/analisis"
            class="swiss-snap-fast border border-black/25 bg-white px-2.5 py-1 font-mono text-[10px] font-bold uppercase tracking-wider hover:border-black hover:bg-black hover:text-white"
            title="Isi token"
          >
            + Isi Token
          </router-link>
        </div>
      </div>

      <!-- Bar Tindakan Bawah: Persetujuan & Tombol Mulai Analisis -->
      <div class="flex flex-col gap-4 border-t border-black/15 p-4 sm:flex-row sm:items-center sm:justify-between sm:px-6">
        <label class="flex cursor-pointer items-center gap-2.5 text-xs text-black/70">
          <input v-model="aiConsent" type="checkbox" class="h-4 w-4 shrink-0 accent-[#FF3000]" />
          <span>Setuju kirim teks ke layanan AI untuk dianalisis (token dikembalikan jika sistem gagal).</span>
        </label>

        <div class="flex flex-wrap items-center gap-2.5">
          <span v-if="isTooShort" class="font-mono text-[11px] font-bold uppercase tracking-wider text-[#FF3000]">
            Minimal {{ MIN_ANALYSIS_WORDS }} kata
          </span>
          <BaseButton
            v-if="isInsufficient"
            to="/token?redirect=/analisis"
            variant="accent"
          >
            <i class="fa-solid fa-coins"></i>Isi Token ({{ tokenCost }} Token Dibutuhkan)
          </BaseButton>
          <BaseButton
            :disabled="running || extracting || isTooShort || isTooLarge || words < MIN_ANALYSIS_WORDS || isInsufficient"
            @click="run"
          >
            <i :class="['fa-solid', running ? 'fa-circle-notch fa-spin' : 'fa-wand-magic-sparkles']"></i>
            {{ buttonLabel }}
          </BaseButton>
        </div>
      </div>

      <!-- Peringatan Saldo Tidak Mencukupi -->
      <div v-if="isInsufficient" class="flex flex-wrap items-center justify-between gap-3 border-t-2 border-black bg-[#FFF6F3] px-4 py-3 sm:px-6">
        <p class="text-xs font-bold uppercase tracking-wide text-black">
          <i class="fa-solid fa-triangle-exclamation mr-1.5 text-[#FF3000]"></i>
          Saldo token belum mencukupi ({{ balance }} dari {{ tokenCost }} token). Draf tulisan tetap tersimpan saat Anda mengisi token.
        </p>
        <router-link to="/token?redirect=/analisis" class="font-mono text-xs font-bold uppercase tracking-widest underline decoration-[#FF3000] decoration-2 underline-offset-4">
          Isi Token Sekarang →
        </router-link>
      </div>

      <!-- Status Analisis Berjalan -->
      <p v-if="running" class="border-t-2 border-black bg-[#F2F2F2] px-4 py-3 font-mono text-xs uppercase tracking-widest text-black/70 sm:px-6">
        <i class="fa-solid fa-circle-notch fa-spin mr-2 text-[#FF3000]"></i>
        Sedang memeriksa tulisan ({{ job.elapsed }} dtk)... Proses tetap berjalan walau Anda berpindah halaman.
      </p>

      <!-- Pesan Error -->
      <div v-if="error || job.status === 'error'" class="flex flex-wrap items-center justify-between gap-3 border-t-2 border-black bg-black px-4 py-3 text-white sm:px-6">
        <p class="text-xs font-bold uppercase tracking-wide">
          <i class="fa-solid fa-circle-exclamation mr-2 text-[#FF3000]"></i>{{ error || job.error }}
        </p>
        <button
          v-if="!isInsufficient && job.errorCode !== 'INSUFFICIENT_TOKENS'"
          type="button"
          class="border border-white px-3 py-1 font-mono text-[10px] font-bold uppercase tracking-widest hover:bg-[#FF3000] hover:border-[#FF3000]"
          @click="run"
        >
          Coba Lagi
        </button>
      </div>
    </div>
  </section>
</template>
