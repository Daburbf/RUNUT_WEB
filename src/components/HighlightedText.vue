<script setup>
import { computed } from 'vue'
import { canon, CATEGORIES } from '../utils/categories'
const props = defineProps({ text: String, issues: Array, selected: String })
const emit = defineEmits(['pick'])

const statusOf = (i) => i.decision || 'active'

// Potong teks memakai posisi dari server. Sorotan yang bertumpuk dilewati agar
// karakter dan urutan teks tidak berubah (pemetaan tetap milik backend).
const parts = computed(() => {
  const out = []
  let pos = 0
  const list = [...(props.issues || [])]
    .filter((i) => statusOf(i) !== 'rejected')
    .map((i) => ({ ...i, s: i.start_pos ?? i.start, e: i.end_pos ?? i.end }))
    .filter((i) => Number.isInteger(i.s) && Number.isInteger(i.e) && i.s >= 0 && i.e > i.s && i.e <= (props.text || '').length)
    .sort((a, b) => a.s - b.s)
  for (const i of list) {
    if (i.s < pos) continue
    if (i.s > pos) out.push({ t: props.text.slice(pos, i.s) })
    out.push({ t: props.text.slice(i.s, i.e), issue: i })
    pos = i.e
  }
  out.push({ t: (props.text || '').slice(pos) })
  return out
})

const cat = (i) => CATEGORIES[canon(i.category || i.type)]

// Latar lembut (15% warna kategori) supaya teks tetap terbaca; yang sudah
// diterapkan dibuat lebih pekat, yang dipilih jadi blok hitam.
function markStyle(i) {
  const color = cat(i).color
  if (props.selected === i.id) return { background: '#000000', color: '#FFFFFF', borderColor: '#000000' }
  return {
    background: statusOf(i) === 'applied' ? `${color}47` : `${color}26`,
    borderColor: statusOf(i) === 'applied' ? color : `${color}99`,
  }
}

const label = (i) => `${cat(i).label} - ${i.snippet || ''}`
</script>

<template>
  <div class="whitespace-pre-wrap break-words text-[16px] leading-[1.85] text-black">
    <template v-for="(p, idx) in parts" :key="idx">
      <mark v-if="p.issue" :id="'m-' + p.issue.id" role="button" tabindex="0"
        :aria-label="label(p.issue)" :title="cat(p.issue).label"
        class="swiss-mark scroll-mt-24 border-b-2"
        :style="markStyle(p.issue)"
        @click="emit('pick', p.issue.id)"
        @keydown.enter.prevent="emit('pick', p.issue.id)"
        @keydown.space.prevent="emit('pick', p.issue.id)">{{ p.t }}</mark>
      <span v-else>{{ p.t }}</span>
    </template>
  </div>
</template>
