<script setup>
import BaseButton from '../components/BaseButton.vue'
import SectionLabel from '../components/SectionLabel.vue'
import BaseCard from '../components/BaseCard.vue'
import FeatureCard from '../components/FeatureCard.vue'
import { CATEGORIES, TOKEN_PACKAGES } from '../utils/categories'
import { auth } from '../store/auth'

const desc = {
  repetition: 'Kata yang sama muncul berkali-kali? Ditandai beserta alternatifnya.',
  sentence_pattern: 'Kalimat yang terlalu panjang atau berpola sama dipecah agar enak dibaca.',
  uniform_structure: 'Rangkaian kalimat berstruktur seragam ditandai agar ritmenya bervariasi.',
  transition: 'Kata transisi yang hilang atau dipakai berulang ditinjau ulang.',
  formality: 'Kata tidak baku seperti "gak" atau "banget" disarankan bentuk bakunya.',
  style_consistency: 'Campuran kata ganti atau gaya (mis. "saya" vs "aku") diingatkan.',
}
const keys = Object.keys(CATEGORIES)

const steps = [
  { n: '01', t: 'Tempel atau unggah tulisan', d: 'Teks langsung, atau file TXT / DOCX / PDF maksimal 5 MB. Sistem menghitung jumlah kata dan biaya token secara otomatis.' },
  { n: '02', t: 'Sistem menganalisis pola', d: 'Statistik dihitung otomatis, lalu enam kategori masalah diperiksa satu per satu tanpa ada saran yang dikunci.' },
  { n: '03', t: 'Perbaiki & unduh hasil', d: 'Terima atau tolak saran per bagian, terapkan semua saran aman sekaligus, lalu unduh hasilnya dalam PDF, DOCX, atau TXT.' },
]

const fmtIdr = (n) => 'Rp' + Number(n || 0).toLocaleString('id-ID')

const faqs = [
  { q: 'Bagaimana cara menggunakan token untuk analisis?', a: 'Setiap kali kamu menempelkan teks atau mengunggah dokumen di halaman Analisis, sistem akan menampilkan jumlah kata dan jumlah token yang dibutuhkan sebelum analisis dimulai. Saldo hanya dipotong saat kamu menekan tombol Mulai Analisis.' },
  { q: 'Apakah ada fitur atau saran yang dikunci?', a: 'Tidak ada. Setiap analisis membuka seluruh temuan, penjelasan lengkap, saran perbaikan, fitur terapkan sekaligus, perbandingan teks, serta unduhan PDF, DOCX, dan TXT.' },
  { q: 'Bagaimana jika analisis gagal karena gangguan sistem?', a: 'Jika analisis gagal sepenuhnya karena gangguan sistem atau provider AI, token yang telah dipotong akan dikembalikan (refund) secara otomatis ke saldo Anda dan tercatat di riwayat transaksi.' },
  { q: 'Apakah Runut mendeteksi tulisan AI atau plagiarisme?', a: 'Runut menampilkan dua angka deterministik yang dihitung server dari teks Anda: Similarity (pengulangan kata isi, frasa, dan pembuka kalimat di dalam dokumen) dan Penggunaan AI (keseragaman panjang kalimat, pengulangan frasa, jumlah kalimat pendek).' },
  { q: 'Berapa lama dokumen tersimpan?', a: '30 hari setelah analisis terakhir, atau sampai Anda menghapusnya dari riwayat. Setelah itu dihapus permanen.' },
]
</script>

