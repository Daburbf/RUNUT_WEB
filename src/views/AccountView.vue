<script setup>
import { ref, computed, onMounted } from 'vue'
import { useRouter } from 'vue-router'
import BaseButton from '../components/BaseButton.vue'
import BaseCard from '../components/BaseCard.vue'
import SectionLabel from '../components/SectionLabel.vue'
import { auth } from '../store/auth'
import { api } from '../utils/api'
import { documents } from '../store/documents'

const router = useRouter()
const showLogout = ref(false)
const loading = ref(true)
const summary = ref({
  balance: 0,
  total_purchased: 0,
  total_used: 0,
  total_refunded: 0,
})
const transactions = ref([])
const recentDocs = ref([])

const fmtDate = (t) => (t ? new Date(t).toLocaleString('id-ID', { dateStyle: 'medium', timeStyle: 'short' }) : '-')

const balance = computed(() => Math.max(0, Number(auth.user?.token_balance ?? summary.value.balance) || 0))
const totalPurchased = computed(() => Number(auth.user?.total_purchased ?? summary.value.total_purchased) || 0)
const totalUsed = computed(() => Number(auth.user?.total_used ?? summary.value.total_used) || 0)

const TYPE_LABEL = {
  purchase: { label: 'Pembelian', cls: 'bg-black text-white' },
  usage: { label: 'Pemakaian Analisis', cls: 'bg-[#F2F2F2] text-black' },
  refund: { label: 'Pengembalian (Refund)', cls: 'bg-[#FF3000] text-white' },
}
const typeMeta = (t) => TYPE_LABEL[t] || { label: t, cls: 'bg-[#F2F2F2] text-black' }

async function loadAccountData() {
  loading.value = true
  try {
    const [, txRes, docRes] = await Promise.all([
      auth.refreshProfile(),
      api('/api/tokens/transactions?limit=30'),
      documents.list(),
    ])
    if (txRes?.summary) {
      summary.value = { balance: txRes.balance, ...txRes.summary }
    }
    transactions.value = txRes?.transactions || []
    recentDocs.value = (docRes?.documents || []).slice(0, 15)
  } catch { /* abaikan */ }
  finally { loading.value = false }
}

function logout() {
  auth.logout().finally(() => router.push('/'))
}

onMounted(loadAccountData)
</script>

