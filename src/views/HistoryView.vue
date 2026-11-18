<script setup>
import { ref, computed, onMounted } from 'vue'
import { useRouter } from 'vue-router'
import BaseButton from '../components/BaseButton.vue'
import BaseModal from '../components/BaseModal.vue'
import SectionLabel from '../components/SectionLabel.vue'
import { documents } from '../store/documents'

const router = useRouter()
const docs = ref([])
const q = ref('')
const statusFilter = ref('') // '' | 'analyzed' | 'revising'
const loading = ref(true)
const error = ref('')
const target = ref(null)
const selected = ref(new Set())
const notice = ref('')
const confirmMulti = ref(false)

const filtered = computed(() => {
  if (!statusFilter.value) return docs.value
  return docs.value.filter((d) => d.status === statusFilter.value)
})

const fmt = (t) => (t ? new Date(t).toLocaleString('id-ID', { dateStyle: 'medium', timeStyle: 'short' }) : '-')

function statusLabel(d) {
  if (d.status === 'revising') return 'Sudah Direvisi'
  return 'Selesai Dianalisis'
}

async function load() {
  loading.value = true
  error.value = ''
  try {
    const { documents: list } = await documents.list(q.value.trim(), statusFilter.value)
    docs.value = list || []
  } catch (e) {
    error.value = e.message || 'Gagal memuat riwayat.'
  } finally {
    loading.value = false
  }
}

let deb
function onSearch() {
  clearTimeout(deb)
  deb = setTimeout(load, 300)
}

function setStatus(s) {
  statusFilter.value = s
  selected.value = new Set()
  load()
}

function say(msg) {
  notice.value = msg
  clearTimeout(say.t)
  say.t = setTimeout(() => { notice.value = '' }, 2600)
}

function openResult(id) {
  router.push({ name: 'result', params: { id } })
}

function toggle(id) {
  const s = new Set(selected.value)
  s.has(id) ? s.delete(id) : s.add(id)
  selected.value = s
}

function toggleAll() {
  selected.value = selected.value.size === filtered.value.length ? new Set() : new Set(filtered.value.map((d) => d.id))
}

async function removeIds(ids) {
  try {
    await documents.removeMany(ids)
    say(ids.length > 1 ? `${ids.length} dokumen dihapus.` : 'Dokumen dihapus.')
    selected.value = new Set()
    target.value = null
    confirmMulti.value = false
    await load()
  } catch (e) {
    error.value = e.message
  }
}

onMounted(load)
</script>

