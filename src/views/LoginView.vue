<script setup>
import { ref, onUnmounted } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import AuthCard from '../components/AuthCard.vue'
import FormInput from '../components/FormInput.vue'
import BaseButton from '../components/BaseButton.vue'
import GoogleSignInButton from '../components/GoogleSignInButton.vue'
import { auth } from '../store/auth'

const route = useRoute()
const router = useRouter()
const email = ref('')
const password = ref('')
const otp = ref('')
const needsVerification = ref(false)
const info = ref('')
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

async function redirectAfterLogin() {
  const redirect = String(route.query.redirect || '').trim()
  const dest = redirect && redirect.startsWith('/') ? redirect : '/analisis'
  await router.push(dest)
}

async function submit() {
  error.value = ''
  info.value = ''
  if (!email.value || !password.value) {
    error.value = 'Isi email dan kata sandi terlebih dahulu.'
    return
  }
  busy.value = true
  try {
    await auth.login(email.value.trim(), password.value)
    await redirectAfterLogin()
  } catch (e) {
    if (e.code === 'EMAIL_NOT_VERIFIED' || e.details?.code === 'EMAIL_NOT_VERIFIED') {
      needsVerification.value = true
      info.value = e.message
    } else {
      error.value = e.message
    }
  } finally {
    busy.value = false
  }
}

async function submitOtp() {
  error.value = ''
  info.value = ''
  if (!/^\d{6}$/.test(otp.value.trim())) {
    error.value = 'Masukkan 6 digit kode OTP dari email Anda.'
    return
  }
  busy.value = true
  try {
    await auth.verifyOtp({ email: email.value.trim(), otp: otp.value.trim() })
    await redirectAfterLogin()
  } catch (e) {
    error.value = e.message
  } finally {
    busy.value = false
  }
}

async function resendOtp() {
  error.value = ''
  info.value = ''
  busy.value = true
  try {
    const r = await auth.resendOtp(email.value.trim())
    info.value = r.message || 'Kode OTP baru telah dikirim ke email Anda.'
    startCooldown(60)
  } catch (e) {
    error.value = e.message
  } finally {
    busy.value = false
  }
}

async function onGoogleCredential(credential) {
  error.value = ''
  info.value = ''
  busy.value = true
  try {
    await auth.loginWithGoogle(credential)
    await redirectAfterLogin()
  } catch (e) {
    error.value = e.message
  } finally {
    busy.value = false
  }
}
</script>

<template>
  <AuthCard
    :title="needsVerification ? 'Verifikasi Email' : 'Masuk'"
    :subtitle="needsVerification ? 'Masukkan 6 digit kode OTP yang dikirim ke email Anda.' : 'Masuk untuk mulai menganalisis tulisan Anda.'"
  >
    <template v-if="!needsVerification">
      <div class="mb-4">
        <GoogleSignInButton label="Masuk dengan Google" :disabled="busy" @credential="onGoogleCredential" @error="error = $event" />
      </div>
      <div class="my-4 flex items-center gap-3">
        <div class="h-0.5 flex-1 bg-black"></div>
        <span class="text-xs font-bold uppercase tracking-widest">Atau</span>
        <div class="h-0.5 flex-1 bg-black"></div>
      </div>
      <form class="space-y-4" @submit.prevent="submit">
        <FormInput v-model="email" label="Email" type="email" icon="fa-envelope" placeholder="nama@email.com" />
        <FormInput v-model="password" label="Kata sandi" type="password" icon="fa-lock" placeholder="••••••••" />
        <p v-if="error" class="border-2 border-black bg-black px-3 py-2 text-sm font-bold uppercase tracking-wide text-white">
          <span class="text-[#FF3000]">■</span> {{ error }}
        </p>
        <BaseButton type="submit" class="w-full" :disabled="busy">
          <i v-if="busy" class="fa-solid fa-circle-notch fa-spin mr-1.5"></i>Masuk
        </BaseButton>
      </form>
    </template>

    <template v-else>
      <form class="space-y-4" @submit.prevent="submitOtp">
        <p class="border-2 border-black bg-[#F2F2F2] px-3 py-2 text-xs font-bold">
          Email: <span class="underline">{{ email }}</span>
        </p>
        <FormInput v-model="otp" label="Kode OTP (6 digit)" icon="fa-key" placeholder="123456" inputmode="numeric" autocomplete="one-time-code" maxlength="6" />
        <p v-if="info" class="border-2 border-black bg-[#F2F2F2] px-3 py-2 text-sm font-bold">
          <span class="text-[#FF3000]">■</span> {{ info }}
        </p>
        <p v-if="error" class="border-2 border-black bg-black px-3 py-2 text-sm font-bold uppercase tracking-wide text-white">
          <span class="text-[#FF3000]">■</span> {{ error }}
        </p>
        <BaseButton type="submit" class="w-full" :disabled="busy">
          <i v-if="busy" class="fa-solid fa-circle-notch fa-spin mr-1.5"></i>Verifikasi &amp; Masuk
        </BaseButton>
        <div class="flex items-center justify-between text-xs font-bold uppercase">
          <button
            type="button"
            :disabled="busy || cooldown > 0"
            @click="resendOtp"
            class="underline decoration-[#FF3000] decoration-2 underline-offset-4 hover:text-[#FF3000] disabled:opacity-50"
          >
            {{ cooldown > 0 ? `Kirim ulang (${cooldown}d)` : 'Kirim ulang OTP' }}
          </button>
          <button
            type="button"
            @click="needsVerification = false; error = ''; info = ''"
            class="underline underline-offset-4 hover:text-[#FF3000]"
          >
            Ganti email
          </button>
        </div>
      </form>
    </template>

    <div class="mt-6 space-y-2 border-t-2 border-black pt-6 text-center text-sm">
      <p><router-link to="/lupa-sandi" class="font-bold uppercase tracking-wide underline decoration-[#FF3000] decoration-2 underline-offset-4 hover:text-[#FF3000]">Lupa kata sandi?</router-link></p>
      <p>Belum punya akun? <router-link to="/daftar" class="font-bold uppercase tracking-wide underline decoration-[#FF3000] decoration-2 underline-offset-4 hover:text-[#FF3000]">Daftar</router-link></p>
    </div>
  </AuthCard>
</template>
