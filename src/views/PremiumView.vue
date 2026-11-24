<script setup>
import { ref, computed, onMounted, onBeforeUnmount } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import BaseButton from '../components/BaseButton.vue'
import BaseCard from '../components/BaseCard.vue'
import SectionLabel from '../components/SectionLabel.vue'
import { api, fetchBlob, downloadFile } from '../utils/api'
import { auth } from '../store/auth'
import { job } from '../store/analysis'
import { TOKEN_PACKAGES } from '../utils/categories'

const route = useRoute()
const router = useRouter()

const info = ref(null)
const orders = ref([])
const ledger = ref([])
const loading = ref(true)
const error = ref('')
const notice = ref('')
const selectedPackageId = ref('populer')
const method = ref('')
const order = ref(null)
const creating = ref(false)
const checking = ref(false)
const manualChecking = ref(false)
const cancelling = ref(false)
const deletingOrderId = ref('')
const renewing = ref(false)
const renewFailed = ref(false)
const qrUrl = ref('')
const remainingSeconds = ref(0)
const paymentSectionEl = ref(null)
let poll = null
let countdownTimer = null
let serverClockOffsetMs = 0

const formattedCountdown = computed(() => {
  const s = Math.max(0, Math.floor(remainingSeconds.value || 0))
  const mm = String(Math.floor(s / 60)).padStart(2, '0')
  const ss = String(s % 60).padStart(2, '0')
  return `${mm}:${ss}`
})

const fmtIdr = (n) => 'Rp' + Number(n || 0).toLocaleString('id-ID')
const fmtDate = (t) => (t ? new Date(t).toLocaleString('id-ID', { dateStyle: 'medium', timeStyle: 'short' }) : '-')

const packages = computed(() => info.value?.packages?.length ? info.value.packages : TOKEN_PACKAGES)
const selectedPackage = computed(() => packages.value.find((p) => p.id === selectedPackageId.value) || packages.value[1] || packages.value[0])
const available = computed(() => Boolean(info.value?.available))
const methods = computed(() => info.value?.methods || [])
const tokenBalance = computed(() => Math.max(0, Number(auth.user?.token_balance) || 0))
const hasDraft = computed(() => Boolean(job.draft?.text?.trim()))

const STATUS = {
  pending: { label: 'Menunggu pembayaran', cls: 'bg-[#F2F2F2] text-black' },
  paid: { label: 'Lunas', cls: 'bg-black text-white' },
  failed: { label: 'Gagal', cls: 'bg-[#FF3000] text-white' },
  expired: { label: 'Kedaluwarsa', cls: 'bg-[#FF3000] text-white' },
  cancelled: { label: 'Dibatalkan', cls: 'bg-[#FF3000] text-white' },
  refunded: { label: 'Dikembalikan', cls: 'bg-[#F2F2F2] text-black' },
}
const statusOf = (s) => STATUS[s] || { label: s, cls: 'bg-[#F2F2F2] text-black' }

function pickPackage(pkgId, scrollToMethod = false) {
  selectedPackageId.value = pkgId
  if (scrollToMethod && paymentSectionEl.value) {
    paymentSectionEl.value.scrollIntoView({ behavior: 'smooth', block: 'start' })
  }
}

async function copy(value) {
  try {
    await navigator.clipboard.writeText(String(value))
    notice.value = 'Nomor berhasil disalin ke papan klip.'
  } catch {
    error.value = 'Gagal menyalin. Salin secara manual dari teks di atas.'
  }
}

function stopPoll() {
  if (poll) clearInterval(poll)
  poll = null
}

function stopCountdown() {
  if (countdownTimer) clearInterval(countdownTimer)
  countdownTimer = null
}

function syncClockOffset(payment) {
  if (payment?.server_time) {
    const serverMs = Date.parse(payment.server_time)
    if (Number.isFinite(serverMs)) {
      serverClockOffsetMs = serverMs - Date.now()
    }
  }
}

function computeRemainingSec(payment) {
  if (!payment || payment.status !== 'pending' || !payment.expires_at) return 0
  const expMs = Date.parse(payment.expires_at)
  if (!Number.isFinite(expMs)) return 0
  const syncedNow = Date.now() + serverClockOffsetMs
  return Math.max(0, Math.floor((expMs - syncedNow) / 1000))
}

