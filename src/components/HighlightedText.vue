<script setup>
import { computed } from 'vue'
import { canon, CATEGORIES } from '../utils/categories'

const props = defineProps({
  text: String,
  issues: Array,
  stats: Object,
  selected: String,
})
const emit = defineEmits(['pick'])

const statusOf = (i) => i.decision || 'active'

function escapeRegex(str) {
  return String(str || '').replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

function findAllOccurrences(text, needle, maxEnd, limit = 12) {
  const clean = String(needle || '').trim()
  if (clean.length < 3) return []
  const hay = text.slice(0, maxEnd)
  const re = new RegExp(`(?<![\\p{L}\\p{N}])${escapeRegex(clean)}(?![\\p{L}\\p{N}])`, 'giu')
  const spans = []
  let m
  while ((m = re.exec(hay)) !== null && spans.length < limit) {
    spans.push([m.index, m.index + m[0].length])
    if (m.index === re.lastIndex) re.lastIndex += 1
  }
  return spans
}

const deterministicMarks = computed(() => {
  const text = props.text || ''
  const st = props.stats || {}
  if (!text) return []

  const bibStart = st.citation_report?.bibliography_start
  const bodyEnd = typeof bibStart === 'number' && bibStart > 0 ? bibStart : text.length
  const out = []

  // 1. Masalah Sitasi (Terakota): sitasi dalam teks yang tidak ada di daftar pustaka
  const missingRefs = st.citation_report?.missing_references || []
  for (const m of missingRefs) {
    const raw = typeof m === 'string' ? m : (m?.citation || m?.raw || m?.text || '')
    if (!raw) continue
    for (const [s, e] of findAllOccurrences(text, raw, bodyEnd, 5)) {
      out.push({
        s,
        e,
        priority: 2,
        color: 'var(--hl-citation-color)',
        bg: 'var(--hl-citation-bg)',
        badge: 'Masalah Sitasi & Pustaka',
        title: `Masalah Sitasi: "${raw}" belum ditemukan di Daftar Pustaka`,
      })
    }
  }

  // 2. Temuan Similarity Report (Crimson / Forest / Ochre)
  const simFindings = st.similarity_report?.findings || []
  for (const f of simFindings.slice(0, 20)) {
    const passage = String(f.matching_phrase || f.original_passage || '').trim()
    if (passage.length < 4) continue
    let color = 'var(--hl-sim-color)'
    let bg = 'var(--hl-sim-bg)'
    let badge = 'Kemiripan Umum'
    if (f.category === 'unattributed_overlap' || f.category === 'close_paraphrase') {
      color = 'var(--hl-strong-color)'
      bg = 'var(--hl-strong-bg)'
      badge = 'Kecocokan Kuat Tanpa Sitasi'
    } else if (f.category === 'direct_quotation' || f.category === 'properly_cited') {
      color = 'var(--hl-safe-color)'
      bg = 'var(--hl-safe-bg)'
      badge = 'Kutipan Bersitasi Benar'
    }
    for (const [s, e] of findAllOccurrences(text, passage, bodyEnd, 6)) {
      out.push({
        s,
        e,
        priority: f.category === 'unattributed_overlap' ? 2 : 3,
        color,
        bg,
        badge,
        title: `${badge}: ${f.explanation || passage}`,
      })
    }
  }

  // 3. Pengulangan Frasa & Pembuka Kalimat bila skor Similarity >= 20%
  const simPct = Number(st.scores?.similarity?.percent || 0)
  if (simPct >= 20) {
    for (const p of (st.top_phrases || []).slice(0, 5)) {
      if (!p?.phrase || p.count < 3) continue
      for (const [s, e] of findAllOccurrences(text, p.phrase, bodyEnd, 10)) {
        out.push({
          s,
          e,
          priority: 4,
          color: 'var(--hl-sim-color)',
          bg: 'var(--hl-sim-bg)',
          badge: 'Kemiripan Umum',
          title: `Kemiripan Umum · Frasa "${p.phrase}" berulang ${p.count}x`,
        })
      }
    }
    for (const o of (st.repeated_openings || []).slice(0, 4)) {
      if (!o?.opening || o.count < 2) continue
      for (const [s, e] of findAllOccurrences(text, o.opening, bodyEnd, 8)) {
        out.push({
          s,
          e,
          priority: 4,
          color: 'var(--hl-ai-color)',
          bg: 'var(--hl-ai-bg)',
          badge: 'Indikator Gaya AI',
          title: `Indikator Gaya AI · Pembuka kalimat "${o.opening}" berulang ${o.count}x`,
        })
      }
    }
  }

  return out
})

// Gabungkan sorotan saran AI (prioritas 1, bisa diklik) + sorotan indikator deterministik tanpa tumpang tindih.
const parts = computed(() => {
  const text = props.text || ''
  const out = []

  const aiMarks = [...(props.issues || [])]
    .filter((i) => statusOf(i) !== 'rejected')
    .map((i) => ({ ...i, s: i.start_pos ?? i.start, e: i.end_pos ?? i.end, priority: 1, isIssue: true }))
    .filter((i) => Number.isInteger(i.s) && Number.isInteger(i.e) && i.s >= 0 && i.e > i.s && i.e <= text.length)

  // Prioritaskan saran AI lalu temuan dengan prioritas lebih tinggi; hindari overlap
  const allCandidates = [...aiMarks, ...deterministicMarks.value]
    .sort((a, b) => a.priority - b.priority || a.s - b.s || (b.e - b.s) - (a.e - a.s))

  const chosen = []
  const overlaps = (a, b) => a.s < b.e && b.s < a.e
  for (const cand of allCandidates) {
    if (chosen.some((c) => overlaps(c, cand))) continue
    chosen.push(cand)
  }
  chosen.sort((a, b) => a.s - b.s)

  let pos = 0
  for (const item of chosen) {
    if (item.s < pos) continue
    if (item.s > pos) out.push({ t: text.slice(pos, item.s) })
    out.push({ t: text.slice(item.s, item.e), mark: item })
    pos = item.e
  }
  out.push({ t: text.slice(pos) })
  return out
})

const cat = (i) => CATEGORIES[canon(i.category || i.type)]

function markStyle(m) {
  if (m.isIssue) {
    const color = cat(m).color
    if (props.selected === m.id) return { background: '#000000', color: '#FFFFFF', borderColor: '#000000' }
    return {
      background: statusOf(m) === 'applied' ? `${color}47` : `${color}26`,
      borderColor: statusOf(m) === 'applied' ? color : `${color}99`,
    }
  }
  return {
    background: m.bg,
    borderColor: m.color,
  }
}

const label = (m) => (m.isIssue ? `${cat(m).label} - ${m.snippet || ''}` : m.title)
</script>

<template>
  <div class="whitespace-pre-wrap break-words text-[16px] leading-[1.9] text-black">
    <template v-for="(p, idx) in parts" :key="idx">
      <mark
        v-if="p.mark && p.mark.isIssue"
        :id="'m-' + p.mark.id"
        role="button"
        tabindex="0"
        :aria-label="label(p.mark)"
        :title="cat(p.mark).label"
        class="swiss-mark scroll-mt-24 border-b-2"
        :style="markStyle(p.mark)"
        @click="emit('pick', p.mark.id)"
        @keydown.enter.prevent="emit('pick', p.mark.id)"
        @keydown.space.prevent="emit('pick', p.mark.id)"
      >{{ p.t }}</mark>
      <mark
        v-else-if="p.mark"
        :title="p.mark.title"
        class="rounded-[2px] border-b-2 px-0.5 text-inherit"
        :style="markStyle(p.mark)"
      >{{ p.t }}</mark>
      <span v-else>{{ p.t }}</span>
    </template>
  </div>
</template>
