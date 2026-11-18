<script setup>
import { CATEGORIES, canon } from '../utils/categories'
const props = defineProps({
  issue: Object,
  index: { type: Number, default: 1 },
  selected: Boolean,
  busy: Boolean,
})
defineEmits(['accept', 'reject', 'reset', 'pick', 'locate'])

const meta = CATEGORIES[canon(props.issue.category || props.issue.type)]
const status = () => props.issue.decision || 'active'
const badge = () => {
  const s = status()
  return s === 'applied' ? 'Diterapkan' : s === 'rejected' ? 'Ditolak' : ''
}
</script>

<template>
  <article
    :id="'s-' + issue.id"
    :class="[
      'swiss-snap scroll-mt-32 border bg-white',
      selected
        ? 'border-2 border-[#FF3000] bg-[#FFFDFC]'
        : 'border-black/15 hover:border-black/45',
      status() === 'rejected' && 'opacity-60',
    ]"
  >
    <div :class="['flex items-center gap-2 border-b px-3.5 py-2.5 transition-colors duration-200', selected ? 'border-[#FF3000]/20 bg-[#FFF7F4]' : 'border-black/10 bg-[#FAFAFA]']">
      <span class="font-mono text-[10px] font-bold tabular-nums text-black/40">{{ String(index).padStart(2, '0') }}</span>
      <span class="h-2.5 w-2.5 shrink-0" :style="{ background: meta.color }" aria-hidden="true"></span>
      <span class="min-w-0 truncate text-[11px] font-bold uppercase tracking-wider text-black/85">{{ meta.label }}</span>
      <span
        v-if="badge()"
        :class="[
          'ml-auto shrink-0 px-2 py-0.5 font-mono text-[9px] font-bold uppercase leading-none tracking-wider',
          status() === 'applied' ? 'bg-black text-white' : 'border border-black/25 text-black/55',
        ]"
      >
        {{ badge() }}
      </span>
      <span v-else-if="issue.needs_manual_review" class="ml-auto shrink-0 border border-black/40 bg-white px-1.5 py-0.5 font-mono text-[9px] font-bold uppercase leading-none tracking-wider text-black/80">
        Cek manual
      </span>
      <button
        type="button"
        class="swiss-snap-fast flex h-7 w-7 shrink-0 items-center justify-center border border-black/15 bg-white text-[10px] text-black/55 hover:border-black hover:bg-black hover:text-white"
        :class="{ 'ml-auto': !badge() && !issue.needs_manual_review }"
        :aria-label="'Lihat temuan ' + index + ' di teks'"
        title="Sorot posisi di teks asli"
        @click.stop="$emit('locate', issue.id)"
      >
        <i class="fa-solid fa-location-crosshairs"></i>
      </button>
    </div>

    <div class="px-3.5 py-3.5">
      <button type="button" class="block w-full text-left" @click="$emit('pick', issue.id)">
        <p class="border-l-2 pl-3 font-mono text-[11px] leading-relaxed text-black/55" :style="{ borderColor: meta.color }">
          "{{ issue.snippet }}"
        </p>
        <div class="mt-2.5 border border-black/10 bg-[#F5F5F5] px-3 py-2.5 text-[13px] font-medium leading-relaxed text-black">
          <span class="mr-1.5 font-mono text-[9px] font-bold uppercase tracking-widest text-[#FF3000]">Saran →</span>{{ issue.suggestion }}
        </div>
      </button>

      <p class="mt-2.5 text-[12px] leading-relaxed text-black/65">
        {{ issue.explanation }}
      </p>
    </div>

    <div v-if="status() === 'active'" class="flex gap-2 px-3.5 pb-3.5" :aria-busy="busy">
      <button
        type="button"
        :disabled="busy"
        class="swiss-snap min-h-[36px] flex-1 border border-[#FF3000] bg-[#FF3000] px-3 text-[10px] font-bold uppercase tracking-widest text-white hover:border-black hover:bg-black active:translate-y-[1px] disabled:opacity-40"
        @click.stop="$emit('accept', issue)"
      >
        <i class="fa-solid fa-check mr-1 text-[10px]"></i>Terapkan
      </button>
      <button
        type="button"
        :disabled="busy"
        class="swiss-snap min-h-[36px] flex-1 border border-black/20 bg-white px-3 text-[10px] font-bold uppercase tracking-widest text-black/70 hover:border-black hover:text-black active:translate-y-[1px] disabled:opacity-40"
        @click.stop="$emit('reject', issue)"
      >
        <i class="fa-solid fa-xmark mr-1 text-[10px]"></i>Tolak
      </button>
    </div>
    <div v-else class="flex items-center justify-between gap-2 border-t border-black/10 bg-[#FAFAFA] px-3.5 py-2">
      <span class="font-mono text-[10px] uppercase tracking-wider text-black/50">
        {{ status() === 'applied' ? 'Sudah diterapkan ke revisi' : 'Saran diabaikan' }}
      </span>
      <button
        type="button"
        :disabled="busy"
        class="swiss-snap-fast font-mono text-[10px] font-bold uppercase tracking-widest text-black/80 underline decoration-[#FF3000] decoration-2 underline-offset-2 hover:text-[#FF3000] disabled:opacity-40"
        @click.stop="$emit('reset', issue)"
      >
        Batalkan
      </button>
    </div>
  </article>
</template>
