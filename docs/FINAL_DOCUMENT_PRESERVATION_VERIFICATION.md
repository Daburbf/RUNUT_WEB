# RUNUT — Final Document Preservation Verification & Docker Production Test Report

**Tanggal Verifikasi:** 2026-11-24  
**Lingkungan Eksekusi Lokal:** Windows (Node.js v24.20.0, PostgreSQL 18.6 terpasang lokal)  
**Status Kesiapan Produksi Docker:** **BELUM SEPENUHNYA TERVERIFIKASI DI CONTAINER NYATA** (Docker Desktop/Engine, WSL distro, dan LibreOffice belum terpasang di mesin host lokal ini; verifikasi container & `soffice --version` harus dijalankan pada host Docker / CI Linux sebelum klaim *full production readiness*).

---

## 1. Docker Environment Verification

| Pemeriksaan | Status | Bukti / Catatan Aktual |
|---|---|---|
| Docker CLI / Daemon (`docker --version`, `docker info`) | **BLOCKED (Host)** | `docker` tidak ditemukan di PATH maupun `C:\Program Files\Docker\Docker\resources\bin\docker.exe`; `podman` tidak ditemukan; WSL belum memiliki distro terpasang. |
| Konfigurasi `Dockerfile` | **READY** | Multi-stage `node:20.18-alpine`, memasang `libreoffice font-noto ttf-dejavu`, membuat direktori persisten `/app/server/.data/uploads` milik `node:node`, `USER node`, dan `HEALTHCHECK` ke `/api/health`. |
| Konfigurasi `docker-compose.yml` | **ADDED** | Ditambahkan layanan `postgres:16-alpine` (volume `runut_pgdata`) + `app` (volume persisten `runut_uploads:/app/server/.data/uploads`, `depends_on: service_healthy`, `healthcheck`). |
| Eksekusi aktual `docker build` & `soffice --version` di container | **PENDING** | Tidak dapat dijalankan di host ini karena Docker belum terpasang. **Tidak diklaim lulus.** |

### Perintah Verifikasi yang Wajib Dijalankan pada Host Docker / Linux CI
```bash
# 1. Build clean tanpa cache & jalankan layanan
docker compose build --no-cache
docker compose up -d

# 2. Verifikasi LibreOffice & font di dalam container app yang berjalan
docker compose exec app soffice --version
docker compose exec app fc-list : family | sort -u | head -n 30

# 3. Verifikasi health check & persistensi volume
docker compose ps
curl -f http://127.0.0.1:8080/api/health
docker compose restart app
curl -f http://127.0.0.1:8080/api/health
```

---

## 2. Complete Document Format Tests (8 Format Representatif)

Seluruh 8 kategori dokumen representatif diuji otomatis melalui `server/test/document-preservation-matrix.test.js` dan `server/test/template-preservation-complete.test.js`:

| # | Format Dokumen | Upload & Persistensi | Analisis & Revisi | Ekspor & Preservasi | Zero Watermark & Immutable | Status |
|---|---|---|---|---|---|---|
| 1 | **PDF dengan teks dapat diedit** | Lulus (`sha256` cocok) | Lulus (`applyPdfEdits`) | `X-Preservation-Classification: preserved` | Terverifikasi | **PASS** |
| 2 | **PDF dengan embedded fonts** | Lulus (`sha256` cocok) | Lulus | Dimensi & jumlah halaman sama | Terverifikasi | **PASS** |
| 3 | **PDF dengan gambar (PNG) & tabel** | Lulus (`sha256` cocok) | Lulus | Gambar & tabel utuh, visual similarity ≥ 95% | Terverifikasi | **PASS** |
| 4 | **Scanned PDF (image-only)** | Lulus deteksi | Ditolak aman (`400`) tanpa mengarang teks | Tidak menghasilkan teks palsu / tidak memotong token | Terverifikasi | **PASS** |
| 5 | **DOCX dengan complex formatting (multi-run bold/italic, Heading1, margin)** | Lulus (`sha256` cocok) | Lulus (`applyDocxEdits`) | `classification: preserved`, `original_formatting_preserved: true` | Terverifikasi | **PASS** |
| 6 | **DOCX dengan headers, footers & nomor halaman** | Lulus (`sha256` cocok) | Lulus | `headers_footers_preserved: true`, `page_configuration_preserved: true` | Terverifikasi | **PASS** |
| 7 | **DOCX dengan tabel & gambar tertanam (PNG)** | Lulus (`sha256` cocok) | Lulus | `tables_preserved: true`, `images_preserved: true`, hash PNG identik | Terverifikasi | **PASS** |
| 8 | **Legacy DOC (OLE2 `D0 CF 11 E0`)** | Validasi OLE2 magic bytes & penyimpanan `.doc` immutable | Jalur konversi teruji via hook & penolakan `DOC_CONVERTER_UNAVAILABLE` | Konversi nyata LibreOffice **menunggu eksekusi di container Docker** | Terverifikasi (logika) | **PARTIAL (LibreOffice lokal absen)** |

### Pengujian Larangan Rekonstruksi Teks Polos (*No Silent Fallback*)
- Permintaan `?format=docx` pada dokumen unggahan `.pdf` ditolak tegas dengan **`422 FORMAT_MISMATCH_USE_PDF`**.
- Permintaan `?format=docx` atau `?format=pdf` ketika berkas template asli sudah tidak ada di penyimpanan server ditolak tegas dengan **`409 ORIGINAL_TEMPLATE_MISSING`**.

