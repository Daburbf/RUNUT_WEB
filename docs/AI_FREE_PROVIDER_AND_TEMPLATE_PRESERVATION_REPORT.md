# RUNUT — Final Release Audit: Free Multi-Model AI Provider & Strict Original Template Preservation Report

Tanggal Audit: 2026-11-25  
Repositori: `https://github.com/Daburbf/RUNUT_WEB.git`

---

## 1. Git & Secret Safety Audit

* `git ls-files .env .env.local server/.env` → **Kosong (tidak ada berkas `.env` yang dilacak Git).**
* `git log --all --oneline -- server/.env .env .env.local` → **Kosong (tidak pernah ter-commit dalam riwayat Git).**
* Pemindaian kode frontend (`src/`) dan hasil build produksi (`dist/`) → **0 kunci API / rahasia provider bocor ke bundle browser.**
* `.env.example` dan `server/.env.example` hanya berisi placeholder kosong tanpa nilai rahasia.

---

## 2. Live Verified Free AI Model Registry (Catalog Check 2026-11-25)

Diverifikasi langsung terhadap katalog publik OpenRouter (`GET https://openrouter.ai/api/v1/models`) pada 2026-11-25:

| Provider | Model ID | Harga Prompt | Harga Completion | Context Length | `response_format` / `structured_outputs` | Status Default | Kebijakan Privasi Dokumen Rahasia |
|---|---|---|---|---|---|---|---|
| OpenRouter | `particle-ai/particle-1:free` | `0` | `0` | `1,048,576` | Ya / Ya | Aktif (Primary) | Diizinkan (periksa kebijakan retensi akun) |
| OpenRouter | `baidu/ernie-5.5-flash-preview:free` | `0` | `0` | `1,024,000` | Ya / Ya | Aktif (Fallback 1) | Diizinkan (periksa kebijakan retensi akun) |
| OpenRouter | `inclusionai/ling-3.2-flash:free` | `0` | `0` | `1,048,576` | Ya / Ya | Aktif (Fallback 2) | Diizinkan (periksa kebijakan retensi akun) |
| OpenRouter | `openrouter/free` | `0` | `0` | `200,000` | Ya / Ya | Aktif (Fallback 3) | **Diblokir** untuk dokumen rahasia (routing dinamis) |
| OpenRouter | `nvidia/nemotron-3-ultra-550b-a55b:free` | `0` | `0` | `1,000,000` | **Tidak** / **Tidak** | **Nonaktif** (`ENABLE_NEMOTRON_FREE=false`) | **Diblokir keras** (peringatan penggunaan data) |
| Google AI Studio | `gemini-3.1-flash-lite` | Free Tier | Free Tier | Sesuai proyek | Ya | Aktif (Provider Independen & Stage B Validation) | **Diblokir** untuk dokumen rahasia tanpa persetujuan eksplisit |
| Groq | *(dinonaktifkan)* | — | — | — | — | **Nonaktif** (`ENABLE_GROQ_FREE=false`) | `llama-3.3-70b-versatile` (retired 16 Agu 2026) diblokir keras (`AI_DEPRECATED_MODEL_BLOCKED`) |

---

## 3. Primary Model Selection & Evaluation Status

* **Posisi model:** `particle-ai/particle-1:free` (berbasis DeepSeek V4.1 Flash) berfokus kuat pada coding/software engineering; `baidu/ernie-5.5-flash-preview:free` diposisikan lebih luas untuk knowledge-work & deep-research; `inclusionai/ling-3.2-flash:free` mendukung hybrid reasoning dan JSON terstruktur.
* **Rekomendasi sementara:** `baidu/ernie-5.5-flash-preview:free` direkomendasikan sebagai kandidat primary content-editing dan `particle-ai/particle-1:free` sebagai alternatif — **namun pemilihan tetap sepenuhnya dapat dikonfigurasi melalui `OPENROUTER_PRIMARY_MODEL`**.
* **Status Evaluasi Terkontrol Live:** **Belum dijalankan terhadap endpoint live** karena `OPENROUTER_API_KEY` tidak diisi pada lingkungan lokal ini. Tidak ada skor evaluasi kualitas model yang dikarang; evaluasi komparatif nyata (meaning preservation, grammar, academic style, citation integrity, latency, failure rate) wajib dijalankan setelah kunci API OpenRouter aktif di staging/production.

---

## 4. Shared Quota Protection, Reset Behavior & Paid-Endpoint Blocking

* **OpenRouter Free Account Budget:** 50 permintaan/hari dan 20 permintaan/menit dibagi pada level akun gratis. Permintaan gagal dapat mengurangi kuota harian, sehingga RUNUT menerapkan **0 retry** pada model OpenRouter yang sama.
* Ketika OpenRouter mengembalikan 402/429 (kuota akun harian atau 20 RPM terlampaui), seluruh varian OpenRouter lainnya dilewati dan permintaan langsung dialihkan ke provider independen (**Gemini Free**).
* **Gemini Free Reset:** Mengikuti jadwal dokumentasi Google (tengah malam Waktu Pasifik / `America/Los_Angeles`) dan header nyata bila tersedia; tidak pernah mengarang jadwal reset.
* **Perlindungan Zero-Cost (`STRICT_FREE_AI_ONLY=true`):** Memblokir seluruh provider berbayar (`openai`, `anthropic`, `claude`, `deepseek`, `azure`, `bedrock`), model non-`:free`, model di luar registry, model retired (`llama-3.3-70b-versatile`), dan model yang harganya berubah menjadi `> 0` di katalog OpenRouter (`AI_PRICE_CHANGED_BLOCKED`).
* Pelacakan kuota persisten ditambahkan di PostgreSQL Migrasi v9 (`ai_provider_quotas`, tanpa menyimpan API secret).

