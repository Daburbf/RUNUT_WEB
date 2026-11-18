<script setup>
import { auth } from '../store/auth'
const logo = import.meta.env.BASE_URL + 'images/logo.svg'
</script>

<template>
  <footer class="relative z-10 mt-24 bg-black text-white">
    <div class="mx-auto grid max-w-6xl gap-10 px-4 py-12 sm:px-6 md:grid-cols-3 md:py-16">
      <div>
        <div class="flex items-center gap-2.5">
          <img :src="logo" alt="" class="h-8 w-8" />
          <span class="text-xl font-black uppercase tracking-tighter">Runut</span>
        </div>
        <p class="mt-4 max-w-xs text-sm leading-relaxed text-white/60">
          Analisis pola tulisan berbahasa Indonesia: tempel teks, periksa bagian yang janggal, lalu perbaiki dan unduh hasilnya.
        </p>
        <p class="mt-6 font-mono text-[11px] uppercase tracking-widest text-white/40">© 2026 Runut</p>
      </div>
      <nav aria-label="Tautan footer">
        <p class="font-mono text-xs uppercase tracking-widest text-[#FF3000]">Navigasi</p>
        <ul v-if="auth.user" class="mt-4 space-y-3 text-sm font-bold uppercase tracking-wide">
          <li><router-link to="/" class="hover:text-[#FF3000]">Beranda</router-link></li>
          <li><router-link to="/analisis" class="hover:text-[#FF3000]">Analisis</router-link></li>
          <li><router-link to="/riwayat" class="hover:text-[#FF3000]">Riwayat</router-link></li>
          <li><router-link to="/token" class="hover:text-[#FF3000]">Isi Token</router-link></li>
          <li><router-link to="/akun" class="hover:text-[#FF3000]">Akun</router-link></li>
          <li><router-link to="/tentang" class="hover:text-[#FF3000]">Tentang</router-link></li>
        </ul>
        <ul v-else class="mt-4 space-y-3 text-sm font-bold uppercase tracking-wide">
          <li><router-link to="/" class="hover:text-[#FF3000]">Beranda</router-link></li>
          <li><router-link to="/tentang" class="hover:text-[#FF3000]">Tentang</router-link></li>
          <li><router-link to="/masuk" class="hover:text-[#FF3000]">Masuk</router-link></li>
          <li><router-link to="/daftar" class="hover:text-[#FF3000]">Daftar</router-link></li>
        </ul>
      </nav>
      <div>
        <p class="font-mono text-xs uppercase tracking-widest text-[#FF3000]">Sistem Token</p>
        <p class="mt-4 text-sm leading-relaxed text-white/60">
          Tanpa langganan bulanan. Pilihan paket: 5 token (Rp5.000), 10 token (Rp9.000), dan 20 token (Rp16.000). Seluruh saran perbaikan dan unduhan PDF/DOCX/TXT langsung terbuka. Dokumen tersimpan 30 hari.
        </p>
      </div>
    </div>
  </footer>
</template>