<template>
  <section class="mx-auto max-w-6xl px-4 py-10 sm:px-6 md:py-12">
    <div class="flex flex-col gap-4 border-b-4 border-black pb-6 sm:flex-row sm:items-end sm:justify-between">
      <div>
        <SectionLabel>Akun & Token</SectionLabel>
        <h1 class="mt-4 text-5xl font-black uppercase leading-[0.9] tracking-tighter md:text-6xl">
          Kelola Akun
        </h1>
      </div>
      <div class="flex flex-wrap gap-2">
        <BaseButton to="/token" variant="accent" size="sm">
          <i class="fa-solid fa-coins"></i>Isi Token
        </BaseButton>
        <BaseButton to="/analisis" variant="secondary" size="sm">
          <i class="fa-solid fa-wand-magic-sparkles"></i>Analisis Baru
        </BaseButton>
        <BaseButton variant="secondary" size="sm" @click="showLogout = true">
          <i class="fa-solid fa-right-from-bracket"></i>Keluar
        </BaseButton>
      </div>
    </div>

    <div v-if="auth.user" class="mt-8 space-y-8">
      <!-- Profil & Ringkasan Statistik Token -->
      <div class="grid gap-6 md:grid-cols-[5fr_7fr]">
        <BaseCard class="p-6 sm:p-8">
          <p class="font-mono text-xs uppercase tracking-widest text-[#FF3000]">Profil Pengguna</p>
          <p class="mt-2 text-2xl font-black uppercase tracking-tight">{{ auth.user.name }}</p>
          <p class="mt-1 font-mono text-xs text-black/60">{{ auth.user.email }}</p>

          <p class="mt-5 border-t-2 border-black/10 pt-4 text-xs leading-relaxed text-black/70">
            Dokumen hasil analisis tersimpan otomatis selama 30 hari. Seluruh saldo dan mutasi token tercatat permanen di akun Anda.
          </p>
        </BaseCard>

        <div class="grid grid-cols-1 gap-4 sm:grid-cols-3">
          <BaseCard class="flex flex-col p-6">
            <p class="min-h-[2.25rem] font-mono text-xs leading-snug uppercase tracking-widest text-[#FF3000]">Token Tersedia</p>
            <p class="my-auto flex items-center gap-2.5 py-3 text-4xl font-black leading-none tabular-nums">
              <span>{{ balance }}</span>
              <i class="fa-solid fa-coins text-2xl text-[#FF3000]" aria-hidden="true"></i>
            </p>
            <p class="min-h-[2rem] font-mono text-[11px] leading-snug uppercase tracking-widest text-black/55">Token siap pakai</p>
          </BaseCard>

          <BaseCard class="flex flex-col p-6">
            <p class="min-h-[2.25rem] font-mono text-xs leading-snug uppercase tracking-widest text-black/55">Total Token Dibeli</p>
            <p class="my-auto flex items-center gap-2.5 py-3 text-4xl font-black leading-none tabular-nums">
              <span>{{ totalPurchased }}</span>
              <i class="fa-solid fa-coins text-2xl text-black/70" aria-hidden="true"></i>
            </p>
            <p class="min-h-[2rem] font-mono text-[11px] leading-snug uppercase tracking-widest text-black/55">Akumulasi pembelian</p>
          </BaseCard>

          <BaseCard class="flex flex-col p-6">
            <p class="min-h-[2.25rem] font-mono text-xs leading-snug uppercase tracking-widest text-black/55">Total Token Digunakan</p>
            <p class="my-auto flex items-center gap-2.5 py-3 text-4xl font-black leading-none tabular-nums">
              <span>{{ totalUsed }}</span>
              <i class="fa-solid fa-coins text-2xl text-black/70" aria-hidden="true"></i>
            </p>
            <p class="min-h-[2rem] font-mono text-[11px] leading-snug uppercase tracking-widest text-black/55">Untuk analisis tulisan</p>
          </BaseCard>
        </div>
      </div>

      <!-- Riwayat Transaksi Token & Riwayat Penggunaan Analisis -->
      <div class="grid gap-6 lg:grid-cols-2">
        <!-- Ledger Transaksi Token -->
        <BaseCard>
          <div class="flex items-center justify-between border-b-2 border-black px-5 py-4">
            <div>
              <p class="font-mono text-[10px] uppercase tracking-widest text-[#FF3000]">Ledger Token</p>
              <h2 class="text-lg font-black uppercase tracking-tight">Riwayat Transaksi Token</h2>
            </div>
            <router-link to="/token" class="font-mono text-xs font-bold uppercase tracking-widest underline decoration-[#FF3000] decoration-2 underline-offset-4">
              + Beli Token
            </router-link>
          </div>

          <div v-if="loading" class="p-8 text-center font-mono text-xs uppercase tracking-widest text-black/50">
            <i class="fa-solid fa-circle-notch fa-spin mr-2"></i>Memuat riwayat transaksi...
          </div>
          <ul v-else-if="transactions.length" class="divide-y-2 divide-black/10">
            <li v-for="tx in transactions" :key="tx.id" class="flex items-start justify-between gap-3 px-5 py-3.5 text-sm">
              <div class="min-w-0 flex-1">
                <div class="flex flex-wrap items-center gap-2">
                  <span :class="['px-1.5 py-0.5 font-mono text-[9px] font-bold uppercase tracking-widest', typeMeta(tx.type).cls]">
                    {{ typeMeta(tx.type).label }}
                  </span>
                  <span class="font-mono text-[10px] uppercase tracking-widest text-black/45">
                    {{ fmtDate(tx.created_at) }}
                  </span>
                </div>
                <p class="mt-1 font-bold uppercase tracking-wide">{{ tx.description }}</p>
                <p class="mt-0.5 font-mono text-[11px] uppercase tracking-widest text-black/50">
                  Saldo setelah transaksi: {{ tx.balance_after }} token
                  <template v-if="tx.reference_id"> · Ref: {{ tx.reference_id.slice(0, 18) }}</template>
                </p>
              </div>
              <span
                :class="[
                  'shrink-0 border-2 px-2.5 py-1 font-mono text-xs font-black tabular-nums',
                  tx.amount > 0 ? 'border-black bg-black text-white' : 'border-black bg-[#F2F2F2] text-black',
                ]"
              >
                {{ tx.amount > 0 ? `+${tx.amount}` : tx.amount }}
              </span>
            </li>
          </ul>
          <div v-else class="p-8 text-center">
            <p class="font-mono text-xs uppercase tracking-widest text-black/50">Belum ada riwayat transaksi token.</p>
            <BaseButton to="/token" size="sm" variant="accent" class="mt-4">Isi Token Pertama</BaseButton>
          </div>
        </BaseCard>

        <!-- Riwayat Penggunaan Analisis -->
        <BaseCard>
          <div class="flex items-center justify-between border-b-2 border-black px-5 py-4">
            <div>
              <p class="font-mono text-[10px] uppercase tracking-widest text-[#FF3000]">Aktivitas Analisis</p>
              <h2 class="text-lg font-black uppercase tracking-tight">Riwayat Penggunaan Analisis</h2>
            </div>
            <router-link to="/riwayat" class="font-mono text-xs font-bold uppercase tracking-widest underline decoration-[#FF3000] decoration-2 underline-offset-4">
              Semua Riwayat
            </router-link>
          </div>

          <div v-if="loading" class="p-8 text-center font-mono text-xs uppercase tracking-widest text-black/50">
            <i class="fa-solid fa-circle-notch fa-spin mr-2"></i>Memuat riwayat analisis...
          </div>
          <ul v-else-if="recentDocs.length" class="divide-y-2 divide-black/10">
            <li v-for="d in recentDocs" :key="d.id" class="flex items-center justify-between gap-3 px-5 py-3.5 text-sm">
              <div class="min-w-0 flex-1">
                <p class="truncate font-bold uppercase tracking-wide">{{ d.title }}</p>
                <p class="mt-0.5 font-mono text-[11px] uppercase tracking-widest text-black/50">
                  {{ d.word_count }} kata · {{ d.token_cost || 1 }} token · {{ fmtDate(d.created_at) }}
                </p>
              </div>
              <router-link
                :to="`/hasil/${d.id}`"
                class="shrink-0 border-2 border-black bg-black px-3 py-1.5 font-mono text-[10px] font-bold uppercase tracking-widest text-white hover:border-[#FF3000] hover:bg-[#FF3000]"
              >
                Buka Hasil
              </router-link>
            </li>
          </ul>
          <div v-else class="p-8 text-center">
            <p class="font-mono text-xs uppercase tracking-widest text-black/50">Belum ada dokumen yang dianalisis.</p>
            <BaseButton to="/analisis" size="sm" class="mt-4">Mulai Analisis</BaseButton>
          </div>
        </BaseCard>
      </div>
    </div>

    <!-- Modal Konfirmasi Keluar -->
    <div v-if="showLogout" class="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-4" @click.self="showLogout = false">
      <div class="w-full max-w-md border-4 border-black bg-white p-6">
        <p class="font-black uppercase tracking-tight">Yakin ingin keluar dari akun?</p>
        <p class="mt-2 text-sm text-black/60">Saldo token dan riwayat analisis Anda tetap tersimpan dengan aman.</p>
        <div class="mt-6 flex justify-end gap-2">
          <BaseButton variant="secondary" size="sm" @click="showLogout = false">Batal</BaseButton>
          <BaseButton variant="accent" size="sm" @click="logout">Keluar</BaseButton>
        </div>
      </div>
    </div>
  </section>
</template>