---

## 3. Actual Visual & Structural Comparison Results

- **PDF Visual Comparison (`comparePdfVisually()` pada `server/src/services/pdfEditor.js`):**
  - Membandingkan jumlah halaman (`page_count_match: true`), dimensi halaman (`validateGeneratedPdf` memverifikasi `width > 0 && height > 0`), kemiripan piksel antar-halaman (`average_visual_similarity_percent >= 95%`), dan deteksi artefak *white patch* (`white_patch_artifacts_detected: false`).
  - Seluruh 3 varian PDF yang dapat diedit (teks biasa, embedded font, gambar+tabel) lulus tanpa artefak dan tanpa watermark `RUNUT`.
- **DOCX Structural Comparison (`verifyDocxPreservation()` pada `server/src/services/docxEditor.js`):**
  - Membandingkan identik bit-per-bit terhadap `word/styles.xml`, `word/numbering.xml`, `word/header*.xml`, `word/footer*.xml`, `word/media/*`, `word/_rels/document.xml.rels` (hyperlink), `word/footnotes.xml`, struktur tabel (`<w:tblPr>`), dan konfigurasi halaman (`<w:sectPr>`).
  - Seluruh varian DOCX lulus dengan `verified: true` dan `classification: 'preserved'`.

---

## 4. File Persistence Tests

| Skenario | Implementasi & Verifikasi | Status |
|---|---|---|
| Navigasi SPA (`/analisis` → `/token` → `/analisis`) | `job.pendingFile` di `src/store/analysis.js` menjaga objek `File` tetap utuh. | **PASS** |
| **Browser Refresh (F5)** | Ditambahkan persistensi **IndexedDB** (`runut_pending_files_v1`) di `src/store/analysis.js` (`setPendingFile` + `hydratePendingFile` saat `AnalyzeView.vue` mount), bukan hanya state memori Vue. | **PASS** |
| Retry setelah analisis gagal | Dihapus watcher prematur yang sebelumnya mengosongkan `file.value` saat `job.status === 'running'`; file hanya dibersihkan setelah analisis sukses atau tombol *Bersihkan*. | **PASS** |
| Backend restart (penyimpanan disk) | Terverifikasi di `document-preservation-matrix.test.js`: `saveOriginalUpload()` menulis ke `server/.data/uploads/<docId>.<ext>` dan `getOriginalUpload()` memuat ulang bit-per-bit identik (`sha256` cocok). | **PASS** |
| Container restart | Named volume `runut_uploads:/app/server/.data/uploads` dikonfigurasi di `docker-compose.yml`. Eksekusi nyata menunggu host Docker. | **PENDING (Docker host)** |

---

## 5. PostgreSQL Database Tests

- **Offline / Unit & Parity Tests (`server/test/postgres.test.js`):** **PASS** (validasi migrasi v1–v4 berurutan, pembersihan kolom legacy, whitelist `USER_COLUMNS`, resolusi SSL, dan paritas repository).
- **Live Disposable PostgreSQL Test (`RUNUT_TEST_DATABASE_URL`):** **SKIPPED (1 tes)** — PostgreSQL 18.6 terpasang dan berjalan lokal di Windows, namun `RUNUT_TEST_DATABASE_URL` / kredensial database uji tidak disetel di environment ini. Sesuai kebijakan keamanan, tidak dilakukan penebakan kata sandi.
- **Perintah untuk menjalankan uji PostgreSQL live pada database uji terpisah:**
  ```bash
  # Jalankan PostgreSQL uji via Docker Compose (terpisah dari produksi)
  docker compose up -d postgres
  RUNUT_TEST_DATABASE_URL="postgres://runut:runut_dev_password@127.0.0.1:5432/runut" \
    node --test server/test/postgres.test.js
  ```

---

## 6. Regression Testing Summary

- `npm run build` (Vite 5.4.21): **PASS** (`✓ built in 2.37s`, 59 modul, 0 error).
- `cd server && node --test test/*.test.js`: **PASS — 154 lulus, 0 gagal, 1 dilewati** (`postgres.test.js` live PG).
- Live Server Health Check (`GET http://localhost:3000/api/health`): **PASS (`200 OK`, `ok: true`)**.

---

## 7. Remaining Limitations

1. **Docker & LibreOffice nyata belum dieksekusi di host ini:** Karena Docker Desktop/Engine dan LibreOffice belum terpasang pada mesin Windows ini, verifikasi `docker build`, `soffice --version`, konversi live `.doc → .docx`, konversi live `.docx → .pdf`, serta restart container **wajib dijalankan terlebih dahulu** di mesin ber-Docker atau GitHub Actions CI sebelum menyatakan *full production readiness*.
2. **Uji PostgreSQL live memerlukan `RUNUT_TEST_DATABASE_URL`:** Perlu disuplai URL database PostgreSQL uji sekali pakai (misalnya dari container `postgres:16-alpine` pada `docker-compose.yml`) untuk mengeksekusi 1 tes live yang saat ini dilewati.
3. **Scanned PDF / Font Subset Ketat:** Tetap tidak diedit in-place agar tidak merusak tata letak; pengguna diarahkan mengunggah berkas sumber `.docx` untuk revisi penuh dengan preservasi tata letak.
