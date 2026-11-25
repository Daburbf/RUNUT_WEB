<script setup>
import { ref, computed, onMounted } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import BaseButton from '../components/BaseButton.vue'
import BaseCard from '../components/BaseCard.vue'
import SectionLabel from '../components/SectionLabel.vue'
import { documents } from '../store/documents'
import { api } from '../utils/api'

const route = useRoute()
const router = useRouter()
const draft = ref(documents.getCurrent())
const preservation = ref(null)
const error = ref('')
const viewMode = ref('diff') // 'diff' | 'side'

const original = computed(() => draft.value?.document?.original_text || '')
const revised = computed(() => draft.value?.document?.revised_text || draft.value?.revised_text || '')
const issues = computed(() => draft.value?.issues || [])
const changed = computed(() => original.value !== revised.value)

const appliedChanges = computed(() => issues.value.filter((i) => i.decision === 'applied'))
const rejectedChanges = computed(() => issues.value.filter((i) => i.decision === 'rejected'))
const pendingChanges = computed(() => issues.value.filter((i) => i.decision === 'active'))

// Word-level LCS diff for clear added/removed wording preview (purely visual; never mutates original)
function diffWords(oldText, newText) {
  const a = String(oldText || '').split(/(\s+)/).filter((t) => t.length > 0)
  const b = String(newText || '').split(/(\s+)/).filter((t) => t.length > 0)
  if (a.length * b.length > 40000) {
    return [
      ...(oldText ? [{ type: 'del', text: oldText }] : []),
      ...(newText ? [{ type: 'ins', text: newText }] : []),
    ]
  }
  const m = a.length
  const n = b.length
  const dp = Array.from({ length: m + 1 }, () => new Uint16Array(n + 1))
  for (let i = m - 1; i >= 0; i--) {
    for (let j = n - 1; j >= 0; j--) {
      dp[i][j] = a[i] === b[j] ? dp[i + 1][j + 1] + 1 : Math.max(dp[i + 1][j], dp[i][j + 1])
    }
  }
  const out = []
  let i = 0
  let j = 0
  while (i < m && j < n) {
    if (a[i] === b[j]) {
      out.push({ type: 'eq', text: a[i] })
      i += 1
      j += 1
    } else if (dp[i + 1][j] >= dp[i][j + 1]) {
      out.push({ type: 'del', text: a[i] })
      i += 1
    } else {
      out.push({ type: 'ins', text: b[j] })
      j += 1
    }
  }
  while (i < m) out.push({ type: 'del', text: a[i++] })
  while (j < n) out.push({ type: 'ins', text: b[j++] })
  return out
}

const paragraphPairs = computed(() => {
  const origParas = original.value.split('\n')
  const revParas = revised.value.split('\n')
  const count = Math.max(origParas.length, revParas.length)
  const rows = []
  for (let idx = 0; idx < count; idx++) {
    const o = origParas[idx] ?? ''
    const r = revParas[idx] ?? ''
    if (!o.trim() && !r.trim()) continue
    const isModified = o !== r
    rows.push({
      index: idx + 1,
      original: o,
      revised: r,
      modified: isModified,
      tokens: isModified ? diffWords(o, r) : [{ type: 'eq', text: o }],
    })
  }
  return rows
})

async function copy() {
  try {
    await navigator.clipboard.writeText(revised.value)
    error.value = ''
  } catch {
    error.value = 'Gagal menyalin ke clipboard.'
  }
}

async function loadPreservation(id) {
  if (!id) return
  try {
    preservation.value = await api(`/api/documents/${id}/preservation`)
  } catch {
    preservation.value = null
  }
}

onMounted(async () => {
  const id = route.params.id
  if (!id) {
    if (!draft.value) {
      router.replace('/analisis')
      return
    }
    loadPreservation(draft.value?.document?.id)
    return
  }
  try {
    draft.value = await documents.get(id)
    loadPreservation(id)
  } catch (e) {
    error.value = e.message || 'Dokumen tidak ditemukan.'
  }
})
</script>

