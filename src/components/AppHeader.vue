<script setup>
import { ref, computed, watch } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import { auth } from '../store/auth'
import { job, clearJob } from '../store/analysis'

const open = ref(false)
const route = useRoute()
const router = useRouter()

watch(() => route.fullPath, () => { open.value = false })

const jobLink = () => (job.status === 'done' && job.documentId ? `/hasil/${job.documentId}` : '/analisis')
const logo = import.meta.env.BASE_URL + 'images/logo.svg'
const tokenBalance = computed(() => Math.max(0, Number(auth.user?.token_balance) || 0))

function logout() {
  open.value = false
  clearJob()
  auth.logout().finally(() => router.push('/'))
}
</script>

<template>
  <header class="sticky top-0 z-40 bg-white/95 backdrop-blur-md">
    <div class="h-1.5 bg-black" aria-hidden="true"></div>
    <nav class="mx-auto flex h-16 max-w-6xl items-center justify-between border-b-2 border-black px-4 sm:px-6" aria-label="Navigasi utama">
      <router-link to="/" class="group flex items-center gap-2.5">
        <img :src="logo" alt="" class="h-8 w-8 transition-transform duration-300 group-hover:scale-105" />
        <span class="text-lg font-black uppercase tracking-tighter">Runut</span>
      </router-link>

      <!-- Menu Desktop: Berbeda antara Guest vs Pengguna Login -->
      <ul v-if="auth.user" class="hidden items-center gap-5 md:flex lg:gap-6">
        <li>
          <router-link to="/" class="swiss-nav-link text-xs font-bold uppercase tracking-widest" exact-active-class="!text-[#FF3000]">
            <span data-label="Beranda">Beranda</span>
          </router-link>
        </li>
        <li>
          <router-link to="/analisis" class="swiss-nav-link text-xs font-bold uppercase tracking-widest" exact-active-class="!text-[#FF3000]">
            <span data-label="Analisis">Analisis</span>
          </router-link>
        </li>
        <li>
          <router-link to="/riwayat" class="swiss-nav-link text-xs font-bold uppercase tracking-widest" exact-active-class="!text-[#FF3000]">
            <span data-label="Riwayat">Riwayat</span>
          </router-link>
        </li>
        <li>
          <router-link to="/token" class="swiss-nav-link text-xs font-bold uppercase tracking-widest" exact-active-class="!text-[#FF3000]">
            <span data-label="Isi Token">Isi Token</span>
          </router-link>
        </li>
        <li>
          <router-link to="/akun" class="swiss-nav-link text-xs font-bold uppercase tracking-widest" exact-active-class="!text-[#FF3000]">
            <span data-label="Akun">Akun</span>
          </router-link>
        </li>
        <li>
          <router-link to="/tentang" class="swiss-nav-link text-xs font-bold uppercase tracking-widest" exact-active-class="!text-[#FF3000]">
            <span data-label="Tentang">Tentang</span>
          </router-link>
        </li>
      </ul>

      <ul v-else class="hidden items-center gap-7 md:flex">
        <li>
          <router-link to="/" class="swiss-nav-link text-xs font-bold uppercase tracking-widest" exact-active-class="!text-[#FF3000]">
            <span data-label="Beranda">Beranda</span>
          </router-link>
        </li>
        <li>
          <router-link to="/tentang" class="swiss-nav-link text-xs font-bold uppercase tracking-widest" exact-active-class="!text-[#FF3000]">
            <span data-label="Tentang">Tentang</span>
          </router-link>
        </li>
      </ul>

      <div class="hidden items-center gap-3 md:flex">
        <template v-if="auth.user">
          <router-link
            to="/token"
            class="swiss-snap group flex items-center gap-2 border-2 border-black bg-[#F2F2F2] px-3 py-1.5 font-mono text-xs font-bold uppercase tracking-wider text-black hover:border-[#FF3000] hover:bg-[#FF3000] hover:text-white"
            title="Klik untuk isi token"
          >
            <i class="fa-solid fa-coins text-[#FF3000] transition-colors duration-200 group-hover:text-white"></i>
            <span class="tabular-nums">{{ tokenBalance }} Token</span>
          </router-link>
          <router-link to="/akun" class="swiss-snap max-w-[130px] truncate text-xs font-bold uppercase tracking-wide text-black/80 hover:text-[#FF3000]">
            {{ auth.user.name }}
          </router-link>
          <button
            class="swiss-snap border-2 border-[#FF3000] bg-[#FF3000] px-3 py-1.5 text-xs font-bold uppercase tracking-widest text-white hover:border-[#CC2600] hover:bg-[#CC2600]"
            @click="logout"
          >
            Keluar
          </button>
        </template>
        <template v-else>
          <router-link to="/masuk" class="swiss-nav-link text-xs font-bold uppercase tracking-widest text-black">
            <span data-label="Masuk">Masuk</span>
          </router-link>
          <router-link to="/daftar" class="swiss-snap border-2 border-black bg-black px-3.5 py-1.5 text-xs font-bold uppercase tracking-widest text-white hover:border-[#FF3000] hover:bg-[#FF3000]">
            Daftar
          </router-link>
        </template>
      </div>

      <!-- Mobile: Saldo + Tombol Hamburger -->
      <div class="flex items-center gap-2 md:hidden">
        <router-link
          v-if="auth.user"
          to="/token"
          class="flex h-10 items-center gap-1.5 border-2 border-black bg-[#F2F2F2] px-2.5 font-mono text-xs font-bold uppercase tracking-wider"
        >
          <i class="fa-solid fa-coins text-[#FF3000]"></i>
          <span class="tabular-nums">{{ tokenBalance }} Token</span>
        </router-link>
        <button
          class="swiss-snap flex h-10 w-10 items-center justify-center border-2 border-black"
          :aria-expanded="open"
          aria-label="Buka menu"
          @click="open = !open"
        >
          <i :class="['fa-solid text-base transition-transform duration-200', open ? 'fa-xmark rotate-90' : 'fa-bars']"></i>
        </button>
      </div>
    </nav>

    <!-- Penanda Job Analisis Global (hanya untuk pengguna yang sudah login) -->
    <transition name="drawer-slide">
      <div v-if="auth.user && job.status !== 'idle' && !(job.status === 'done' && route.path === jobLink())" class="border-b-2 border-black bg-[#FF3000] text-white">
        <div class="mx-auto flex max-w-6xl items-center justify-between gap-3 px-4 py-2 sm:px-6">
          <router-link :to="jobLink()" class="flex min-w-0 items-center gap-2 font-mono text-xs font-bold uppercase tracking-widest">
            <i :class="['fa-solid', job.status === 'running' ? 'fa-circle-notch fa-spin' : job.status === 'done' ? 'fa-circle-check' : 'fa-triangle-exclamation']"></i>
            <span class="truncate">
              <template v-if="job.status === 'running'">Menganalisis tulisan ({{ job.elapsed }} dtk)...</template>
              <template v-else-if="job.status === 'done'">Hasil analisis siap dibuka</template>
              <template v-else>Analisis gagal — klik untuk kembali ke editor</template>
            </span>
          </router-link>
          <div class="flex shrink-0 items-center gap-2">
            <router-link :to="jobLink()" class="swiss-snap border-2 border-white px-2.5 py-1 font-mono text-[10px] font-bold uppercase tracking-widest hover:bg-white hover:text-[#FF3000]">
              {{ job.status === 'running' ? 'Lihat' : job.status === 'done' ? 'Buka Hasil' : 'Editor' }}
            </router-link>
            <button v-if="job.status !== 'running'" class="swiss-snap h-6 w-6 border-2 border-white font-mono text-[10px] font-bold hover:bg-white hover:text-[#FF3000]" aria-label="Tutup penanda" @click="clearJob">
              <i class="fa-solid fa-xmark"></i>
            </button>
          </div>
        </div>
      </div>
    </transition>

    <!-- Menu Mobile -->
    <transition name="drawer-slide">
      <div v-if="open" class="border-b-2 border-black bg-white px-4 py-4 md:hidden">
        <template v-if="auth.user">
          <div class="mb-3 flex items-center justify-between border-2 border-black bg-[#F2F2F2] px-3.5 py-2.5">
            <div class="flex items-center gap-2">
              <i class="fa-solid fa-coins text-[#FF3000]"></i>
              <p class="font-mono text-sm font-black uppercase tracking-tight tabular-nums">{{ tokenBalance }} Token</p>
            </div>
            <router-link to="/token" class="border-2 border-black bg-[#FF3000] px-3 py-1 font-mono text-xs font-bold uppercase tracking-widest text-white">
              + Isi Token
            </router-link>
          </div>
          <router-link to="/" class="flex items-center justify-between border-b border-black/10 px-2 py-3 text-sm font-bold uppercase tracking-wide hover:bg-[#F2F2F2] hover:text-[#FF3000]">
            <span>Beranda</span><span class="font-mono text-xs text-[#FF3000]">01</span>
          </router-link>
          <router-link to="/analisis" class="flex items-center justify-between border-b border-black/10 px-2 py-3 text-sm font-bold uppercase tracking-wide hover:bg-[#F2F2F2] hover:text-[#FF3000]">
            <span>Analisis</span><span class="font-mono text-xs text-[#FF3000]">02</span>
          </router-link>
          <router-link to="/riwayat" class="flex items-center justify-between border-b border-black/10 px-2 py-3 text-sm font-bold uppercase tracking-wide hover:bg-[#F2F2F2] hover:text-[#FF3000]">
            <span>Riwayat</span><span class="font-mono text-xs text-[#FF3000]">03</span>
          </router-link>
          <router-link to="/token" class="flex items-center justify-between border-b border-black/10 px-2 py-3 text-sm font-bold uppercase tracking-wide hover:bg-[#F2F2F2] hover:text-[#FF3000]">
            <span>Isi Token</span><span class="font-mono text-xs text-[#FF3000]">04</span>
          </router-link>
          <router-link to="/akun" class="flex items-center justify-between border-b border-black/10 px-2 py-3 text-sm font-bold uppercase tracking-wide hover:bg-[#F2F2F2] hover:text-[#FF3000]">
            <span>Akun ({{ auth.user.name }})</span><span class="font-mono text-xs text-[#FF3000]">05</span>
          </router-link>
          <router-link to="/tentang" class="flex items-center justify-between border-b border-black/10 px-2 py-3 text-sm font-bold uppercase tracking-wide hover:bg-[#F2F2F2] hover:text-[#FF3000]">
            <span>Tentang</span><span class="font-mono text-xs text-[#FF3000]">06</span>
          </router-link>
          <div class="mt-3 flex flex-col gap-2 pt-2">
            <button class="min-h-[42px] border-2 border-[#FF3000] bg-[#FF3000] px-3 py-2 text-xs font-bold uppercase tracking-widest text-white hover:border-[#CC2600] hover:bg-[#CC2600]" @click="logout">
              Keluar
            </button>
          </div>
        </template>
        <template v-else>
          <router-link to="/" class="flex items-center justify-between border-b border-black/10 px-2 py-3 text-sm font-bold uppercase tracking-wide hover:bg-[#F2F2F2] hover:text-[#FF3000]">
            <span>Beranda</span><span class="font-mono text-xs text-[#FF3000]">01</span>
          </router-link>
          <router-link to="/tentang" class="flex items-center justify-between border-b border-black/10 px-2 py-3 text-sm font-bold uppercase tracking-wide hover:bg-[#F2F2F2] hover:text-[#FF3000]">
            <span>Tentang</span><span class="font-mono text-xs text-[#FF3000]">02</span>
          </router-link>
          <div class="mt-3 flex flex-col gap-2 border-t border-black/15 pt-4">
            <router-link to="/masuk" class="min-h-[42px] flex items-center justify-center border-2 border-black px-3 py-2 text-center text-xs font-bold uppercase tracking-widest">
              Masuk
            </router-link>
            <router-link to="/daftar" class="min-h-[42px] flex items-center justify-center border-2 border-black bg-black px-3 py-2 text-center text-xs font-bold uppercase tracking-widest text-white">
              Daftar
            </router-link>
          </div>
        </template>
      </div>
    </transition>
  </header>
</template>
