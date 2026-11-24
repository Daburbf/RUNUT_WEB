---
title: RUNUT
emoji: 📝
colorFrom: blue
colorTo: indigo
sdk: docker
app_port: 8080
pinned: false
---

<a id="readme-top"></a>

<br />
<div align="center">
  <img src="public/images/logo.svg" alt="Runut" width="72" height="72" />

  <h1 align="center">Runut</h1>

  <p align="center">
    Website untuk menganalisis dan memperbaiki pola tulisan berbahasa Indonesia berbasis sistem token:
    tempel teks, periksa jumlah kata &amp; biaya token, tinjau seluruh temuan beserta saran perbaikan, lalu unduh hasilnya.
    <br />
    <br />
    <a href="docs/KEPUTUSAN_TEKNIS.md">Keputusan teknis</a>
    ·
    <a href="docs/PERUBAHAN_SRS_SDD.md">Perubahan SRS &amp; SDD</a>
  </p>
</div>

<details>
  <summary>Daftar isi</summary>
  <ol>
    <li><a href="#tentang-proyek">Tentang proyek</a></li>
    <li><a href="#sistem-token--tarif-analisis">Sistem token &amp; tarif analisis</a></li>
    <li><a href="#paket-pembelian-token">Paket pembelian token</a></li>
    <li><a href="#dibangun-dengan">Dibangun dengan</a></li>
    <li><a href="#memulai">Memulai</a></li>
    <li><a href="#struktur-database">Struktur database</a></li>
    <li><a href="#endpoint-api">Endpoint API</a></li>
    <li><a href="#cara-kerja-pembayaran-midtrans">Cara kerja pembayaran Midtrans</a></li>
    <li><a href="#pengujian">Pengujian</a></li>
    <li><a href="#keamanan--privasi">Keamanan &amp; privasi</a></li>
  </ol>
</details>

## Tentang proyek

Runut menandai **kebiasaan menulis** yang membuat tulisan terasa kaku atau generik —
bukan sekadar salah ketik. Enam kategori diperiksa:
1. **Pengulangan Kata (`repetition`)**
2. **Pola Kalimat (`sentence_pattern`)**
3. **Struktur Seragam (`uniform_structure`)**
4. **Transisi (`transition`)**
5. **Tingkat Formalitas (`formality`)**
6. **Konsistensi Gaya (`style_consistency`)**

Setiap analisis menggunakan **saldo token** sesuai panjang tulisan. Tidak ada langganan bulanan
dan tidak ada fitur atau saran perbaikan yang dikunci: seluruh temuan, penjelasan, saran perbaikan,
perbandingan teks, dan unduhan (PDF, DOCX, TXT) terbuka penuh pada setiap analisis.

Halaman hasil juga menampilkan **Similarity %** dan **Penggunaan AI %** yang dihitung server secara
deterministik dari pola di dalam teks itu sendiri.

---

## Sistem token & tarif analisis

Saat pengguna baru mendaftar, saldo awal adalah **0 token**.

Biaya analisis dihitung di backend (`server/src/services/tokens.js`) secara progresif berdasarkan
jumlah kata sebenarnya (termasuk hasil ekstraksi teks untuk unggahan DOCX dan PDF) menggunakan rumus:

```js
cost = Math.ceil(wordCount / 1000)
```

| Jumlah Kata | Biaya Token |
|---|---|
| Kurang dari 20 kata | Tidak dapat dianalisis (0 token dipotong) |
| 20 – 1.000 kata | **1 token** |
| 1.001 – 2.000 kata | **2 token** |
| 2.001 – 3.000 kata | **3 token** |
| 3.001 – 4.000 kata | **4 token** |
| Setiap tambahan maks. 1.000 kata | **+1 token** (mis. 7.200 kata = 8 token) |

Ketentuan pemotongan & pengembalian (refund) token:
- Mengetik teks, mengunggah dokumen, atau memeriksa estimasi (`POST /api/analysis/estimate`) **tidak** mengurangi token.
- Token dipotong secara **atomik** ketika pengguna memulai analisis (`POST /api/analysis`) setelah validasi teks, batas karakter (maks. 200.000 karakter / 5 MB), dan persetujuan AI (`ai_consent: true`) terpenuhi.
- Jika saldo tidak mencukupi, analisis dihentikan (`HTTP 402 INSUFFICIENT_TOKENS`) tanpa memanggil AI, dan pengguna diarahkan ke halaman **Isi Token** dengan draf tulisan tetap tersimpan.
- Jika analisis gagal sepenuhnya karena gangguan provider AI atau sistem, seluruh token yang telah dipotong **dikembalikan otomatis (refund)** ke saldo pengguna dan dicatat di ledger `token_transactions`.

---

## Paket pembelian token

Tersedia tiga paket pembelian token di halaman **Pembelian Token (`/#/token`)**:

