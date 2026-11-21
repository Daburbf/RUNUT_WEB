<script setup>
import { ref, onUnmounted } from 'vue'
import AuthCard from '../components/AuthCard.vue'
import FormInput from '../components/FormInput.vue'
import BaseButton from '../components/BaseButton.vue'
import { api } from '../utils/api'

const step = ref('request') // 'request' | 'verify' | 'done'
const email = ref('')
const otp = ref('')
const password = ref('')
const confirm = ref('')
const msg = ref('')
const error = ref('')
const busy = ref(false)
const cooldown = ref(0)
let timer = null

onUnmounted(() => {
  if (timer) clearInterval(timer)
})

function startCooldown(sec = 60) {
  cooldown.value = sec
  if (timer) clearInterval(timer)
  timer = setInterval(() => {
    if (cooldown.value <= 1) {
      cooldown.value = 0
      clearInterval(timer)
      timer = null
    } else {
      cooldown.value -= 1
    }
  }, 1000)
}

async function submitEmail() {
  error.value = ''
  msg.value = ''
  if (!/^\S+@\S+\.\S+$/.test(email.value)) {
    error.value = 'Format email tidak valid. Periksa kembali penulisannya.'
    return
  }
  busy.value = true
  try {
    const r = await api('/api/auth/forgot-password', { method: 'POST', body: { email: email.value.trim() } })
    msg.value = r.message || 'Kode OTP dan tautan reset telah dikirim ke email Anda.'
    step.value = 'verify'
    startCooldown(60)
  } catch (e) {
    error.value = e.message
  } finally {
    busy.value = false
  }
}

async function submitReset() {
  error.value = ''
  msg.value = ''
  if (!/^\d{6}$/.test(otp.value.trim())) {
    error.value = 'Masukkan 6 digit kode OTP dari email Anda.'
    return
  }
  if (password.value.length < 8) {
    error.value = 'Kata sandi baru minimal 8 karakter.'
    return
  }
  if (password.value !== confirm.value) {
    error.value = 'Konfirmasi kata sandi tidak sama.'
    return
  }
  busy.value = true
  try {
    const r = await api('/api/auth/reset-password', {
      method: 'POST',
      body: { email: email.value.trim(), otp: otp.value.trim(), password: password.value },
    })
    msg.value = r.message || 'Kata sandi berhasil diubah. Silakan masuk kembali.'
    step.value = 'done'
  } catch (e) {
    error.value = e.message
  } finally {
    busy.value = false
  }
}
</script>

<template>
  <AuthCard
    title="Lupa sandi"
    :subtitle="step === 'verify' ? 'Masukkan kode OTP dari email dan kata sandi baru Anda.' : 'Verifikasi lewat email terdaftar (kode OTP berlaku 10 menit).'"
  >
    <form v-if="step === 'request'" class="space-y-4" @submit.prevent="submitEmail">
      <FormInput v-model="email" label="Email" type="email" icon="fa-envelope" placeholder="nama@email.com" />
      <p v-if="error" class="border-2 border-black bg-black px-3 py-2 text-sm font-bold text-white"><span class="text-[#FF3000]">■</span> {{ error }}</p>
      <p v-if="msg" class="border-2 border-black bg-[#F2F2F2] px-3 py-2 text-sm font-bold"><span class="text-[#FF3000]">■</span> {{ msg }}</p>
      <BaseButton type="submit" class="w-full" :disabled="busy">{{ busy ? 'Mengirim...' : 'Kirim kode OTP & tautan reset' }}</BaseButton>
    </form>

    <form v-else-if="step === 'verify'" class="space-y-4" @submit.prevent="submitReset">
      <p class="border-2 border-black bg-[#F2F2F2] px-3 py-2 text-xs font-bold">
        Email: <span class="underline">{{ email }}</span>
      </p>
      <FormInput v-model="otp" label="Kode OTP (6 digit)" icon="fa-key" placeholder="123456" inputmode="numeric" autocomplete="one-time-code" maxlength="6" />
      <FormInput v-model="password" label="Kata sandi baru" type="password" icon="fa-lock" placeholder="••••••••" />
      <FormInput v-model="confirm" label="Konfirmasi kata sandi" type="password" icon="fa-lock" placeholder="••••••••" />
      <p v-if="error" class="border-2 border-black bg-black px-3 py-2 text-sm font-bold text-white"><span class="text-[#FF3000]">■</span> {{ error }}</p>
      <p v-if="msg" class="border-2 border-black bg-[#F2F2F2] px-3 py-2 text-sm font-bold"><span class="text-[#FF3000]">■</span> {{ msg }}</p>
      <BaseButton type="submit" class="w-full" :disabled="busy">{{ busy ? 'Menyimpan...' : 'Verifikasi & simpan sandi baru' }}</BaseButton>
      <div class="flex items-center justify-between text-xs font-bold uppercase">
        <button
          type="button"
          :disabled="busy || cooldown > 0"
          @click="submitEmail"
          class="underline decoration-[#FF3000] decoration-2 underline-offset-4 hover:text-[#FF3000] disabled:opacity-50"
        >
          {{ cooldown > 0 ? `Kirim ulang (${cooldown}d)` : 'Kirim ulang OTP' }}
        </button>
        <button
          type="button"
          @click="step = 'request'; error = ''; msg = ''"
          class="underline underline-offset-4 hover:text-[#FF3000]"
        >
          Ganti email
        </button>
      </div>
    </form>

    <div v-else class="space-y-4">
      <p class="border-2 border-black bg-[#F2F2F2] px-3 py-2 text-sm font-bold"><span class="text-[#FF3000]">■</span> {{ msg }}</p>
      <router-link to="/masuk" class="block w-full border-2 border-black bg-black px-4 py-2.5 text-center text-sm font-bold uppercase tracking-wide text-white hover:bg-[#FF3000]">
        Masuk Sekarang
      </router-link>
    </div>

    <p class="mt-6 border-t-2 border-black pt-6 text-center text-sm"><router-link to="/masuk" class="font-bold uppercase tracking-wide underline decoration-[#FF3000] decoration-2 underline-offset-4">Kembali masuk</router-link></p>
  </AuthCard>
</template>