async function renewExpiredQris(silent = false) {
  if (!order.value || order.value.channel !== 'qris' || renewing.value) return
  renewing.value = true
  renewFailed.value = false
  error.value = ''
  if (!silent) {
    notice.value = 'QRIS sebelumnya telah kedaluwarsa. Membuat kode pembayaran baru.'
  }
  try {
    const data = await api(`/api/payments/${order.value.order_id}/renew`, { method: 'POST', body: {} })
    apply(data.payment, data.token_balance)
    if (data.already_paid) {
      notice.value = 'Pembayaran berhasil.'
      return
    }
    if (data.renewed && data.payment?.order_id) {
      router.replace({ name: 'tokens', query: { ...route.query, order: data.payment.order_id } })
      await loadQr()
      startPoll()
      startCountdown()
      notice.value = 'QRIS sebelumnya telah kedaluwarsa. Kode pembayaran baru berlaku 10 menit.'
    }
  } catch (e) {
    renewFailed.value = true
    error.value = e.message || 'Gagal memperbarui kode QRIS otomatis. Klik tombol "Buat Kode QRIS Baru" untuk mencoba lagi.'
  } finally {
    renewing.value = false
  }
}

function startCountdown() {
  stopCountdown()
  if (!order.value || order.value.channel !== 'qris' || order.value.status !== 'pending') {
    remainingSeconds.value = 0
    return
  }
  const tick = () => {
    const left = computeRemainingSec(order.value)
    remainingSeconds.value = left
    if (left <= 0) {
      stopCountdown()
      if (order.value?.status === 'pending' && order.value?.channel === 'qris' && !renewing.value) {
        renewExpiredQris(false)
      }
    }
  }
  tick()
  if (remainingSeconds.value > 0) {
    countdownTimer = setInterval(tick, 1000)
  }
}

function startPoll() {
  stopPoll()
  if (order.value?.status !== 'pending') return
  poll = setInterval(() => check(true), 10000)
}

async function refreshLedger() {
  try {
    const data = await api('/api/tokens/transactions?limit=30')
    const rawTx = data.transactions || []
    const refundedIds = new Set(
      rawTx
        .filter((t) => t.reference_type === 'analysis_refund' && t.reference_id)
        .map((t) => t.reference_id),
    )
    ledger.value = rawTx
      .filter((t) => t.reference_type !== 'analysis_refund' && !refundedIds.has(t.id))
      .slice(0, 15)
    if (data.balance !== undefined) auth.setBalance(data.balance)
  } catch { /* abaikan */ }
}

function apply(payment, newBalance) {
  syncClockOffset(payment)
  const wasPending = order.value?.order_id === payment.order_id && order.value?.status === 'pending'
  order.value = payment
  const i = orders.value.findIndex((o) => o.order_id === payment.order_id)
  if (i >= 0) orders.value[i] = payment
  else if (payment.order_id) orders.value.unshift(payment)

  if (newBalance !== undefined) auth.setBalance(newBalance)

  if (payment.status !== 'pending') {
    stopPoll()
    stopCountdown()
    remainingSeconds.value = 0
    if (payment.status === 'paid') {
      const added = payment.token_amount ? `+${payment.token_amount} token` : 'Token'
      if (wasPending || !notice.value) {
        notice.value = `Pembayaran berhasil. ${added} telah ditambahkan ke saldo Anda.`
      }
      auth.refreshProfile()
      refreshLedger()
    }
  } else if (payment.channel === 'qris') {
    startCountdown()
  }
}

async function loadQr() {
  if (qrUrl.value) { URL.revokeObjectURL(qrUrl.value); qrUrl.value = '' }
  if (order.value?.channel !== 'qris' || !order.value?.instructions?.qr_url) return
  try {
    qrUrl.value = URL.createObjectURL(await fetchBlob(`/api/payments/${order.value.order_id}/qr`))
  } catch {
    qrUrl.value = ''
  }
}

async function check(silent = true) {
  if (!order.value || checking.value) return
  checking.value = true
  if (!silent) manualChecking.value = true
  try {
    const { payment, token_balance } = await api(`/api/payments/${order.value.order_id}`)
    apply(payment, token_balance)
    if (!silent && payment.status === 'pending') {
      notice.value = 'Pembayaran belum diterima dari gateway. Coba lagi beberapa saat setelah menyelesaikan pembayaran.'
    }
  } catch (e) {
    if (!silent) error.value = e.message
  } finally {
    checking.value = false
    manualChecking.value = false
  }
}

async function create() {
  error.value = ''
  notice.value = ''
  if (!selectedPackageId.value) { error.value = 'Pilih paket token terlebih dahulu.'; return }
  if (!method.value) { error.value = 'Pilih metode pembayaran terlebih dahulu.'; return }
  creating.value = true
  try {
    const { payment } = await api('/api/payments', {
      method: 'POST',
      body: {
        package_id: selectedPackageId.value,
        method: method.value,
      },
    })
    apply(payment)
    router.replace({ name: 'tokens', query: { ...route.query, order: payment.order_id } })
    await loadQr()
    startPoll()
    if (payment.channel === 'card' && info.value?.mode === 'midtrans' && payment.instructions?.redirect_url) {
      window.open(payment.instructions.redirect_url, '_blank', 'noopener')
    }
  } catch (e) {
    error.value = e.message || 'Transaksi tidak bisa dibuat.'
  } finally {
    creating.value = false
  }
}