<template>
  <section class="mx-auto max-w-6xl px-4 py-10 sm:px-6 md:py-12">
    <div class="grid gap-6 md:grid-cols-[5fr_7fr] md:items-end">
      <div>
        <SectionLabel>Riwayat Analisis</SectionLabel>
        <h1 class="mt-4 text-5xl font-black uppercase leading-[0.9] tracking-tighter md:text-6xl">
          Dokumenmu
        </h1>
      </div>
      <div class="space-y-3">
        <div class="relative">
          <i class="fa-solid fa-magnifying-glass absolute left-4 top-1/2 -translate-y-1/2 text-sm"></i>
          <input
            v-model="q"
            placeholder="CARI NAMA DOKUMEN..."
            class="h-12 w-full border-2 border-black bg-white pl-11 pr-3 text-sm font-bold uppercase tracking-wide placeholder:text-black/30 focus:border-[#FF3000] focus:outline-none"
            @input="onSearch"
          />
        </div>
        <!-- Filter Status Sederhana -->
        <div class="flex flex-wrap gap-2">
          <button
            v-for="opt in [
              { id: '', label: 'Semua Status' },
              { id: 'analyzed', label: 'Selesai Dianalisis' },
              { id: 'revising', label: 'Sudah Direvisi' },
            ]"
            :key="opt.id"
            type="button"
            :class="[
              'border-2 px-3 py-1 font-mono text-[11px] font-bold uppercase tracking-widest transition-colors',
              statusFilter === opt.id ? 'border-black bg-black text-white' : 'border-black/25 bg-white text-black/70 hover:border-black hover:text-black',
            ]"
            @click="setStatus(opt.id)"
          >
            {{ opt.label }}
          </button>
        </div>
      </div>
    </div>

    <p v-if="notice" class="mt-6 flex items-center gap-3 border-2 border-black bg-black px-4 py-3 text-sm font-bold uppercase tracking-wide text-white">
      <span class="flex h-6 w-6 items-center justify-center bg-[#FF3000]"><i class="fa-solid fa-check text-xs"></i></span>{{ notice }}
    </p>
    <p v-if="error" class="mt-6 border-2 border-black bg-black px-4 py-3 text-sm font-bold uppercase tracking-wide text-white">
      <span class="text-[#FF3000]">■</span> {{ error }}
    </p>

    <div v-if="loading" class="mt-8 border-4 border-black bg-[#F2F2F2] p-10 text-center font-mono text-sm uppercase tracking-widest">
      <i class="fa-solid fa-circle-notch fa-spin mr-2"></i>Memuat riwayat dokumen...
    </div>

    <template v-else>
      <div v-if="filtered.length" class="mt-8">
        <div class="mb-4 flex flex-wrap items-center justify-between gap-2">
          <div class="flex flex-wrap items-center gap-2">
            <button type="button" class="border-2 border-black px-3 py-1.5 font-mono text-xs font-bold uppercase tracking-widest hover:bg-black hover:text-white" @click="toggleAll">
              {{ selected.size === filtered.length ? 'Batal Pilih Semua' : 'Pilih Semua' }}
            </button>
            <button
              v-if="selected.size"
              type="button"
              class="border-2 border-[#FF3000] bg-[#FF3000] px-3 py-1.5 font-mono text-xs font-bold uppercase tracking-widest text-white hover:border-black hover:bg-black"
              @click="confirmMulti = true"
            >
              Hapus {{ selected.size }} Terpilih
            </button>
          </div>
          <p class="font-mono text-xs uppercase tracking-widest text-black/50">
            Menampilkan {{ filtered.length }} dokumen · Retensi 30 hari
          </p>
        </div>

        <div class="border-t-4 border-black">
          <div class="flex flex-col gap-3 py-5">
            <div
              v-for="d in filtered"
              :key="d.id"
              class="flex flex-col gap-4 border-2 border-black bg-white p-5 transition-colors hover:bg-[#F2F2F2] sm:flex-row sm:items-center"
            >
              <input
                type="checkbox"
                :checked="selected.has(d.id)"
                class="h-5 w-5 shrink-0 accent-[#FF3000]"
                :aria-label="'Pilih ' + d.title"
                @change="toggle(d.id)"
              />

              <div class="min-w-0 flex-1">
                <div class="flex flex-wrap items-center gap-2">
                  <h2 class="truncate text-lg font-black uppercase tracking-tight">{{ d.title }}</h2>
                  <span
                    :class="[
                      'px-2 py-0.5 font-mono text-[10px] font-bold uppercase tracking-widest',
                      d.status === 'revising' ? 'bg-black text-white' : 'border border-black/30 bg-[#F2F2F2] text-black/80',
                    ]"
                  >
                    {{ statusLabel(d) }}
                  </span>
                </div>

                <div class="mt-2 flex flex-wrap items-center gap-x-4 gap-y-1 font-mono text-xs uppercase tracking-wider text-black/65">
                  <span><i class="fa-regular fa-file-word mr-1 text-black/45"></i>{{ (d.word_count || 0).toLocaleString('id-ID') }} kata</span>
                  <span><i class="fa-solid fa-coins mr-1 text-[#FF3000]"></i>{{ d.token_cost || 1 }} token</span>
                  <span><i class="fa-regular fa-calendar mr-1 text-black/45"></i>{{ fmt(d.created_at || d.updated_at) }}</span>
                  <span><i class="fa-solid fa-list-check mr-1 text-black/45"></i>{{ d.pending_count }} temuan aktif</span>
                </div>
              </div>

              <div class="flex flex-wrap items-center gap-2">
                <button
                  type="button"
                  class="min-h-[42px] border-2 border-black bg-black px-4 py-2 text-xs font-bold uppercase tracking-widest text-white transition-colors hover:border-[#FF3000] hover:bg-[#FF3000]"
                  @click="openResult(d.id)"
                >
                  <i class="fa-solid fa-arrow-up-right-from-square mr-1.5"></i>Buka Hasil
                </button>
                <router-link
                  :to="`/dokumen/${d.id}`"
                  class="inline-flex min-h-[42px] items-center border-2 border-black bg-white px-3 py-2 text-xs font-bold uppercase tracking-widest hover:bg-black hover:text-white"
                  title="Detail & Ganti Judul"
                >
                  Detail
                </router-link>
                <button
                  type="button"
                  class="flex min-h-[42px] min-w-[42px] items-center justify-center border-2 border-black px-3 py-2 text-sm hover:border-[#FF3000] hover:bg-[#FF3000] hover:text-white"
                  aria-label="Hapus dokumen"
                  @click="target = d"
                >
                  <i class="fa-regular fa-trash-can"></i>
                </button>
              </div>
            </div>
          </div>
        </div>
      </div>

      <div v-else class="mt-8 flex flex-col items-center border-4 border-black bg-[#F2F2F2] px-6 py-16 text-center">
        <span class="mb-6 flex h-20 w-20 items-center justify-center border-2 border-black bg-white">
          <i class="fa-regular fa-folder-open text-3xl"></i>
        </span>
        <p class="font-black uppercase tracking-tight">
          {{ q || statusFilter ? 'Tidak ada dokumen yang cocok dengan pencarian/filter.' : 'Belum ada dokumen yang dianalisis.' }}
        </p>
        <p class="mb-6 mt-1 text-sm text-black/60">
          Setiap dokumen yang berhasil dianalisis akan tersimpan otomatis selama 30 hari.
        </p>
        <BaseButton to="/analisis">Mulai Analisis Baru</BaseButton>
      </div>
    </template>

    <BaseModal :open="!!target" title="Hapus Dokumen Ini?" @close="target = null">
      <p class="border-l-4 border-[#FF3000] bg-[#F2F2F2] p-4 text-sm">
        "{{ target?.title }}" akan dihapus permanen dan tidak bisa dipulihkan.
      </p>
      <div class="mt-6 flex justify-end gap-2">
        <BaseButton variant="secondary" size="sm" @click="target = null">Batal</BaseButton>
        <BaseButton variant="accent" size="sm" @click="removeIds([target.id])">Hapus</BaseButton>
      </div>
    </BaseModal>

    <BaseModal :open="confirmMulti" title="Hapus Dokumen Terpilih?" @close="confirmMulti = false">
      <p class="border-l-4 border-[#FF3000] bg-[#F2F2F2] p-4 text-sm">
        {{ selected.size }} dokumen akan dihapus permanen.
      </p>
      <div class="mt-6 flex justify-end gap-2">
        <BaseButton variant="secondary" size="sm" @click="confirmMulti = false">Batal</BaseButton>
        <BaseButton variant="accent" size="sm" @click="removeIds([...selected])">Hapus Semua</BaseButton>
      </div>
    </BaseModal>
  </section>
</template>
