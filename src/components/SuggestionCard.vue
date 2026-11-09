<script setup>
import { CATEGORIES, canon } from '../utils/categories'
const props = defineProps({
  issue: Object,
  index: { type: Number, default: 1 },
  selected: Boolean,
  busy: Boolean,
  locked: Boolean,
})
defineEmits(['accept', 'reject', 'pick', 'locate'])

const meta = CATEGORIES[canon(props.issue.category || props.issue.type)]
const status = () => props.issue.decision || 'active'
const badge = () => {
  const s = status()
  return s === 'applied' ? 'Diterapkan' : s === 'rejected' ? 'Ditolak' : ''
}
</script>

<template>
  <article :id="'s-' + issue.id" :class="['scroll-mt-24 border-2 transition-colors', selected ? 'border-[#FF3000]' : 'border-black/15 hover:border-black/40', status() === 'rejected' && 'opacity-60']">
    <div :class="['flex items-center gap-2 border-b-2 px-3 py-2', selected ? 'border-[#FF3000]/25 bg-[#FFF7F4]' : 'border-black/10']">
      <span class="font-mono text-[10px] font-bold tabular-nums text-black/40">{{ String(index).padStart(2, '0') }}</span>
      <span class="h-3 w-3 shrink-0" :style="{ background: meta.color }" aria-hidden="true"></span>
      <span class="min-w-0 truncate text-[10px] font-bold uppercase tracking-widest">{{ meta.label }}</span>
      <span v-if="badge()" :class="['ml-auto shrink-0 px-1.5 py-0.5 font-mono text-[9px] font-bold uppercase leading-none tracking-wider', status() === 'applied' ? 'bg-black text-white' : 'border-2 border-black/30 text-black/55']">{{ badge() }}</span>
      <span v-else-if="issue.needs_manual_review" class="ml-auto shrink-0 border-2 border-black px-1 py-0.5 font-mono text-[9px] font-bold uppercase leading-none tracking-wider">Cek manual</span>
      <button class="ml-auto flex h-8 w-8 shrink-0 items-center justify-center border-2 border-black/15 text-[10px] text-black/55 hover:border-black hover:text-black" :aria-label="'Lihat temuan ' + index + ' di teks'" title="Lihat di teks" @click.stop="$emit('locate', issue.id)">
        <i class="fa-solid fa-arrow-up-right-from-square"></i>
      </button>
    </div>

    <div class="px-3 py-3">
      <button class="block w-full text-left" @click="$emit('pick', issue.id)">
        <p class="border-l-[3px] pl-2.5 font-mono text-[11px] leading-relaxed text-black/55" :style="{ borderColor: meta.color }">"{{ issue.snippet }}"</p>
        <p v-if="!locked" class="mt-2.5 bg-black px-2.5 py-2 text-[13px] font-medium leading-snug text-white">{{ issue.suggestion }}</p>
        <p v-else class="mt-2.5 border-2 border-dashed border-black/20 px-2.5 py-2 text-[12px] leading-snug text-black/55">
          Saran perbaikan terkunci.
          <router-link to="/premium" class="font-bold uppercase tracking-wide underline decoration-[#FF3000] decoration-2 underline-offset-2">Premium</router-link>
        </p>
      </button>

      <details class="mt-2">
        <summary class="summary-plain inline-flex cursor-pointer items-center gap-1.5 py-1 font-mono text-[10px] uppercase tracking-widest text-black/45 hover:text-black">
          <i class="fa-solid fa-circle-info text-[10px]"></i>Alasan
        </summary>
        <p class="mt-1.5 text-[12px] leading-relaxed text-black/65">{{ issue.explanation }}</p>
      </details>
    </div>

    <div v-if="!locked && status() === 'active'" class="flex gap-2 px-3 pb-3" :aria-busy="busy">
      <button :disabled="busy" class="min-h-[38px] flex-1 border-2 border-[#FF3000] bg-[#FF3000] px-3 text-[10px] font-bold uppercase tracking-widest text-white transition-colors hover:border-black hover:bg-black disabled:opacity-40" @click.stop="$emit('accept', issue)">
        <i class="fa-solid fa-check mr-1 text-[10px]"></i>Terapkan
      </button>
      <button :disabled="busy" class="min-h-[38px] flex-1 border-2 border-black/20 px-3 text-[10px] font-bold uppercase tracking-widest text-black/70 transition-colors hover:border-black hover:text-black disabled:opacity-40" @click.stop="$emit('reject', issue)">
        <i class="fa-solid fa-xmark mr-1 text-[10px]"></i>Tolak
      </button>
    </div>
  </article>
</template>