---

## 5. Privacy Gate

* Untuk dokumen `confidential: true`:
  * **Diblokir:** `openrouter/free` (routing dinamis), `nvidia/nemotron-3-ultra-550b-a55b:free` (peringatan penggunaan data), dan `gemini-3.1-flash-lite` tanpa `userConsentForFreeTier: true`.
  * Jika tidak ada provider gratis yang memenuhi syarat privasi, server mengembalikan `503 AI_PRIVACY_NO_ELIGIBLE_PROVIDER` (fail-closed).
* Hanya teks blok editable minimal yang dikirim ke AI; biner DOCX/PDF tidak pernah dikirim ke endpoint AI.

---

## 6. DOCX Structural Fingerprint & 3-Stage Preservation Engine

Diimplementasikan di `server/src/services/templatePreservationEngine.js` dan `server/src/services/docxEditor.js`:

* **Stage A (Content Editing AI):** Mengembalikan JSON `{ document_id, language, replacements: [{ block_id, revised_text }] }`.
* **Stage B (Template Mapping & Validation):** Validasi deterministik + opsional Gemini Free untuk `block_id`, placeholder `{{...}}`, sitasi, dan batas rasio pertumbuhan teks (`MAX_DOCUMENT_TEXT_GROWTH_RATIO=1.15`, maks 1 kali retry pemendekan `MAX_TEMPLATE_REPAIR_ATTEMPTS=1`).
* **Stage C (Deterministic Template Engine):**
  * Tidak membandingkan hash mentah `word/document.xml` setelah teks berubah; sebaliknya menormalisasi node `<w:t>` untuk menghasilkan `normalized_xml_hierarchy_hash` yang memverifikasi hierarki XML, `w:pPr`, `w:rPr` (bold, italic, underline, font, dll.), dimensi tabel, cell merges (`w:gridSpan`, `w:vMerge`), `w:sectPr`, hyperlinks, dan bookmarks.
  * Memverifikasi hash SHA-256 identik untuk semua bagian paket non-teks: `[Content_Types].xml`, `word/styles.xml`, `word/numbering.xml`, `word/settings.xml`, `word/theme/*`, `word/media/*`, `word/header*.xml`, `word/footer*.xml`, `word/footnotes.xml`, `word/endnotes.xml`, `word/comments.xml`, dan semua berkas `.rels`.
  * Berkas asli unggahan tetap **immutable** (SHA-256 asli tidak berubah); berkas hasil memiliki SHA-256 baru karena teks berubah.
  * **Keterbatasan verifikasi lokal:** Render visual halaman-per-halaman via LibreOffice tidak berjalan di host Windows lokal karena LibreOffice belum terpasang di mesin lokal (tercakup oleh job CI Ubuntu `libreoffice-conversion-tests`).

---

## 7. PDF & Legacy DOC Safety

* **PDF Native & AcroForm:** Penyuntingan in-place hanya diizinkan bila font, area teks, dan kemiripan visual lolos validasi tanpa menimpa teks dengan kotak putih.
* **PDF Pindai (Scanned PDF):** Fail-closed (`SCANNED_PDF_UNSUPPORTED_FOR_NATIVE_EDIT`). OCR hanya mengekstrak teks untuk analisis dan tidak pernah diklaim sebagai penyuntingan native atas gambar pindai.
* **Legacy `.DOC`:** Validasi magic bytes OLE2 + konversi melalui LibreOffice ke salinan kerja tanpa mengubah berkas asli. Tidak diklaim memiliki preservasi template sempurna tanpa validasi LibreOffice nyata.
* **Tanpa konversi format diam-diam:** Permintaan unduhan `.docx` untuk unggahan `.pdf` ditolak `422 FORMAT_MISMATCH_USE_PDF`.

---

## 8. Complete Verification Totals (Separated Honestly)

| Kategori | Status | Bukti Terukur |
|---|---|---|
| **Locally Verified — Full Backend Suite** | **PASS** | `npm.cmd --prefix server test`: **213 total — 209 passed, 0 failed, 4 conditionally skipped** (`postgres.test.js` live PG, `windows-document-processing.test.js` `2b` & `3b` live LibreOffice, `oci-object-storage.test.js` opt-in live OCI) dalam 12.17 s. |
| **Locally Verified — Targeted New & AI/Preservation Suites** | **PASS** | `free-multimodel-and-template-preservation.test.js` (10/10), `zero-cost-ai-policy.test.js` (3/3), `ai-provider-fallback.test.js` (10/10), `document-preservation.test.js` (4/4), `template-preservation-complete.test.js` (5/5), `render-neon-simple-deploy.test.js` (3/3), `app.test.js` + `security-and-acceptance.test.js` (24/24) = **59/59 passed**. |
| **Locally Verified — Frontend Production Build** | **PASS** | `npm.cmd run build` (`vite build`): **59 modules transformed** dalam 3.82 s, 0 secret di `dist/`. |
| **CI Verified** | **Pending Push / Run** | Akan diverifikasi pada commit push terbaru di GitHub Actions (`.github/workflows/ci.yml`). |
| **Deployed** | **Not Yet Deployed** | Belum di-deploy ke Render / Cloudflare Pages / Neon dari sesi lokal ini. |
| **Remotely Verified** | **Not Yet Verified** | Menunggu deploy publik dan verifikasi URL live. |
| **Not Yet Verified** | **Open Blockers** | (1) Evaluasi kualitas live ERNIE vs Particle vs Ling dengan kunci API OpenRouter nyata; (2) Render visual halaman-per-halaman DOCX/DOC pada LibreOffice lokal Windows (terverifikasi di CI Ubuntu); (3) Deploy produksi & migrasi v9 pada Neon PostgreSQL live. |