async function openOrder(row) {
  error.value = ''
  notice.value = ''
  apply(row)
  router.replace({ name: 'tokens', query: { ...route.query, order: row.order_id } })
  await loadQr()
  startPoll()
  if (row.status === 'pending') await check()
}

async function cancelOrder() {
  if (!order.value || order.value.status !== 'pending' || cancelling.value) return
  cancelling.value = true
  error.value = ''
  notice.value = ''
  stopPoll()
  stopCountdown()
  try {
    const { payment } = await api(`/api/payments/${order.value.order_id}/cancel`, { method: 'POST' })
    apply(payment)
    if (qrUrl.value) { URL.revokeObjectURL(qrUrl.value); qrUrl.value = '' }
    const nextQuery = { ...route.query }
    delete nextQuery.order
    router.replace({ name: 'tokens', query: nextQuery })
    notice.value = 'Pembelian berhasil dibatalkan. Anda dapat memilih paket atau metode pembayaran lain.'
  } catch (e) {
    error.value = e.message || 'Gagal membatalkan transaksi.'
    if (order.value?.status === 'pending') {
      startPoll()
      if (order.value.channel === 'qris') startCountdown()
    }
  } finally {
    cancelling.value = false
  }
}

async function deleteOrder(row) {
  if (!row?.order_id || deletingOrderId.value) return
  deletingOrderId.value = row.order_id
  error.value = ''
  notice.value = ''
  try {
    await api(`/api/payments/${row.order_id}`, { method: 'DELETE' })
    orders.value = orders.value.filter((o) => o.order_id !== row.order_id)
    if (order.value?.order_id === row.order_id) {
      stopPoll()
      stopCountdown()
      if (qrUrl.value) { URL.revokeObjectURL(qrUrl.value); qrUrl.value = '' }
      order.value = null
      const nextQuery = { ...route.query }
      delete nextQuery.order
      router.replace({ name: 'tokens', query: nextQuery })
    }
    notice.value = 'Riwayat pembayaran berhasil dihapus.'
  } catch (e) {
    error.value = e.message || 'Gagal menghapus riwayat pembayaran.'
  } finally {
    deletingOrderId.value = ''
  }
}

async function invoice(row) {
  try {
    await downloadFile(`/api/payments/${row.order_id}/invoice`, `invoice-${row.order_id}.pdf`)
  } catch (e) {
    error.value = e.message
  }
}

onMounted(async () => {
  try {
    const [payData] = await Promise.all([
      api('/api/payments'),
      refreshLedger(),
      auth.refreshProfile(),
    ])
    info.value = payData
    orders.value = payData.orders || []
    if (payData.token_balance !== undefined) auth.setBalance(payData.token_balance)
    if (payData.methods?.length) method.value = payData.methods[0].id

    const wanted = String(route.query.order || '')
    if (wanted) {
      const known = orders.value.find((o) => o.order_id === wanted)
      if (known) await openOrder(known)
      else {
        const { payment, token_balance } = await api(`/api/payments/${wanted}`)
        apply(payment, token_balance)
        await loadQr()
        startPoll()
      }
    } else {
      // Pulihkan transaksi QRIS pending yang masih aktif bila pengguna refresh halaman
      const activeQris = orders.value.find((o) => o.channel === 'qris' && o.status === 'pending')
      if (activeQris) await openOrder(activeQris)
    }
  } catch (e) {
    error.value = e.message || 'Data pembayaran tidak bisa dimuat.'
  } finally {
    loading.value = false
  }
})

onBeforeUnmount(() => {
  stopPoll()
  stopCountdown()
  if (qrUrl.value) URL.revokeObjectURL(qrUrl.value)
})
</script>

