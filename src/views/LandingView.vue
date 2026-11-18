<script setup>
import { ref, onMounted, onBeforeUnmount } from 'vue'
import BaseButton from '../components/BaseButton.vue'
import SectionLabel from '../components/SectionLabel.vue'
import FeatureCard from '../components/FeatureCard.vue'
import { CATEGORIES } from '../utils/categories'
import { auth } from '../store/auth'

const desc = {
  repetition: 'Kata yang sama muncul berkali-kali? Ditandai beserta alternatifnya.',
  sentence_pattern: 'Kalimat yang terlalu panjang atau berpola sama dipecah agar enak dibaca.',
  uniform_structure: 'Rangkaian kalimat berstruktur seragam ditandai agar ritmenya bervariasi.',
  transition: 'Kata transisi yang hilang atau dipakai berulang ditinjau ulang.',
  formality: 'Kata tidak baku seperti "gak" atau "banget" disarankan bentuk bakunya.',
  style_consistency: 'Campuran kata ganti atau gaya (mis. "saya" vs "aku") diingatkan.',
}

const flowSteps = [
  { id: '01', label: 'Tempel', detail: 'Tulis langsung atau unggah berkas dokumen', icon: 'fa-paste' },
  { id: '02', label: 'Periksa', detail: 'Deteksi bagian yang berulang & kaku', icon: 'fa-magnifying-glass' },
  { id: '03', label: 'Perbaiki', detail: 'Terapkan saran perbaikan yang sesuai', icon: 'fa-wand-magic-sparkles' },
  { id: '04', label: 'Unduh', detail: 'Simpan naskah bersih ke PDF, DOCX, atau TXT', icon: 'fa-arrow-down-long' },
]

const activeFlow = ref(0)
let flowTimer = null

onMounted(() => {
  flowTimer = setInterval(() => {
    activeFlow.value = (activeFlow.value + 1) % flowSteps.length
  }, 2400)
})

onBeforeUnmount(() => {
  if (flowTimer) clearInterval(flowTimer)
})

const steps = [
  { n: '01', t: 'Tempel atau unggah tulisan', d: 'Tempel teks langsung atau unggah TXT/DOCX/PDF (maks 5 MB). Jumlah kata dan biaya token dihitung otomatis.' },
  { n: '02', t: 'Lihat seluruh temuan', d: 'Semua bagian bermasalah digarisbawahi sesuai kategorinya beserta penjelasan dan saran perbaikan lengkap.' },
  { n: '03', t: 'Perbaiki & unduh hasil', d: 'Terapkan saran satu per satu atau sekaligus, lalu unduh hasilnya dalam format PDF, DOCX, atau TXT.' },
]

const keys = Object.keys(CATEGORIES)
const heroImage = import.meta.env.BASE_URL + 'images/yunani.png'
</script>

