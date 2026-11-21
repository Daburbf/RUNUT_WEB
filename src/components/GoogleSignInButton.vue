<script setup>
import { onMounted, onUnmounted, ref } from 'vue'
import { api } from '../utils/api'

const props = defineProps({
  label: { type: String, default: 'Masuk dengan Google' },
  disabled: { type: Boolean, default: false },
})

const emit = defineEmits(['credential', 'error'])

const containerRef = ref(null)
const btnRef = ref(null)
const clientId = ref((import.meta.env.VITE_GOOGLE_CLIENT_ID || '').trim())
const ready = ref(false)
const loadingConfig = ref(true)
let alive = true

onUnmounted(() => {
  alive = false
})

function loadGsiScript() {
  if (window.google?.accounts?.id) return Promise.resolve()
  if (window.__runutGsiPromise) return window.__runutGsiPromise
  window.__runutGsiPromise = new Promise((resolve, reject) => {
    const s = document.createElement('script')
    s.src = 'https://accounts.google.com/gsi/client'
    s.async = true
    s.defer = true
    s.onload = () => resolve()
    s.onerror = () => {
      window.__runutGsiPromise = null
      reject(new Error('Gagal memuat skrip login Google.'))
    }
    document.head.appendChild(s)
  })
  return window.__runutGsiPromise
}

onMounted(async () => {
  try {
    if (!clientId.value) {
      const health = await api('/api/health').catch(() => null)
      if (health?.google_client_id) clientId.value = String(health.google_client_id).trim()
    }
    if (!clientId.value || !alive) return
    await loadGsiScript()
    if (!alive || !window.google?.accounts?.id || !btnRef.value) return
    const width = Math.min(400, Math.max(240, containerRef.value?.offsetWidth || 340))
    window.google.accounts.id.initialize({
      client_id: clientId.value,
      callback: (resp) => {
        if (resp?.credential) emit('credential', resp.credential)
        else emit('error', 'Token Google tidak diterima.')
      },
    })
    window.google.accounts.id.renderButton(btnRef.value, {
      theme: 'outline',
      size: 'large',
      width,
      text: 'continue_with',
      locale: 'id',
    })
    ready.value = true
  } catch (e) {
    if (alive) emit('error', e?.message || 'Gagal menyiapkan tombol Google.')
  } finally {
    if (alive) loadingConfig.value = false
  }
})

function handleFallbackClick() {
  if (!ready.value && !loadingConfig.value) {
    emit('error', 'Login Google belum dikonfigurasi di server (GOOGLE_CLIENT_ID).')
  }
}
</script>

<template>
  <div
    ref="containerRef"
    class="group relative w-full select-none"
    :class="{ 'pointer-events-none opacity-40': disabled }"
  >
    <!-- Tombol visual mengikuti tema Swiss Runut -->
    <button
      type="button"
      :disabled="disabled || loadingConfig"
      @click="handleFallbackClick"
      class="swiss-snap flex h-12 w-full items-center justify-center gap-2.5 rounded-none border-2 border-black bg-white px-6 text-sm font-bold uppercase tracking-widest text-black transition-colors group-hover:bg-black group-hover:text-white active:translate-y-[1px] disabled:pointer-events-none disabled:opacity-40"
    >
      <i class="fa-brands fa-google text-base text-[#FF3000]"></i>
      <span>{{ loadingConfig ? 'Menyiapkan Google...' : label }}</span>
    </button>

    <!-- Overlay iframe resmi Google GSI (transparan) agar popup Google tetap andal tanpa merusak tema -->
    <div
      v-show="ready"
      ref="btnRef"
      aria-hidden="true"
      class="absolute inset-0 z-10 flex cursor-pointer items-center justify-center overflow-hidden opacity-0 [&>div]:w-full [&_iframe]:!w-full [&_iframe]:scale-y-125"
    ></div>
  </div>
</template>
