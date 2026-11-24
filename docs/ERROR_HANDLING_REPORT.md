# RUNUT — Error Handling & Two-Phase Token Transaction Report

**Date:** 2026-11-24

---

## 1. Centralized Error Handling Architecture

- **Request Tracing (`server/src/middleware/errors.js`):** Every HTTP request receives a unique `X-Request-Id` (`req.requestId`) via `attachRequestId` middleware. All structured server error logs and JSON error responses include `request_id`.
- **Safe Public Responses:**
  - Known operational errors (`HttpError`, Multer errors, JSON parse errors) return clean Indonesian user-facing messages, deterministic `code`, and `request_id`.
  - Unexpected `500` errors log structured JSON (`event: 'api_error'`, `request_id`, `status`, `code`, `path`, `reason`) on the server while returning only `"Terjadi kesalahan pada server."` (`code: 'INTERNAL_ERROR'`) to clients — never leaking stack traces, API keys, DB credentials, or internal paths.

### Standard Error Codes & User Messages

| Code | HTTP | User-Facing Message (Indonesian) | Recovery Action |
| :--- | :---: | :--- | :--- |
| `INSUFFICIENT_TOKENS` | 402 | Token Anda tidak mencukupi untuk mengunduh file ini. | Top up token |
| `RESERVATION_EXPIRED` | 410 | Reservasi unduhan sudah kedaluwarsa. Token Anda tidak dipotong; silakan mulai unduhan ulang. | Safe retry |
| `RESERVATION_NOT_ACTIVE` | 409 | Transaksi unduhan tidak aktif. | Start new download |
| `TRANSACTION_FORBIDDEN` | 403 | Anda tidak berhak mengakses transaksi unduhan ini. | Re-authenticate |
| `EXPORT_VALIDATION_FAILED` | 500 | File hasil ekspor gagal melewati pemeriksaan keamanan. | Reservation released; retry or use DOCX |
| `CONVERTER_UNAVAILABLE` | 503 | Konversi PDF belum tersedia. Silakan unduh DOCX atau periksa konfigurasi server. | Reservation released; download DOCX |
| `FILE_TOO_LARGE` | 413 | Ukuran file melebihi batas maksimum unggahan (5 MB). | Reduce file size |
| `EMPTY_FILE` | 400 | File kosong atau tidak dapat dibaca. | Upload valid file |
| `INVALID_FILE_SIGNATURE` | 415 | File bukan dokumen yang valid (tanda tangan berkas tidak cocok). | Upload genuine TXT/DOCX/PDF |
| `ENCRYPTED_DOCUMENT` | 400 | Dokumen DOCX terenkripsi / dilindungi kata sandi tidak dapat diproses. | Remove password & re-upload |
| `UNSAFE_DOCX_ARCHIVE` | 400 | Arsip DOCX ditolak (path traversal / ZIP bomb / DOCTYPE). | Re-save clean DOCX |
| `INVALID_JSON` | 400 | Format JSON permintaan tidak valid. | Fix payload |
| `ADMIN_NOT_CONFIGURED` / `ADMIN_ONLY` | 403 | Akses pemantauan kuota AI hanya untuk admin. | Configure `ADMIN_EMAILS` |

---

## 2. Two-Phase Download Token Reservation & Commitment

### Problem Solved
Previously, clicking Download immediately called `tokenTransactions.deduct()`, causing users to lose tokens even when cancelling the Save As dialog, closing File Explorer, or encountering a download/conversion error.

### Two-Phase Flow (`download_transactions` table — Migration `v3`)
1. **Phase A — Reserve (`POST /api/documents/:id/download/reserve`):**
   - Acquires a row-level lock (`SELECT ... FROM users WHERE id = $1 FOR UPDATE` in PostgreSQL; per-user mutex in memory).
   - Auto-expires stale reservations (`expires_at <= now()`).
   - Verifies `available_balance = token_balance - active_reserved_tokens >= 1`.
   - Creates a `download_transactions` row with `state = 'reserved'`, `committed_tokens = 0`, `idempotency_key`, and `expires_at = now() + 300s` (configurable via `DOWNLOAD_RESERVATION_TTL_SECONDS`).
   - **Does NOT deduct `users.token_balance`.**
2. **File Generation & Validation (`GET /api/documents/:id/download/file?tx=<txId>`):**
   - Verifies user & document ownership + active reservation.
   - Generates DOCX/PDF/TXT and validates file magic bytes (`PK` / `%PDF-`).
   - Marks `state = 'file_prepared'`. If generation/conversion fails, marks `state = 'failed'` immediately — **zero tokens deducted**.
3. **Phase B — Save Confirmation & Atomic Commit / Cancel:**
   - **File System Access API (`showSaveFilePicker`):**
     - If user cancels Save As / closes File Explorer (`AbortError`), frontend immediately calls `POST /api/documents/:id/download/:txId/cancel` → `state = 'cancelled'`, message: `"Unduhan dibatalkan. Token Anda tidak dipotong."`
     - Only **after** `writable.write(blob)` and `writable.close()` resolve does frontend call `POST /api/documents/:id/download/:txId/commit`, which atomically deducts 1 token, writes to `token_transactions` (`idempotency_key = download_commit:<txId>`), and sets `state = 'committed'`.
   - **Fallback Browsers (without `showSaveFilePicker`):**
     - Sends file via Blob download and displays an explicit **Confirm / Cancel** bar rather than falsely claiming disk save verification. Unconfirmed reservations expire automatically after TTL without deducting tokens.

### Transaction States
`pending` · `reserved` · `file_prepared` · `save_confirmed` · `committed` · `cancelled` · `expired` · `failed` · `refund_pending` · `refunded`

### Concurrency, Idempotency & Reconciliation
- Double-click protection in frontend (`inFlightDownloads`) + backend `idempotency_key` unique partial index.
- Duplicate `/commit` is idempotent (never double-charges).
- Duplicate `/cancel` is idempotent; `/cancel` after `committed` is rejected (`409`).
- `retention.js` and `reserve()` automatically transition expired reservations to `state = 'expired'`, releasing `reserved_tokens`.
- Full audit trail exposed at `GET /api/tokens/downloads` and `GET /api/tokens/transactions` with `balance`, `reserved_tokens`, and `available_balance`.