| Paket | Jumlah Token | Harga Total | Harga per Token |
|---|---|---|---|
| **Hemat** (`hemat`) | 5 Token | Rp5.000 | Rp1.000 / token |
| **Populer** (`populer`) | 10 Token | Rp9.000 | Rp900 / token |
| **Lebih Hemat** (`lebih_hemat`) | 20 Token | Rp16.000 | Rp800 / token |

---

## Dibangun dengan

| Lapisan | Teknologi |
|---|---|
| Frontend | Vue 3, Vite, Vue Router (hash history), Tailwind CSS, Font Awesome |
| Backend | Node.js 20+, Express 4, multer, helmet, express-rate-limit |
| Autentikasi | bcryptjs, JWT access token (di memori browser), refresh cookie HttpOnly + rotasi |
| Analisis AI | Google Gemini / 9Router / OpenAI (endpoint kompatibel OpenAI) melalui `server/src/services/aiProvider.js` |
| Penyimpanan | PostgreSQL (`pg`) untuk production & persistensi penuh; berkas lokal `.data/runut-storage.json` untuk pengembangan tanpa PostgreSQL |
| Dokumen | mammoth (DOCX masuk), pdf-parse (PDF masuk), docx (ekspor DOCX), pdf-lib (ekspor PDF) |
| Pembayaran | Midtrans Core API + Snap (kartu) lewat `server/src/services/payments.js` |

---

## Memulai

### Instalasi

```powershell
# 1. Backend
cd server
npm.cmd install
Copy-Item .env.example .env

# 2. Frontend (dari root repo)
cd ..
npm.cmd install
```

### Konfigurasi `server/.env`

```env
PORT=3000
NODE_ENV=development
FRONTEND_URL=http://localhost:5173

# Wajib di production (PostgreSQL)
DATABASE_URL=postgres://postgres:rahasia@localhost:5432/runut

JWT_ACCESS_SECRET=<acak minimal 32 karakter>
JWT_ACCESS_TTL=1h
REFRESH_TOKEN_DAYS=30

# Provider AI
AI_PROVIDER=gemini
AI_BASE_URL=https://generativelanguage.googleapis.com/v1beta/openai
AI_API_KEY=<kunci API Anda>
AI_MODEL=gemini-3.1-flash-lite
AI_TIMEOUT_MS=90000

# Midtrans Payment Gateway
MIDTRANS_SERVER_KEY=SB-Mid-server-...
MIDTRANS_CLIENT_KEY=SB-Mid-client-...
MIDTRANS_IS_PRODUCTION=false
MIDTRANS_QRIS_ACQUIRER=gopay
PAYMENT_EXPIRY_HOURS=24
```

### Menjalankan Server Secara Lokal

```powershell
# Terminal 1 - Backend API (http://localhost:3000)
cd server
node src/index.js

# Terminal 2 - Frontend Vite (http://localhost:5173)
npm.cmd run dev
```

---

## Struktur database

Skema dibuat dan dimigrasikan secara otomatis (`create table if not exists` dan `alter table ... add column if not exists`) saat server terhubung ke PostgreSQL (`server/src/repositories/postgres.js`):

1. **`users`**: `id`, `name`, `email`, `password_hash`, `token_balance` (default `0`), `reset_token_hash`, `reset_token_expires_at`, `created_at`, `updated_at` (kolom lama `is_premium`, `premium_until` dipertahankan untuk kompatibilitas).
2. **`token_transactions`** (Ledger Token): `id`, `user_id`, `type` (`purchase` | `usage` | `refund`), `amount` (`+N` atau `-N`), `balance_after`, `description`, `reference_type`, `reference_id`, `idempotency_key` (unique per user), `meta` (JSONB), `created_at`.
3. **`payments`**: `id`, `user_id`, `order_id` (unique), `package_id`, `package_label`, `token_amount`, `method`, `method_label`, `channel`, `amount`, `status`, `provider`, `provider_ref`, `instructions` (JSONB), `expires_at`, `paid_at`, `created_at`, `updated_at`.
4. **`documents`**: `id`, `user_id`, `title`, `original_text`, `revised_text`, `word_count`, `token_cost`, `file_name`, `status`, `expires_at`, `last_analyzed_at`, `created_at`, `updated_at`.
5. **`analysis_results`**: `id`, `document_id`, `stats` (JSONB), `locked` (`false`), `token_cost`, `idempotency_key`, `ai_provider`, `ai_model`, `ai_latency_ms`, `ai_status`, `created_at`.
6. **`issues`**: `id`, `analysis_id`, `category`, `start_pos`, `end_pos`, `snippet`, `explanation`, `suggestion`, `needs_manual_review`, `review_reasons`, `evidence`, `decision`, `created_at`, `updated_at`.
7. **`refresh_tokens`**: `id`, `user_id`, `token_hash`, `expires_at`, `user_agent`, `revoked_at`, `created_at`.

---

## Endpoint API