<template>
  <div>
    <!-- 01 / APA ITU RUNUT -->
    <section class="mx-auto max-w-6xl px-4 py-12 sm:px-6 md:py-16">
      <SectionLabel>01 / Tentang website</SectionLabel>
      <h1 class="mt-4 max-w-3xl text-5xl font-black uppercase leading-[0.9] tracking-tighter md:text-7xl">
        Runut itu apa?
      </h1>
      <div class="mt-8 grid gap-8 md:grid-cols-[7fr_5fr]">
        <div class="space-y-5 text-[15px] leading-8 text-black/80">
          <p>
            <strong>Runut adalah website untuk menganalisis dan memperbaiki pola tulisan
            berbahasa Indonesia.</strong> Kamu menempelkan teks atau mengunggah dokumen,
            Runut menandai bagian yang bermasalah, menjelaskan sebabnya, dan memberi saran
            perbaikan yang bisa diterima satu per satu maupun sekaligus.
          </p>
          <p>
            Fokusnya bukan salah ketik (typo), melainkan <em>kebiasaan menulis</em>: kata yang
            diulang berkali-kali, kalimat yang terlalu panjang, paragraf yang berstruktur
            seragam, transisi yang dipakai berulang, kata tidak baku, dan gaya yang tidak
            konsisten. Cocok untuk tugas, esai, skripsi, laporan, dan artikel.
          </p>
          <BaseCard class="border-l-4 !border-l-[#FF3000] p-5">
            <p class="font-mono text-xs uppercase tracking-widest text-[#FF3000]">Prinsip</p>
            <p class="mt-2 text-sm leading-7">Spesifik terhadap tulisanmu, transparan dalam perhitungan biaya token, dan membuka seluruh hasil tanpa batasan fitur tersembunyi.</p>
          </BaseCard>
          <div class="flex flex-wrap gap-2 pt-2">
            <BaseButton :to="auth.user ? '/analisis' : '/daftar'">
              {{ auth.user ? 'Buka Analisis' : 'Daftar Sekarang' }}
            </BaseButton>
            <BaseButton v-if="auth.user" to="/token" variant="secondary">Isi Token</BaseButton>
            <BaseButton v-else to="/masuk" variant="secondary">Masuk</BaseButton>
          </div>
        </div>
        <BaseCard class="self-start p-6 sm:p-8">
          <p class="font-mono text-xs uppercase tracking-widest text-[#FF3000]">Sekilas angka</p>
          <div class="mt-4 grid grid-cols-2 gap-3">
            <div class="border-2 border-black p-4 text-center"><p class="text-4xl font-black">6</p><p class="mt-1 font-mono text-[11px] uppercase tracking-widest">Kategori analisis</p></div>
            <div class="border-2 border-black p-4 text-center"><p class="text-4xl font-black">3</p><p class="mt-1 font-mono text-[11px] uppercase tracking-widest">Paket token</p></div>
            <div class="border-2 border-black p-4 text-center"><p class="text-4xl font-black">200K</p><p class="mt-1 font-mono text-[11px] uppercase tracking-widest">Maks karakter</p></div>
            <div class="border-2 border-black p-4 text-center"><p class="text-4xl font-black">30</p><p class="mt-1 font-mono text-[11px] uppercase tracking-widest">Hari retensi</p></div>
          </div>
        </BaseCard>
      </div>
    </section>

    <!-- 02 / FITUR -->
    <section class="border-y-4 border-black bg-[#F2F2F2]">
      <div class="mx-auto max-w-6xl px-4 py-12 sm:px-6 md:py-16">
        <SectionLabel>02 / Fitur website</SectionLabel>
        <h2 class="mt-4 text-4xl font-black uppercase tracking-tighter md:text-5xl">Semua yang bisa dilakukan Runut</h2>
        <div class="mt-8 grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
          <FeatureCard v-for="k in keys" :key="k" :icon="CATEGORIES[k].icon" :title="CATEGORIES[k].label" :desc="desc[k]" :num="CATEGORIES[k].num" />
        </div>
        <div class="mt-4 grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
          <FeatureCard icon="fa-file-arrow-up" title="Upload Dokumen" desc="TXT, DOCX, atau PDF sampai 5 MB - teks diekstrak otomatis lalu dihitung jumlah katanya." num="07" />
          <FeatureCard icon="fa-code-compare" title="Bandingkan & Pulihkan" desc="Lihat teks asli berdampingan dengan revisi, atau kembalikan semuanya sekaligus." num="08" />
          <FeatureCard icon="fa-clock-rotate-left" title="Riwayat 30 Hari" desc="Semua dokumen tersimpan otomatis. Cari, buka lagi, unduh ulang, atau hapus." num="09" />
        </div>
      </div>
    </section>

    <!-- 03 / CARA KERJA -->
    <section class="mx-auto max-w-6xl px-4 py-12 sm:px-6 md:py-16">
      <SectionLabel>03 / Cara kerja</SectionLabel>
      <h2 class="mt-4 text-4xl font-black uppercase tracking-tighter md:text-5xl">Dari teks sampai revisi</h2>
      <div class="mt-8 grid gap-4 md:grid-cols-3">
        <BaseCard v-for="s in steps" :key="s.n" class="p-6 sm:p-8">
          <p class="font-mono text-4xl font-black text-[#FF3000]">{{ s.n }}</p>
          <h3 class="mt-3 text-lg font-black uppercase tracking-tight">{{ s.t }}</h3>
          <p class="mt-2 text-sm leading-7 text-black/70">{{ s.d }}</p>
        </BaseCard>
      </div>
    </section>

    <!-- 04 / PAKET TOKEN -->
    <section class="border-y-4 border-black bg-black text-white">
      <div class="mx-auto max-w-6xl px-4 py-12 sm:px-6 md:py-16">
        <SectionLabel>04 / Paket Pembelian Token</SectionLabel>
        <h2 class="mt-4 text-4xl font-black uppercase tracking-tighter md:text-5xl">Tanpa langganan, beli sesuai kebutuhan</h2>
        <div class="mt-8 grid gap-4 md:grid-cols-3">
          <div v-for="p in TOKEN_PACKAGES" :key="p.id" class="border-2 border-white p-6 sm:p-8">
            <p class="font-mono text-xs uppercase tracking-widest text-[#FF3000]">Paket {{ p.name }}</p>
            <p class="mt-2 text-4xl font-black tracking-tight">{{ p.tokens }} Token</p>
            <p class="mt-2 text-2xl font-bold">{{ fmtIdr(p.price_idr) }}</p>
            <p class="mt-4 text-xs leading-relaxed text-white/75">{{ p.description }}</p>
          </div>
        </div>
        <div class="mt-6 flex flex-wrap gap-3">
          <BaseButton :to="auth.user ? '/token' : '/daftar'" variant="accent">
            {{ auth.user ? 'Beli Token Sekarang' : 'Daftar & Mulai' }}
          </BaseButton>
        </div>
      </div>
    </section>

    <!-- 05 / FAQ -->
    <section class="mx-auto max-w-6xl px-4 py-12 sm:px-6 md:py-16">
      <SectionLabel>05 / Tanya jawab</SectionLabel>
      <h2 class="mt-4 text-4xl font-black uppercase tracking-tighter md:text-5xl">Yang sering ditanyakan</h2>
      <div class="mt-8 space-y-4">
        <BaseCard v-for="f in faqs" :key="f.q" class="p-6">
          <h3 class="font-black uppercase tracking-tight">{{ f.q }}</h3>
          <p class="mt-2 text-sm leading-7 text-black/70">{{ f.a }}</p>
        </BaseCard>
      </div>
      <div class="mt-8 flex flex-wrap gap-3">
        <BaseButton :to="auth.user ? '/analisis' : '/daftar'">
          {{ auth.user ? 'Mulai Analisis' : 'Daftar Akun' }}
        </BaseButton>
        <BaseButton to="/" variant="secondary">Kembali ke Beranda</BaseButton>
      </div>
    </section>
  </div>
</template>
