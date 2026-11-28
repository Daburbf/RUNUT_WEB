<script setup>
import { reactive, ref, onUnmounted } from 'vue'
import { useRouter } from 'vue-router'
import AuthCard from '../components/AuthCard.vue'
import FormInput from '../components/FormInput.vue'
import BaseButton from '../components/BaseButton.vue'
import GoogleSignInButton from '../components/GoogleSignInButton.vue'
import { auth } from '../store/auth'

const router = useRouter()
const f = reactive({ name: '', email: '', password: '', confirm: '' })
const err = reactive({})
const otp = ref('')
const step = ref('form') // 'form' | 'otp'
const ok = ref('')
const errorMsg = ref('')
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

async function submit() {
  Object.keys(err).forEach((k) => delete err[k])
  ok.value = ''
  errorMsg.value = ''
  if (f.name.trim().length < 2) err.name = 'Nama minimal 2 karakter.'
  if (!/^\S+@\S+\.\S+$/.test(f.email)) err.email = 'Format email tidak valid. Periksa kembali penulisannya.'
  if (f.password.length < 8) err.password = 'Kata sandi minimal 8 karakter.'
  if (f.password !== f.confirm) err.confirm = 'Konfirmasi kata sandi tidak sama.'
  if (Object.keys(err).length) return
  busy.value = true
  try {
    const res = await auth.register({ name: f.name.trim(), email: f.email.trim(), password: f.password })
    if (res?.requires_verification) {
      step.value = 'otp'
      ok.value = res.message || 'Kode OTP verifikasi telah dikirim ke email Anda.'
      startCooldown(60)
      return
    }
    ok.value = 'Akun berhasil dibuat dengan 10 token gratis. Mengarahkan ke halaman analisis...'
    await router.push('/analisis')
  } catch (e) {
    err.email = e.message
  } finally {
    busy.value = false
  }
}

async function submitOtp() {
  errorMsg.value = ''
  ok.value = ''
  if (!/^\d{6}$/.test(otp.value.trim())) {
    errorMsg.value = 'Masukkan 6 digit kode OTP yang dikirim ke email Anda.'
    return
  }
  busy.value = true
  try {
    await auth.verifyOtp({ email: f.email.trim(), otp: otp.value.trim() })
    ok.value = 'Email terverifikasi. Mengarahkan ke halaman analisis...'
    await router.push('/analisis')
  } catch (e) {
    errorMsg.value = e.message
  } finally {
    busy.value = false
  }
}

async function resendOtp() {
  errorMsg.value = ''
  ok.value = ''
  busy.value = true
  try {
    const r = await auth.resendOtp(f.email.trim())
    ok.value = r.message || 'Kode OTP baru telah dikirim.'
    startCooldown(60)
  } catch (e) {
    errorMsg.value = e.message
  } finally {
    busy.value = false
  }
}

async function onGoogleCredential(credential) {
  errorMsg.value = ''
  ok.value = ''
  busy.value = true
  try {
    await auth.loginWithGoogle(credential)
    await router.push('/analisis')
  } catch (e) {
    errorMsg.value = e.message
  } finally {
    busy.value = false
  }
}
</script>

<template>
  <AuthCard
    :title="step === 'otp' ? 'Verifikasi Email' : 'Buat akun'"
    :subtitle="step === 'otp' ? 'Masukkan 6 digit kode OTP dari email Anda untuk mengaktifkan akun.' : 'Daftar akun Runut dan mulai periksa tulisanmu.'"
  >
    <template v-if="step === 'form'">
      <div class="mb-4 border-2 border-black bg-[#F2F2F2] px-3.5 py-2.5 text-xs font-bold uppercase tracking-wide">
        <span class="text-[#FF3000]">■</span> Bonus akun baru: gratis 10 token untuk testing setelah daftar.
      </div>
      <div class="mb-4">
        <GoogleSignInButton label="Daftar dengan Google" :disabled="busy" @credential="onGoogleCredential" @error="errorMsg = $event" />
      </div>
      <div class="my-4 flex items-center gap-3">
        <div class="h-0.5 flex-1 bg-black"></div>
        <span class="text-xs font-bold uppercase tracking-widest">Atau</span>
        <div class="h-0.5 flex-1 bg-black"></div>
      </div>
      <form class="space-y-4" @submit.prevent="submit">
        <FormInput v-model="f.name" label="Nama" icon="fa-user" :error="err.name" />
        <FormInput v-model="f.email" label="Email" type="email" icon="fa-envelope" :error="err.email" />
        <FormInput v-model="f.password" label="Kata sandi" type="password" icon="fa-lock" :error="err.password" />
        <FormInput v-model="f.confirm" label="Konfirmasi kata sandi" type="password" icon="fa-lock" :error="err.confirm" />
        <p v-if="errorMsg" class="border-2 border-black bg-black px-3 py-2 text-sm font-bold uppercase tracking-wide text-white"><span class="text-[#FF3000]">■</span> {{ errorMsg }}</p>
        <p v-if="ok" class="border-2 border-black bg-[#F2F2F2] px-3 py-2 text-sm font-bold uppercase tracking-wide"><span class="text-[#FF3000]">■</span> {{ ok }}</p>
        <BaseButton type="submit" class="w-full" :disabled="busy">
          <i v-if="busy" class="fa-solid fa-circle-notch fa-spin mr-1.5"></i>Daftar
        </BaseButton>
      </form>
    </template>

    <template v-else>
      <form class="space-y-4" @submit.prevent="submitOtp">
        <p class="border-2 border-black bg-[#F2F2F2] px-3 py-2 text-xs font-bold">
          Email tujuan: <span class="underline">{{ f.email }}</span>
        </p>
        <FormInput v-model="otp" label="Kode OTP (6 digit)" icon="fa-key" placeholder="123456" inputmode="numeric" autocomplete="one-time-code" maxlength="6" />
        <p v-if="errorMsg" class="border-2 border-black bg-black px-3 py-2 text-sm font-bold uppercase tracking-wide text-white"><span class="text-[#FF3000]">■</span> {{ errorMsg }}</p>
        <p v-if="ok" class="border-2 border-black bg-[#F2F2F2] px-3 py-2 text-sm font-bold uppercase tracking-wide"><span class="text-[#FF3000]">■</span> {{ ok }}</p>
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
            @click="step = 'form'; errorMsg = ''; ok = ''"
            class="underline underline-offset-4 hover:text-[#FF3000]"
          >
            Ubah data
          </button>
        </div>
      </form>
    </template>

    <p class="mt-6 border-t-2 border-black pt-6 text-center text-sm">Sudah punya akun? <router-link to="/masuk" class="font-bold uppercase tracking-wide underline decoration-[#FF3000] decoration-2 underline-offset-4 hover:text-[#FF3000]">Masuk</router-link></p>
  </AuthCard>
</template>