| Metode & Path | Auth | Deskripsi |
|---|---|---|
| `GET /api/health` | Publik | Status penyimpanan, konfigurasi AI, paket token, dan batas sistem |
| `POST /api/auth/register` | Publik | Registrasi pengguna baru (saldo awal 0 token) |
| `POST /api/auth/login` | Publik | Masuk dan menerbitkan access token + HttpOnly refresh cookie |
| `POST /api/auth/refresh` | Cookie | Rotasi refresh token dan pemulihan sesi |
| `POST /api/auth/logout` | Publik | Mencabut sesi refresh token |
| `GET /api/auth/me` | Bearer | Profil pengguna beserta `token_balance`, `total_purchased`, `total_used` |
| `GET /api/tokens` | Bearer | Ringkasan saldo token, total dibeli/dipakai, paket, dan tarif |
| `GET /api/tokens/transactions` | Bearer | Riwayat mutasi ledger token (`purchase`, `usage`, `refund`) |
| `GET /api/tokens/packages` | Publik | Daftar paket token dan ketentuan perhitungan biaya |
| `POST /api/analysis/estimate` | Bearer | Ekstraksi teks (TXT/DOCX/PDF), hitung kata, dan estimasi biaya token tanpa memotong saldo |
| `POST /api/analysis` | Bearer | Memvalidasi teks, memotong token secara atomik, menjalankan AI, dan mengembalikan token bila gagal |
| `GET /api/documents` | Bearer | Daftar riwayat dokumen pengguna (mendukung query `?q=` dan `?status=`) |
| `GET /api/documents/:id` | Bearer | Detail dokumen, hasil analisis, dan seluruh daftar temuan |
| `PATCH /api/documents/:id/issues` | Bearer | Menerapkan/menolak saran perbaikan (`decisions` atau `accept_all: true`) |
| `POST /api/documents/:id/restore` | Bearer | Memulihkan teks asli dan mereset status keputusan saran |
| `GET /api/documents/:id/download` | Bearer | Mengunduh hasil revisi dalam format `pdf`, `docx`, atau `txt` |
| `GET /api/payments` | Bearer | Katalog paket token, metode pembayaran Midtrans, dan riwayat pesanan |
| `POST /api/payments` | Bearer | Membuat pesanan pembelian token (`{ package_id, method }`) |
| `GET /api/payments/:orderId` | Bearer | Memeriksa status pembayaran terbaru ke Midtrans |
| `GET /api/payments/:orderId/qr` | Bearer | Proxy gambar QRIS asli dari Midtrans |
| `GET /api/payments/:orderId/invoice` | Bearer | Mengunduh bukti pembayaran / invoice PDF (memuat jumlah token & nominal) |
| `POST /api/payments/notify` | Webhook | Webhook notifikasi Midtrans (verifikasi SHA-512 & idempoten) |

---

## Cara kerja pembayaran Midtrans

1. Pengguna memilih paket (`hemat`, `populer`, atau `lebih_hemat`) dan metode pembayaran (QRIS, BCA/BNI/BRI/Permata VA, GoPay, ShopeePay, Kartu Kredit/Debit, Alfamart, Indomaret).
2. Frontend mengirim `POST /api/payments` dengan `{ package_id, method }`. Nominal Rupiah dan jumlah token ditentukan **sepenuhnya oleh backend** dari konstanta `TOKEN_PACKAGES`.
3. Backend memanggil Midtrans Core API (`/v2/charge`) atau Snap (`/snap/v1/transactions`) dan menyimpan pesanan berstatus `pending`.
4. Ketika pembayaran lunas (`settlement` / `capture`) melalui webhook `POST /api/payments/notify` (dengan verifikasi signature `SHA512(order_id + status_code + gross_amount + serverKey)` dan kecocokan nominal) atau pemeriksaan status `GET /api/payments/:orderId`, fungsi `markPaidIfPending` memastikan hanya transisi pertama yang menandai pesanan `paid` dan menambahkan token ke saldo pengguna beserta catatan di `token_transactions`.

---

## Pengujian

```powershell
# Jalankan seluruh pengujian backend & unit (68+ tes)
cd server
npm.cmd test

# Jalankan build produksi frontend
cd ..
npm.cmd run build
```

Untuk menguji adapter PostgreSQL secara langsung:
```powershell
$env:RUNUT_TEST_DATABASE_URL='postgres://postgres:sandi@localhost:5432/runut'; npm.cmd test
```

---

## Keamanan & privasi

- Semua endpoint sensitif wajib menggunakan token autentikasi (`requireAuth`).
- Isolasi data ketat: pengguna tidak dapat melihat atau memodifikasi dokumen, saldo, transaksi token, maupun pembayaran milik akun lain (`403 Forbidden`).
- Saldo token tidak pernah bisa diubah dari request klien (`users.update` memfilter kolom lewat daftar putih dan mengabaikan `token_balance`).
- Pemotongan saldo menggunakan operasi atomik dan kunci idempotensi sehingga permintaan ganda atau bersamaan tidak pernah membuat saldo negatif atau memotong dua kali.
- Di lingkungan `production`, server wajib menggunakan PostgreSQL (`DATABASE_URL`) dan menolak jatuh diam-diam ke penyimpanan memori.