<template>
  <section class="mx-auto max-w-6xl px-4 py-12 sm:px-6">
    <SectionLabel>Perbandingan &amp; Validasi Template</SectionLabel>
    <div class="mt-4 flex flex-col gap-4 md:flex-row md:items-end md:justify-between">
      <div>
        <h1 class="text-4xl font-black uppercase leading-[0.95] tracking-tighter md:text-6xl">Teks asli vs revisi</h1>
        <p v-if="draft?.document" class="mt-3 font-mono text-xs uppercase tracking-widest text-black/60">{{ draft.document.title }}</p>
      </div>
      <div class="flex flex-wrap gap-2">
        <BaseButton variant="secondary" size="sm" :to="draft?.document ? `/hasil/${draft.document.id}` : '/riwayat'">
          <i class="fa-solid fa-arrow-left"></i>Kembali ke hasil &amp; unduh
        </BaseButton>
        <BaseButton variant="secondary" size="sm" @click="copy">
          <i class="fa-regular fa-copy"></i>Salin revisi
        </BaseButton>
      </div>
    </div>

    <p v-if="error" class="mt-6 border-2 border-black bg-black px-4 py-3 text-sm font-bold uppercase tracking-wide text-white">
      <span class="text-[#FF3000]">■</span> {{ error }}
    </p>

    <!-- Status Validasi Integritas Template Asli -->
    <div
      v-if="preservation?.has_original_file"
      :class="[
        'mt-6 border-2 px-4 py-3 text-xs font-mono',
        preservation.verified ? 'border-emerald-700 bg-emerald-50 text-emerald-950' : 'border-amber-700 bg-amber-50 text-amber-950',
      ]"
    >
      <div class="flex flex-wrap items-center justify-between gap-2">
        <span class="font-bold uppercase tracking-wider">
          <i :class="preservation.verified ? 'fa-solid fa-shield-check mr-1.5' : 'fa-solid fa-triangle-exclamation mr-1.5'"></i>
          Validasi Template {{ (preservation.format || '').toUpperCase() }}:
          {{ preservation.verified ? 'Terverifikasi Utuh' : (preservation.classification || 'Perlu Tinjauan') }}
        </span>
        <span class="text-[11px] opacity-80">Berkas asli tetap immutable (tidak diubah)</span>
      </div>
      <p v-if="preservation.note" class="mt-1 font-sans text-xs leading-relaxed">{{ preservation.note }}</p>
    </div>

    <!-- Ringkasan Perubahan Diterima / Ditolak / Menunggu -->
    <div v-if="draft?.document" class="mt-6 grid grid-cols-3 gap-3">
      <div class="border-2 border-black bg-white p-3">
        <p class="font-mono text-[10px] uppercase tracking-widest text-black/50">Diterima</p>
        <p class="mt-1 text-2xl font-black text-emerald-700">{{ appliedChanges.length }}</p>
      </div>
      <div class="border-2 border-black bg-white p-3">
        <p class="font-mono text-[10px] uppercase tracking-widest text-black/50">Ditolak</p>
        <p class="mt-1 text-2xl font-black text-black/60">{{ rejectedChanges.length }}</p>
      </div>
      <div class="border-2 border-black bg-white p-3">
        <p class="font-mono text-[10px] uppercase tracking-widest text-black/50">Belum diputuskan</p>
        <p class="mt-1 text-2xl font-black text-[#FF3000]">{{ pendingChanges.length }}</p>
      </div>
    </div>

    <p v-if="draft?.document && !changed" class="mt-6 border-2 border-black bg-[#F2F2F2] px-4 py-3 text-sm font-bold uppercase tracking-wide">
      Belum ada saran yang diterapkan, jadi teks revisi masih sama dengan teks asli.
    </p>

    <!-- Switcher Mode Tampilan -->
    <div v-if="draft?.document" class="mt-6 flex items-center gap-2">
      <button
        type="button"
        :class="['border-2 border-black px-3 py-1.5 font-mono text-xs font-bold uppercase tracking-wider', viewMode === 'diff' ? 'bg-black text-white' : 'bg-white text-black']"
        @click="viewMode = 'diff'"
      >
        Sorotan Perubahan per Paragraf
      </button>
      <button
        type="button"
        :class="['border-2 border-black px-3 py-1.5 font-mono text-xs font-bold uppercase tracking-wider', viewMode === 'side' ? 'bg-black text-white' : 'bg-white text-black']"
        @click="viewMode = 'side'"
      >
        Berdampingan (Utuh)
      </button>
    </div>

    <!-- Mode 1: Paragraf per Paragraf dengan Kata Dihapus & Ditambahkan -->
    <div v-if="draft?.document && viewMode === 'diff'" class="mt-6 space-y-4">
      <BaseCard v-for="row in paragraphPairs" :key="row.index" :class="row.modified ? '!border-[#FF3000]' : ''">
        <div class="flex items-center justify-between border-b border-black/15 bg-[#F7F7F7] px-5 py-2 font-mono text-[11px] uppercase tracking-wider">
          <span>Paragraf {{ row.index }}</span>
          <span :class="row.modified ? 'font-bold text-[#FF3000]' : 'text-black/45'">
            {{ row.modified ? 'Direvisi' : 'Tidak berubah' }}
          </span>
        </div>
        <div class="p-5 text-[15px] leading-8">
          <template v-for="(tok, idx) in row.tokens" :key="idx">
            <del v-if="tok.type === 'del'" class="bg-red-100 px-0.5 text-red-800 line-through">{{ tok.text }}</del>
            <ins v-else-if="tok.type === 'ins'" class="bg-emerald-100 px-0.5 font-medium text-emerald-900 no-underline">{{ tok.text }}</ins>
            <span v-else>{{ tok.text }}</span>
          </template>
        </div>
      </BaseCard>
    </div>

    <!-- Mode 2: Berdampingan Utuh -->
    <div v-if="draft?.document && viewMode === 'side'" class="mt-6 grid gap-6 md:grid-cols-2">
      <BaseCard>
        <div class="border-b-2 border-black bg-[#F2F2F2] px-6 py-3">
          <span class="font-mono text-xs font-bold uppercase tracking-widest">Teks asli (immutable)</span>
        </div>
        <p class="max-h-[70vh] overflow-y-auto whitespace-pre-wrap p-6 text-[15px] leading-8 text-black/70">{{ original }}</p>
      </BaseCard>
      <BaseCard class="!border-[#FF3000]">
        <div class="border-b-2 border-[#FF3000] bg-[#FF3000] px-6 py-3 font-mono text-xs font-bold uppercase tracking-widest text-white">
          <span>Teks revisi</span>
        </div>
        <p class="max-h-[70vh] overflow-y-auto whitespace-pre-wrap p-6 text-[15px] leading-8 font-medium">{{ revised }}</p>
      </BaseCard>
    </div>

    <!-- Daftar Keputusan Perubahan (Diterima & Ditolak) -->
    <div v-if="appliedChanges.length > 0 || rejectedChanges.length > 0" class="mt-8">
      <h2 class="font-mono text-xs font-bold uppercase tracking-widest text-black/60">Rincian Keputusan Perubahan</h2>
      <div class="mt-3 space-y-2">
        <div
          v-for="item in [...appliedChanges, ...rejectedChanges]"
          :key="item.id"
          class="flex flex-col gap-1 border-2 border-black/20 bg-white p-3 text-xs sm:flex-row sm:items-center sm:justify-between"
        >
          <div class="space-y-1">
            <span
              :class="[
                'inline-block px-2 py-0.5 font-mono text-[10px] font-bold uppercase',
                item.decision === 'applied' ? 'bg-emerald-100 text-emerald-900' : 'bg-black/10 text-black/70',
              ]"
            >
              {{ item.decision === 'applied' ? 'Diterima' : 'Ditolak' }}
            </span>
            <p class="text-black/70">
              <del class="bg-red-50 px-1 text-red-800">{{ item.snippet }}</del>
              <span class="mx-1.5 font-mono text-black/40">→</span>
              <ins class="bg-emerald-50 px-1 font-medium text-emerald-900 no-underline">{{ item.suggestion }}</ins>
            </p>
          </div>
        </div>
      </div>
    </div>
  </section>
</template>