<template>
  <div>
    <section class="border-b-4 border-black">
      <div class="mx-auto grid max-w-6xl md:grid-cols-[7.5fr_4.5fr]">
        <div class="px-4 py-14 sm:px-6 md:py-24">
          <SectionLabel>01 / Sistem - Analisis pola tulisan</SectionLabel>
          <h1 class="mt-6 text-6xl font-black uppercase leading-[0.9] tracking-tighter sm:text-7xl md:text-8xl">
            Tulisanmu,<br />lebih <span class="bg-[#FF3000] px-2 text-white">runut</span>.
          </h1>
          <p class="mt-6 max-w-xl text-base leading-relaxed text-black/70">
            Untuk tugas, esai, skripsi, atau laporan berbahasa Indonesia yang terasa monoton.
            Tempel ke sini, lihat bagian mana yang perlu dibenahi beserta penjelasan spesifik dan saran perbaikannya.
          </p>
          <div class="mt-8 flex flex-col gap-3 sm:flex-row">
            <BaseButton :to="auth.user ? '/analisis' : '/daftar'" size="lg">
              {{ auth.user ? 'Buka Editor Analisis' : 'Daftar & Mulai' }} <i class="fa-solid fa-arrow-right text-xs"></i>
            </BaseButton>
            <BaseButton to="/tentang" variant="secondary" size="lg">Tentang Website</BaseButton>
          </div>
          <div class="mt-10 flex flex-wrap gap-6 border-t-2 border-black pt-6">
            <p class="font-mono text-xs uppercase tracking-widest"><span class="text-2xl font-black">6</span><br />Kategori diperiksa</p>
            <p class="font-mono text-xs uppercase tracking-widest"><span class="text-2xl font-black">Token</span><br />Tanpa langganan</p>
            <p class="font-mono text-xs uppercase tracking-widest"><span class="text-2xl font-black">ID</span><br />Bhs. Indonesia</p>
          </div>
        </div>

        <div class="relative hidden min-h-[500px] overflow-hidden border-l-4 border-black bg-[#F2F2F2] md:flex" aria-hidden="true">
          <img
            :src="heroImage"
            alt=""
            class="absolute inset-0 h-full w-full object-cover"
          />
          <div class="swiss-diagonal absolute inset-0"></div>

          <!-- Panel Alur Kerja Interaktif & Beranimasi (Clean Swiss Style) -->
          <div class="absolute bottom-6 left-6 right-6 border-2 border-black bg-white">
            <!-- Bar Progres Mekanis -->
            <div class="h-1 w-full bg-black/10">
              <div
                class="h-full bg-[#FF3000] transition-all duration-500 ease-out"
                :style="{ width: `${((activeFlow + 1) / flowSteps.length) * 100}%` }"
              ></div>
            </div>

            <!-- Baris 4 Tahap -->
            <div class="grid grid-cols-4 divide-x-2 divide-black border-b-2 border-black">
              <button
                v-for="(item, idx) in flowSteps"
                :key="item.id"
                type="button"
                class="group flex flex-col items-start px-2.5 py-2.5 text-left transition-colors duration-200"
                :class="activeFlow === idx ? 'bg-black text-white' : 'bg-white text-black hover:bg-[#F2F2F2]'"
                @mouseenter="activeFlow = idx"
                @click="activeFlow = idx"
              >
                <div class="flex w-full items-center justify-between">
                  <span
                    class="font-mono text-[10px] font-bold tracking-widest"
                    :class="activeFlow === idx ? 'text-[#FF3000]' : 'text-black/40'"
                  >
                    {{ item.id }}
                  </span>
                  <span
                    class="h-1.5 w-1.5 transition-transform duration-200"
                    :class="activeFlow === idx ? 'scale-125 bg-[#FF3000]' : 'bg-black/20'"
                  ></span>
                </div>
                <span class="mt-1 text-[11px] font-black uppercase tracking-tight">
                  {{ item.label }}
                </span>
              </button>
            </div>

            <!-- Keterangan Tahap Aktif dengan Transisi Halus -->
            <div class="flex items-center justify-between gap-3 bg-[#F2F2F2] px-3.5 py-2.5">
              <transition name="fade" mode="out-in">
                <div :key="activeFlow" class="flex min-w-0 items-center gap-2.5">
                  <span class="flex h-6 w-6 shrink-0 items-center justify-center border border-black bg-white text-[10px] text-[#FF3000]">
                    <i :class="['fa-solid', flowSteps[activeFlow].icon]"></i>
                  </span>
                  <p class="truncate font-mono text-[11px] font-bold uppercase tracking-wider text-black/80">
                    {{ flowSteps[activeFlow].detail }}
                  </p>
                </div>
              </transition>
              <span class="shrink-0 font-mono text-[10px] font-bold uppercase tracking-widest text-black/40">
                {{ activeFlow + 1 }}/{{ flowSteps.length }}
              </span>
            </div>
          </div>
        </div>
      </div>
    </section>

    <section class="mx-auto max-w-6xl px-4 py-16 sm:px-6 md:py-24">
      <SectionLabel>02 / Yang diperiksa - Enam hal</SectionLabel>
      <div class="mt-6 grid gap-8 md:grid-cols-[5fr_7fr] md:items-end">
        <h2 class="text-4xl font-black uppercase leading-[0.95] tracking-tighter md:text-6xl">Bukan cek typo. Cek kebiasaan.</h2>
        <p class="text-black/70 md:pb-1">Enam kategori analisis sesuai rancangan: pengulangan kata, pola kalimat, struktur seragam, transisi, formalitas, dan konsistensi gaya.</p>
      </div>
      <div class="mt-10 grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
        <FeatureCard v-for="(k, i) in keys" :key="k" :icon="CATEGORIES[k].icon" :title="CATEGORIES[k].label" :desc="desc[k]" :num="CATEGORIES[k].num || `0${i + 1}`" />
      </div>
    </section>

    <section class="border-y-4 border-black bg-[#F2F2F2]">
      <div class="swiss-diagonal mx-auto grid max-w-6xl md:grid-cols-[5fr_7fr]">
        <div class="border-b-4 border-black p-8 md:border-b-0 md:border-r-4 md:p-12">
          <SectionLabel>03 / Caranya</SectionLabel>
          <h2 class="mt-6 text-4xl font-black uppercase leading-[0.95] tracking-tighter md:text-5xl">Alur ringkas, tiga langkah.</h2>
        </div>
        <div>
          <div v-for="s in steps" :key="s.n" class="swiss-snap group flex gap-6 border-b-4 border-black bg-white p-8 last:border-b-0 hover:bg-black hover:text-white md:p-10">
            <p class="font-mono text-4xl font-black text-[#FF3000]">{{ s.n }}</p>
            <div>
              <h3 class="text-xl font-black uppercase tracking-tight">{{ s.t }}</h3>
              <p class="mt-2 text-sm opacity-70">{{ s.d }}</p>
            </div>
            <i class="fa-solid fa-plus ml-auto self-start text-xl transition-transform duration-200 group-hover:rotate-90 group-hover:text-[#FF3000]"></i>
          </div>
        </div>
      </div>
    </section>

    <section class="mx-auto max-w-6xl px-4 py-16 sm:px-6 md:py-24">
      <div class="border-4 border-black bg-black p-8 text-white md:p-16">
        <SectionLabel>04 / Sistem Token Fleksibel</SectionLabel>
        <h2 class="mt-6 max-w-3xl text-4xl font-black uppercase leading-[0.95] tracking-tighter md:text-7xl">Bayar sesuai kebutuhanmu.</h2>
        <p class="mt-4 max-w-xl text-white/70">
          Tanpa langganan bulanan dan tanpa fitur yang dikunci. Tersedia pilihan paket 5 token (Rp5.000), 10 token (Rp9.000), dan 20 token (Rp16.000).
        </p>
        <div class="mt-8 flex flex-col gap-3 sm:flex-row">
          <BaseButton :to="auth.user ? '/analisis' : '/daftar'" variant="accent" size="lg">
            {{ auth.user ? 'Mulai Analisis' : 'Buat Akun Sekarang' }}
          </BaseButton>
          <BaseButton :to="auth.user ? '/token' : '/tentang'" variant="ghost" size="lg" class="!border-white !text-white hover:!bg-white hover:!text-black">
            {{ auth.user ? 'Isi Token' : 'Tentang Runut' }}
          </BaseButton>
        </div>
      </div>
    </section>
  </div>
</template>