<template>
  <section class="mx-auto max-w-6xl px-4 py-10 sm:px-6 md:py-12">
    <!-- Header & Ringkasan Saldo -->
    <div class="flex flex-col gap-6 border-b-4 border-black pb-8 md:flex-row md:items-end md:justify-between">
      <div>
        <SectionLabel>Pembelian Token</SectionLabel>
        <h1 class="mt-4 text-5xl font-black uppercase leading-[0.9] tracking-tighter md:text-6xl">
          Isi Token
        </h1>
        <p class="mt-4 max-w-2xl text-sm leading-relaxed text-black/70">
          Beli token sesuai kebutuhan tanpa langganan bulanan. Token tidak memiliki masa kedaluwarsa dan hanya terpakai saat Anda menjalankan analisis tulisan.
        </p>
      </div>

      <div class="flex flex-wrap items-center gap-3">
        <div class="border-4 border-black bg-[#F2F2F2] px-5 py-3">
          <p class="font-mono text-[10px] uppercase tracking-widest text-black/55">Token Tersedia</p>
          <p class="mt-0.5 text-3xl font-black uppercase tracking-tight">
            <i class="fa-solid fa-coins mr-2 text-[#FF3000]"></i>{{ tokenBalance }} Token
          </p>
        </div>
        <BaseButton v-if="hasDraft || route.query.redirect === '/analisis'" to="/analisis" variant="secondary">
          <i class="fa-solid fa-arrow-left"></i>Kembali ke Draf Analisis
        </BaseButton>
      </div>
    </div>

    <!-- Status Gateway & Notifikasi -->
    <p v-if="!loading && !available" class="mt-6 border-2 border-black bg-[#FF3000] px-4 py-3 text-sm font-bold uppercase tracking-wide text-white" role="alert">
      <span class="text-white">■</span> Pembelian token belum tersedia: kredensial Midtrans (MIDTRANS_SERVER_KEY) belum dikonfigurasi di server.
    </p>

    <div v-if="notice" class="mt-6 flex flex-wrap items-center justify-between gap-3 border-4 border-black bg-black px-5 py-4 text-white" role="status">
      <div class="flex items-center gap-3 text-sm font-bold uppercase tracking-wide">
        <span class="flex h-7 w-7 shrink-0 items-center justify-center bg-[#FF3000]"><i class="fa-solid fa-check text-xs"></i></span>
        <span>{{ notice }}</span>
      </div>
      <BaseButton to="/analisis" variant="accent" size="sm">
        <i class="fa-solid fa-arrow-right"></i>{{ hasDraft ? 'Lanjutkan Analisis Draf' : 'Mulai Analisis' }}
      </BaseButton>
    </div>

    <p v-if="error" class="mt-6 flex items-center gap-3 border-2 border-black bg-black px-4 py-3 text-sm font-bold uppercase tracking-wide text-white" role="alert">
      <span class="flex h-6 w-6 shrink-0 items-center justify-center bg-[#FF3000]"><i class="fa-solid fa-triangle-exclamation text-xs"></i></span>{{ error }}
    </p>

    <!-- Pilihan 3 Paket Token -->
    <div class="mt-8">
      <p class="font-mono text-xs font-bold uppercase tracking-widest text-[#FF3000]">01 / Pilih Paket Token</p>
      <div class="mt-4 grid gap-6 md:grid-cols-3">
        <div
          v-for="pkg in packages"
          :key="pkg.id"
          :class="[
            'relative flex flex-col justify-between border-4 p-6 transition-colors sm:p-7',
            selectedPackageId === pkg.id
              ? 'border-black bg-black text-white'
              : 'border-black bg-white text-black hover:bg-[#F2F2F2]',
          ]"
        >
          <span
            v-if="pkg.popular"
            class="absolute -top-3.5 right-4 border-2 border-black bg-[#FF3000] px-2.5 py-0.5 font-mono text-[10px] font-bold uppercase tracking-widest text-white"
          >
            Paling Populer
          </span>

          <div>
            <p :class="['font-mono text-xs font-bold uppercase tracking-widest', selectedPackageId === pkg.id ? 'text-[#FF3000]' : 'text-black/55']">
              Paket {{ pkg.name }}
            </p>
            <div class="mt-3 flex items-baseline gap-2">
              <span class="text-5xl font-black tracking-tighter tabular-nums">{{ pkg.tokens }}</span>
              <span class="font-mono text-sm font-bold uppercase tracking-widest">Token</span>
            </div>

            <div :class="['mt-4 border-t-2 pt-4', selectedPackageId === pkg.id ? 'border-white/20' : 'border-black/15']">
              <p class="text-3xl font-black tracking-tight tabular-nums">{{ fmtIdr(pkg.price_idr) }}</p>
            </div>

            <p :class="['mt-4 text-xs leading-relaxed', selectedPackageId === pkg.id ? 'text-white/75' : 'text-black/70']">
              {{ pkg.description }}
            </p>
          </div>

          <button
            type="button"
            :class="[
              'mt-6 min-h-[44px] w-full border-2 px-4 py-2.5 font-mono text-xs font-bold uppercase tracking-widest transition-colors',
              selectedPackageId === pkg.id
                ? 'border-[#FF3000] bg-[#FF3000] text-white hover:border-white hover:bg-white hover:text-black'
                : 'border-black bg-black text-white hover:border-[#FF3000] hover:bg-[#FF3000]',
            ]"
            @click="pickPackage(pkg.id, true)"
          >
            <i class="fa-solid fa-coins mr-1.5"></i>
            {{ selectedPackageId === pkg.id ? `Paket Dipilih · Beli ${pkg.tokens} Token` : `Beli Token (${fmtIdr(pkg.price_idr)})` }}
          </button>
        </div>
      </div>
    </div>

    <!-- Metode Pembayaran & Konfirmasi Pesanan -->
    <div ref="paymentSectionEl" class="mt-10 scroll-mt-24">
      <p class="font-mono text-xs font-bold uppercase tracking-widest text-[#FF3000]">02 / Pilih Metode Pembayaran</p>
      <div class="mt-4 grid gap-6 lg:grid-cols-[7fr_5fr]">
        <BaseCard class="p-6 sm:p-8">
          <p class="font-black uppercase tracking-tight">Metode Pembayaran</p>
          <p v-if="loading" class="mt-4 font-mono text-xs uppercase tracking-widest text-black/50">
            <i class="fa-solid fa-circle-notch fa-spin mr-2"></i>Memuat metode pembayaran...
          </p>
          <ul v-else class="mt-4 grid gap-2.5 sm:grid-cols-2">
            <li v-for="m in methods" :key="m.id">
              <button
                type="button"
                :disabled="!available"
                :aria-pressed="method === m.id"
                :class="[
                  'flex w-full items-center gap-3 border-2 px-3 py-2.5 text-left transition-colors disabled:opacity-40',
                  method === m.id ? 'border-black bg-black text-white' : 'border-black/20 hover:border-black',
                ]"
                @click="method = m.id"
              >
                <span :class="['flex h-8 w-8 shrink-0 items-center justify-center border-2', method === m.id ? 'border-white' : 'border-black/20']">
                  <i :class="['fa-solid', m.icon]"></i>
                </span>
                <span class="min-w-0">
                  <span class="block truncate text-sm font-bold uppercase tracking-wide">{{ m.label }}</span>
                  <span :class="['block font-mono text-[10px] uppercase tracking-widest', method === m.id ? 'text-white/60' : 'text-black/45']">
                    {{ m.note || m.group }}
                  </span>
                </span>
              </button>
            </li>
          </ul>
        </BaseCard>

        <!-- Ringkasan Pesanan -->
        <BaseCard class="flex flex-col justify-between p-6 sm:p-8">
          <div>
            <p class="font-mono text-xs uppercase tracking-widest text-[#FF3000]">Ringkasan Pembelian</p>
            <h2 class="mt-2 text-2xl font-black uppercase tracking-tight">
              Paket {{ selectedPackage?.name }} ({{ selectedPackage?.tokens }} Token)
            </h2>

            <dl class="mt-5 space-y-3 border-t-2 border-black pt-4 text-sm">
              <div class="flex justify-between">
                <dt class="text-black/60">Jumlah token didapat</dt>
                <dd class="font-mono font-bold">{{ selectedPackage?.tokens }} Token</dd>
              </div>
              <div class="flex justify-between">
                <dt class="text-black/60">Total setelah pembelian</dt>
                <dd class="font-mono font-bold text-[#FF3000]">{{ tokenBalance + (selectedPackage?.tokens || 0) }} Token</dd>
              </div>
              <div class="flex justify-between border-t-2 border-black pt-3 text-base font-black uppercase">
                <dt>Total Tagihan</dt>
                <dd class="tabular-nums">{{ fmtIdr(selectedPackage?.price_idr) }}</dd>
              </div>
            </dl>
          </div>

          <div class="mt-6">
            <BaseButton
              class="w-full"
              variant="accent"
              :disabled="!available || creating || (order && order.status === 'pending')"
              @click="create"
            >
              <i :class="['fa-solid', creating ? 'fa-circle-notch fa-spin' : 'fa-cart-shopping']"></i>
              {{ creating ? 'Membuat Transaksi...' : `Beli ${selectedPackage?.tokens} Token · ${fmtIdr(selectedPackage?.price_idr)}` }}
            </BaseButton>
            <p v-if="order && order.status === 'pending'" class="mt-3 text-xs text-black/60">
              Transaksi aktif sedang menunggu pembayaran di bawah.
              <button type="button" class="font-bold underline" @click="order = null; stopPoll()">Buat pesanan baru</button>
            </p>
          </div>
        </BaseCard>
      </div>
    </div>

    <!-- Instruksi Pembayaran Transaksi Aktif -->
    <BaseCard v-if="order" class="mt-8 border-4 p-6 sm:p-8">
      <div class="flex flex-wrap items-center justify-between gap-3 border-b-2 border-black pb-4">
        <div>
          <p class="font-mono text-xs uppercase tracking-widest text-[#FF3000]">Pesanan {{ order.order_id }}</p>
          <p class="mt-1 text-xl font-black uppercase tracking-tight">
            Paket {{ order.package_label || 'Token' }} ({{ order.token_amount }} Token) · {{ order.method_label }} · {{ fmtIdr(order.amount) }}
          </p>
        </div>
        <span :class="['px-2.5 py-1 font-mono text-xs font-bold uppercase tracking-widest', statusOf(order.status).cls]">
          {{ statusOf(order.status).label }}
        </span>
      </div>

      <!-- QRIS Dinamis (Masa berlaku 10 menit + Live Countdown + Auto-Refresh) -->
      <div v-if="order.channel === 'qris'" class="mt-5 flex flex-col gap-6 sm:flex-row sm:items-center">
        <div class="relative flex flex-col items-center">
          <p class="mb-2 font-mono text-[10px] font-bold uppercase tracking-widest text-black/60">SCAN QRIS UNTUK MEMBAYAR</p>
          <div class="relative">
            <img
              v-if="qrUrl && order.status === 'pending' && remainingSeconds > 0"
              :src="qrUrl"
              alt="Kode QRIS pembayaran"
              class="qr-keep-light h-56 w-56 border-2 border-black bg-white p-2"
            />
            <div
              v-else-if="renewing"
              class="flex h-56 w-56 flex-col items-center justify-center gap-2 border-2 border-black bg-[#F2F2F2] p-4 text-center font-mono text-[11px] font-bold uppercase tracking-wider"
            >
              <i class="fa-solid fa-circle-notch fa-spin text-2xl text-[#FF3000]"></i>
              <span>Membuat kode QRIS baru...</span>
            </div>
            <div
              v-else-if="order.status === 'paid'"
              class="flex h-56 w-56 flex-col items-center justify-center gap-2 border-2 border-black bg-black p-4 text-center font-mono text-xs font-bold uppercase tracking-widest text-white"
            >
              <i class="fa-solid fa-circle-check text-3xl text-[#FF3000]"></i>
              <span>Pembayaran Berhasil</span>
            </div>
            <div
              v-else
              class="flex h-56 w-56 flex-col items-center justify-center gap-2 border-2 border-dashed border-black bg-[#F2F2F2] p-4 text-center font-mono text-[10px] uppercase tracking-widest text-black/60"
            >
              <i class="fa-solid fa-clock text-xl text-[#FF3000]"></i>
              <span>{{ order.status === 'expired' ? 'QRIS Kedaluwarsa' : 'Kode QR tersedia pada payment gateway' }}</span>
            </div>
          </div>
        </div>

        <div class="flex-1 text-sm leading-relaxed">
          <div v-if="order.status === 'pending'" class="mb-4 inline-flex flex-col border-2 border-black bg-[#F2F2F2] px-4 py-2.5">
            <span class="font-mono text-[10px] font-bold uppercase tracking-widest text-black/60">QRIS berlaku selama:</span>
            <span
              class="mt-0.5 font-mono text-3xl font-black tracking-widest tabular-nums"
              :class="remainingSeconds <= 60 ? 'text-[#FF3000]' : 'text-black'"
            >
              {{ formattedCountdown }}
            </span>
          </div>

          <p class="font-bold uppercase tracking-wide">Pindai kode QRIS dengan aplikasi e-wallet atau mobile banking Anda.</p>
          <p class="mt-1 text-black/70">Nominal pembayaran: <strong>{{ fmtIdr(order.amount) }}</strong> untuk <strong>{{ order.token_amount }} Token</strong>.</p>
          <p class="mt-1 font-mono text-xs uppercase tracking-widest text-black/60">Status: <strong>{{ statusOf(order.status).label }}</strong></p>
          <p v-if="order.expires_at" class="mt-1 font-mono text-xs uppercase tracking-widest text-black/50">Berlaku sampai {{ fmtDate(order.expires_at) }}</p>

          <div v-if="renewFailed || order.status === 'expired'" class="mt-4">
            <BaseButton size="sm" variant="accent" :disabled="renewing" @click="renewExpiredQris(false)">
              <i :class="['fa-solid', renewing ? 'fa-circle-notch fa-spin' : 'fa-arrows-rotate']"></i>
              Buat Kode QRIS Baru (10 Menit)
            </BaseButton>
          </div>
        </div>
      </div>

      <!-- Virtual Account -->
      <div v-else-if="order.channel === 'va'" class="mt-5">
        <p class="font-mono text-xs uppercase tracking-widest text-black/60">Nomor Virtual Account {{ order.instructions.bank ? '· ' + String(order.instructions.bank).toUpperCase() : '' }}</p>
        <div class="mt-2 flex flex-wrap items-center gap-2">
          <span class="border-2 border-black px-4 py-2 text-2xl font-black tabular-nums tracking-wider">{{ order.instructions.va_number || '—' }}</span>
          <button type="button" class="min-h-[44px] border-2 border-black px-3 py-2 text-xs font-bold uppercase tracking-widest hover:bg-black hover:text-white" @click="copy(order.instructions.va_number)">
            <i class="fa-solid fa-copy mr-1"></i>Salin Nomor VA
          </button>
        </div>
        <p class="mt-3 text-sm text-black/70">Transfer tepat <strong>{{ fmtIdr(order.amount) }}</strong>. Setelah pembayaran berhasil, {{ order.token_amount }} token akan otomatis masuk ke saldo Anda.</p>
      </div>

      <!-- Minimarket -->
      <div v-else-if="order.channel === 'cstore'" class="mt-5">
        <p class="font-mono text-xs uppercase tracking-widest text-black/60">Kode Pembayaran {{ String(order.instructions.store || '').toUpperCase() }}</p>
        <div class="mt-2 flex flex-wrap items-center gap-2">
          <span class="border-2 border-black px-4 py-2 text-2xl font-black tabular-nums tracking-wider">{{ order.instructions.payment_code || '—' }}</span>
          <button type="button" class="min-h-[44px] border-2 border-black px-3 py-2 text-xs font-bold uppercase tracking-widest hover:bg-black hover:text-white" @click="copy(order.instructions.payment_code)">
            <i class="fa-solid fa-copy mr-1"></i>Salin Kode
          </button>
        </div>
        <p class="mt-3 text-sm text-black/70">Tunjukkan kode ini di kasir dan bayar <strong>{{ fmtIdr(order.amount) }}</strong> untuk paket {{ order.token_amount }} token.</p>
      </div>

      <!-- E-wallet -->
      <div v-else-if="order.channel === 'ewallet'" class="mt-5">
        <a v-if="order.instructions.deeplink" :href="order.instructions.deeplink" target="_blank" rel="noopener" class="inline-block border-2 border-black bg-black px-4 py-2 text-xs font-bold uppercase tracking-widest text-white hover:border-[#FF3000] hover:bg-[#FF3000]">
          <i class="fa-solid fa-arrow-up-right-from-square mr-1"></i>Buka Aplikasi {{ order.method_label }}
        </a>
        <p class="mt-3 text-sm text-black/70">Selesaikan pembayaran {{ fmtIdr(order.amount) }} di aplikasi untuk menambahkan {{ order.token_amount }} token.</p>
      </div>

      <!-- Kartu -->
      <div v-else-if="order.channel === 'card'" class="mt-5">
        <a v-if="order.instructions.redirect_url" :href="order.instructions.redirect_url" target="_blank" rel="noopener" class="inline-block border-2 border-black bg-black px-4 py-2 text-xs font-bold uppercase tracking-widest text-white hover:border-[#FF3000] hover:bg-[#FF3000]">
          <i class="fa-solid fa-credit-card mr-1"></i>Buka Halaman Pembayaran Kartu
        </a>
        <p class="mt-3 text-sm text-black/70">Pembayaran kartu diproses secara aman melalui halaman payment gateway.</p>
      </div>

      <div class="mt-5 flex flex-col gap-2.5 border-t-2 border-black pt-4 sm:flex-row sm:flex-wrap sm:items-center">
        <BaseButton
          v-if="order.status === 'pending'"
          size="sm"
          class="w-full justify-center sm:w-auto"
          :disabled="manualChecking || cancelling"
          @click="check(false)"
        >
          <i :class="['fa-solid', manualChecking ? 'fa-circle-notch fa-spin' : 'fa-rotate-right']"></i>Periksa Status
        </BaseButton>
        <BaseButton
          v-if="order.status === 'pending'"
          variant="secondary"
          size="sm"
          class="w-full justify-center border-[#FF3000] text-[#FF3000] hover:bg-[#FF3000] hover:text-white sm:w-auto"
          :disabled="cancelling"
          @click="cancelOrder"
        >
          <i :class="['fa-solid', cancelling ? 'fa-circle-notch fa-spin' : 'fa-xmark']"></i>
          {{ cancelling ? 'Membatalkan...' : 'Batalkan Pembelian' }}
        </BaseButton>
        <BaseButton v-if="order.status === 'paid'" variant="secondary" size="sm" class="w-full justify-center sm:w-auto" @click="invoice(order)">
          <i class="fa-solid fa-file-invoice"></i>Unduh Invoice PDF
        </BaseButton>
        <span v-if="order.status === 'pending'" class="font-mono text-[10px] uppercase tracking-widest text-black/50 sm:ml-auto">
          Status diperiksa otomatis setiap 10 detik
        </span>
        <BaseButton v-if="order.status === 'paid'" size="sm" variant="accent" class="w-full justify-center sm:w-auto" to="/analisis">
          <i class="fa-solid fa-arrow-right"></i>{{ hasDraft ? 'Kembali ke Draf Analisis' : 'Mulai Analisis' }}
        </BaseButton>
      </div>
    </BaseCard>

    <!-- Riwayat Pesanan Pembelian Token & Mutasi Saldo -->
    <div class="mt-10 grid gap-6 lg:grid-cols-2">
      <BaseCard>
        <p class="border-b-2 border-black px-4 py-3 font-black uppercase tracking-tight">Riwayat Pembayaran Token</p>
        <ul v-if="orders.length" class="divide-y-2 divide-black/10">
          <li v-for="o in orders" :key="o.order_id" class="flex flex-col gap-2.5 px-4 py-3 text-sm sm:flex-row sm:items-center sm:justify-between">
            <div class="min-w-0 flex-1">
              <p class="truncate font-bold uppercase tracking-wide">
                Paket {{ o.package_label || 'Token' }} · +{{ o.token_amount || 0 }} Token
              </p>
              <p class="break-all font-mono text-[11px] uppercase tracking-widest text-black/50 sm:break-normal">
                {{ o.order_id }} · {{ o.method_label }} · {{ fmtIdr(o.amount) }} · {{ fmtDate(o.created_at) }}
              </p>
            </div>
            <div class="flex flex-wrap items-center gap-2">
              <span :class="['px-2 py-1 font-mono text-[10px] font-bold uppercase tracking-widest', statusOf(o.status).cls]">
                {{ statusOf(o.status).label }}
              </span>
              <button type="button" class="min-h-[34px] border-2 border-black px-2.5 py-1 font-mono text-[10px] font-bold uppercase tracking-widest hover:bg-black hover:text-white" @click="openOrder(o)">
                {{ o.status === 'pending' ? 'Instruksi' : 'Detail' }}
              </button>
              <button type="button" class="min-h-[34px] border-2 border-black px-2.5 py-1 font-mono text-[10px] font-bold uppercase tracking-widest hover:bg-black hover:text-white" @click="invoice(o)">
                Invoice
              </button>
              <button
                type="button"
                class="inline-flex h-[34px] w-[34px] shrink-0 items-center justify-center border-2 border-black/30 text-black/60 transition-colors hover:border-[#FF3000] hover:bg-[#FF3000] hover:text-white disabled:opacity-40"
                :disabled="deletingOrderId === o.order_id"
                aria-label="Hapus riwayat pembayaran"
                title="Hapus riwayat pembayaran"
                @click="deleteOrder(o)"
              >
                <i :class="['fa-solid text-xs', deletingOrderId === o.order_id ? 'fa-circle-notch fa-spin' : 'fa-trash-can']"></i>
              </button>
            </div>
          </li>
        </ul>
        <p v-else class="p-6 text-center font-mono text-xs uppercase tracking-widest text-black/50">
          Belum ada transaksi pembelian token.
        </p>
      </BaseCard>

      <BaseCard>
        <p class="border-b-2 border-black px-4 py-3 font-black uppercase tracking-tight">Riwayat Transaksi Token</p>
        <ul v-if="ledger.length" class="divide-y-2 divide-black/10">
          <li v-for="tx in ledger" :key="tx.id" class="flex items-center justify-between gap-3 px-4 py-3 text-sm">
            <div class="min-w-0 flex-1">
              <p class="truncate font-bold uppercase tracking-wide">{{ tx.description }}</p>
              <p class="font-mono text-[11px] uppercase tracking-widest text-black/50">
                {{ fmtDate(tx.created_at) }} · Sisa: {{ tx.balance_after }} token
              </p>
            </div>
            <span
              :class="[
                'shrink-0 border-2 px-2 py-0.5 font-mono text-xs font-bold tabular-nums',
                tx.amount > 0 ? 'border-black bg-black text-white' : 'border-black bg-[#F2F2F2] text-black',
              ]"
            >
              {{ tx.amount > 0 ? `+${tx.amount}` : tx.amount }} Token
            </span>
          </li>
        </ul>
        <p v-else class="p-6 text-center font-mono text-xs uppercase tracking-widest text-black/50">
          Belum ada riwayat penggunaan atau pengisian token.
        </p>
      </BaseCard>
    </div>
  </section>
</template>
