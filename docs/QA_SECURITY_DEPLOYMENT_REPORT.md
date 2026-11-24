# RUNUT — QA, Security, Automated Testing & Production Deployment Audit Report

**Audit Date:** 2026-11-24  
**Scope:** End-to-end functional QA, automated testing, bug fixing, OWASP Top 10 / ASVS security hardening, dependency audit, database production hardening, Docker & CI/CD readiness.  
**Note:** No secrets, API keys, credentials, or private user documents are included in this report.

---

## 1. Project Architecture & Complete Feature Inventory

### Architecture Summary
- **Frontend:** Vue 3 + Vite 5 + Tailwind CSS + Vue Router (hash history) in `src/`. Access tokens are stored in memory only; refresh tokens use HttpOnly cookies (`runut_rt`). Zero `v-html` / `innerHTML` usage (XSS-safe by Vue template escaping).
- **Backend:** Node.js (ESM) + Express 4 in `server/src/`.
- **Database:** Dual-storage Repository Pattern (`server/src/repositories/`):
  - **Production:** PostgreSQL (`pg`) with versioned SQL migrations (`migrations.js`), advisory locks, `CHECK` constraints, partial/unique indexes, `set_updated_at()` triggers, SSL auto-detection, and connection pooling.
  - **Local Development:** Persistent local JSON file (`server/.data/runut-storage.json`) when `DATABASE_URL` is empty.
  - **Test:** Pure in-memory repository.
- **File Storage:** Immutable original uploads (DOCX/PDF) stored in `server/.data/uploads/` (`fileStore.js`), cleaned up on deletion and retention expiry.

### Complete Feature Inventory
1. **Authentication & Sessions:** Registration, email OTP verification, login, Google OAuth2 (JWKS cryptographic verification), HttpOnly refresh token rotation, logout, forgot/reset password (OTP + reset link), `token_version` session invalidation.
2. **User Dashboard & History:** Document listing with search/status filters, pending issue counts, document detail, rename, bulk delete, 30-day retention cleanup.
3. **Document Upload & Extraction:** TXT, DOCX (OOXML XML parser + Mammoth fallback), editable PDF, scanned PDF (automatic Tesseract OCR), reference files (up to 5).
4. **AI Writing Analysis & Rewriting:** OpenRouter (`particle-ai/particle-1:free` primary) + Google Gemini (`gemini-3.1-flash-lite` automatic fallback), Anti-AI-Slop rules, semantic preservation checks, deterministic coordinate validation & evidence ranking, single/batch issue accept/reject/restore.
5. **Document Template Preservation:**
   - **DOCX:** In-place OOXML `<w:t>` replacement preserving styles, fonts, tables, images, headers, footers, footnotes, page config, and bibliography.
   - **PDF:** Coordinate-aware in-place editing with visual comparison, subset-font & ToUnicode safety checks, multi-line wrapping, solid/gradient background restoration, photographic/scanned rejection (never silently replaces with generic PDF; zero RUNUT watermarks).
   - **DOCX-to-PDF:** LibreOffice headless conversion preserving edited DOCX template.
6. **Similarity & Citation Verification:** Internal repetition, user-provided references, SSRF-protected document URL extraction/fetching, Crossref/OpenAlex/Unpaywall/Semantic Scholar/DOAJ/PubMed Central metadata & OA verification, APA 7/IEEE/Harvard citation checking.
7. **Analysis Reports & Exports:** Separate JSON, PDF, DOCX analysis reports (6 highlight categories, non-authorship AI disclaimer, zero RUNUT watermarks) and annotated DOCX/PDF copies.
8. **Token Ledger & Midtrans Payments:** Progressive word-based token pricing (`Math.ceil(words / 1000)`), atomic SQL deduction/credit/refund with idempotency keys, Midtrans Core/Snap integration (QRIS, VA, e-wallet, card, cstore), SHA-512 webhook verification, PDF invoice generation.
9. **Admin Monitoring:** `/api/admin/ai-usage` quota & OpenRouter limit dashboard (fail-closed RBAC via `ADMIN_EMAILS`).

---

## 2. Automated Test Execution Summary

**Command Executed:** `cd server && node --test test/*.test.js`  
**Frontend Build Executed:** `npm run build` (`vite build` — succeeded in 2.48s, 59 modules transformed)

| Metric | Count |
| :--- | :---: |
| **Total Tests Executed** | **135** |
| **Total Tests Passed** | **134** |
| **Total Tests Failed** | **0** |
| **Total Tests Skipped** | **1** |

### Skipped Test (Explicit Reason)
- `server/test/postgres.test.js` — `adapter PostgreSQL: migrasi otomatis, token_version, ledger atomik, dan health check` was skipped because `RUNUT_TEST_DATABASE_URL` (live PostgreSQL test instance) is not configured in the local Windows environment. All offline PostgreSQL migration, whitelist, SSL, and repository parity tests in `postgres.test.js` **passed**.

### Test Suites Executed (21 files)
1. `academic-sources-expanded.test.js`
2. `ai-provider-fallback.test.js`
3. `analysis-report-export.test.js`
4. `app.test.js`
5. `auth-google-otp.test.js`
6. `dense-reflow-and-multisource.test.js`
7. `document-preservation.test.js`
8. `docx-pdf-templates-unified.test.js`
9. `download-template-no-watermark.test.js`
10. `edge-cases.test.js`
11. `external-citations-similarity.test.js`
12. `final-preservation-and-sources.test.js`
13. `ocr-pipeline.test.js`
14. `payments-notify.test.js`
15. `payments.test.js`
16. `pdf-editing-advanced.test.js`
17. `pdf-subset-multiline-background.test.js`
18. `postgres.test.js` *(expanded)*
19. `security-and-acceptance.test.js` *(new)*
20. `units.test.js`
21. `writing-similarity-citations.test.js`

---

## 3. Bugs Discovered & Fixed

| Severity | Issue | Root Cause | Fix Implemented | Status |
| :---: | :--- | :--- | :--- | :---: |
| **High** | `token_version` never updated in PostgreSQL on password reset | `'token_version'` was missing from `USER_COLUMNS` whitelist in `server/src/repositories/postgres.js` | Added `'token_version'` to `USER_COLUMNS`; added regression test | **Fixed** |
| **Medium** | `countPendingByDocument` double-counted issues across historical analyses | Query summed `'active'` issues across all `analysis_results` of a document instead of only the latest analysis | Updated SQL in `postgres.js` and filter in `memory.js` to query only the latest analysis | **Fixed** |
| **Medium** | Multer file-size errors & malformed JSON returned HTTP `500` | `errorHandler` in `errors.js` only checked `err.isHttp` | Added explicit `MulterError` (`413`/`400`) and `entity.parse.failed` (`400`) handling | **Fixed** |
| **Medium** | Retention cleanup left orphaned uploaded files & expired refresh tokens | `retention.js` only deleted `documents` rows without removing disk uploads or expired `refresh_tokens` | Updated `documents.deleteExpired` to return deleted IDs, invoke `deleteOriginalUpload(id)`, and run `refreshTokens.deleteExpired()` | **Fixed** |
| **Medium** | Legacy unused DB columns & methods (`is_premium`, `premium_until`, `premium_days`, `locked`, `extendPremium`) | Leftover from pre-token subscription model | Removed from `postgres.js`, `memory.js`, and dropped safely in migration `v2` | **Fixed** |
| **Low** | `fetchBlob()` in frontend did not auto-refresh expired access tokens on `401` | Only `api()` had retry-after-refresh logic | Added single-retry `refreshPair()` on `401` in `src/utils/api.js` | **Fixed** |
| **Low** | `auth-google-otp.test.js` failed when local `.env` defined `GOOGLE_CLIENT_ID` | Test cleared `config.google.clientId` but not `process.env.GOOGLE_CLIENT_ID` | Saved, cleared, and restored `process.env.GOOGLE_CLIENT_ID` in test | **Fixed** |

**Bugs Remaining:** None reproduced in the automated test suite.

---

## 4. Security Vulnerabilities Discovered & Fixed

| Severity | Vulnerability (OWASP) | Location | Fix Implemented |
| :---: | :--- | :--- | :--- |
| **Critical** | **Fail-Open Admin Access Control** (Broken Access Control): `/api/admin/ai-usage` allowed any authenticated user when `ADMIN_EMAILS` was empty | `server/src/app.js` | Enforced fail-closed check returning `403 ADMIN_NOT_CONFIGURED` when `ADMIN_EMAILS` is empty |
| **High** | **SSRF via DNS Rebinding, Unsafe Ports, & Unbounded Stream** | `server/src/services/sourceFetcher.js` | Added DNS resolution IP check (`dns.promises.lookup`), port allowlist (`80`/`443`), full IPv4/IPv6 + IPv4-mapped IPv6 blocking, and streaming byte cap |
| **High** | **File Upload Bypass, DOCX ZIP Bomb, Path Traversal & XXE** | `server/src/routes/analysis.js`, `server/src/services/docxEditor.js` | Added magic-byte validation (`%PDF-`, `PK`, OLE2 encrypted rejection, binary TXT rejection), max 500 ZIP entries, 25 MB uncompressed cap, path traversal guard, and `<!DOCTYPE`/`<!ENTITY` rejection |
| **High** | **Timing Side-Channel on Payment Webhook Signature** | `server/src/services/payments.js` | Replaced `===` with constant-time `crypto.timingSafeEqual` |
| **High** | **HTML Injection in Verification/Reset Emails** | `server/src/routes/auth.js` | Added `escapeHtml()` on user-controlled fields in email HTML templates |
| **High** | **Prompt Injection Boundary Hardening** | `server/src/services/prompts/writingEngine.js` | Added explicit untrusted-data boundary instructions in system prompts (ID & EN) |
| **High** | **Vulnerable Server Dependencies** (`body-parser`, `multer`, `qs`, `nodemailer`) | `server/package.json`, `server/package-lock.json` | Patched via `npm audit fix` + upgraded `nodemailer` to `^10.6.1` (**0 vulnerabilities**) |
| **Medium** | **Missing Security Headers & Export/Payment Rate Limits** | `server/src/app.js` | Added `Referrer-Policy`, `Permissions-Policy`, HSTS (production), `Cache-Control: no-store` on `/api`, plus `exportLimiter` & `paymentLimiter` |
| **Medium** | **Docker Container Running as Root without Healthcheck** | `Dockerfile` | Pinned `node:20.18-alpine`, switched to non-root `USER node`, added `HEALTHCHECK` |

> **Secret Hygiene Action Required:** Local `server/.env` (gitignored, not tracked) contains development/sandbox API keys. Rotate any keys that were ever shared or used outside local testing before production deployment.

---

## 5. Dependency & Supply Chain Audit

- **Frontend (`package.json`):** `npm audit --omit=dev --audit-level=moderate` → **0 vulnerabilities**
- **Backend (`server/package.json`):**
  - **Before:** 4 vulnerabilities (3 high: `body-parser`, `multer`, `nodemailer`; 1 moderate: `qs`)
  - **After:** `npm --prefix server audit --omit=dev --audit-level=moderate` → **0 vulnerabilities**

---

## 6. Database Migration & Performance Improvements

- **Versioned Migrations (`server/src/repositories/migrations.js`):**
  - Added `schema_migrations` table protected by PostgreSQL advisory lock (`pg_advisory_lock`) for safe rolling/multi-instance deploys.
  - `v1_initial_schema`: Clean 7-table schema with `CHECK` constraints, `FOREIGN KEY ... ON DELETE CASCADE`, partial/unique indexes, and `set_updated_at()` triggers.
  - `v2_cleanup_legacy_and_hardening`: Safe non-destructive upgrade for existing databases (drops unused legacy columns, adds `CHECK` constraints & missing indexes).
- **Performance & Reliability:**
  - `issues.createMany()` in `postgres.js` converted from N sequential inserts to a single multi-row batch `INSERT`.
  - Added `PG_POOL_MAX`, `PG_IDLE_TIMEOUT_MS`, `PG_CONNECTION_TIMEOUT_MS`, `PG_STATEMENT_TIMEOUT_MS`, and automatic cloud SSL resolution.
  - Real-time DB health check (`SELECT 1`, latency, schema version, pool metrics) integrated into `GET /api/health` (returns HTTP `503` if DB is unreachable).
  - Graceful shutdown (`SIGINT`/`SIGTERM`) closes HTTP server, clears retention interval, and drains PostgreSQL pool cleanly.

---

## 7. CI/CD & Production Configuration Changes

- Added [`.github/workflows/ci.yml`](../.github/workflows/ci.yml): blocks merge/deploy on tracked `.env` files, `npm audit` high vulnerabilities, backend test failures, frontend build failures, or Docker build failures.
- Added root [`.env.example`](../.env.example) and updated [`server/.env.example`](../server/.env.example) with PostgreSQL production pool/SSL/timeout variables.
- Hardened [`Dockerfile`](../Dockerfile) (pinned `node:20.18-alpine`, non-root `node` user, `HEALTHCHECK`).

---

## 8. Modified & Added Files

- **Added:**
  - `server/src/repositories/migrations.js`
  - `server/test/security-and-acceptance.test.js`
  - `.github/workflows/ci.yml`
  - `.env.example`
  - `docs/QA_SECURITY_DEPLOYMENT_REPORT.md`
  - `docs/PRODUCTION_DEPLOYMENT_CHECKLIST.md`
- **Modified:**
  - `server/src/repositories/postgres.js`
  - `server/src/repositories/memory.js`
  - `server/src/repositories/index.js`
  - `server/src/config.js`
  - `server/src/app.js`
  - `server/src/middleware/errors.js`
  - `server/src/routes/auth.js`
  - `server/src/routes/analysis.js`
  - `server/src/routes/documents.js`
  - `server/src/services/sourceFetcher.js`
  - `server/src/services/docxEditor.js`
  - `server/src/services/payments.js`
  - `server/src/services/retention.js`
  - `server/src/services/prompts/writingEngine.js`
  - `server/package.json` & `server/package-lock.json`
  - `server/.env.example`
  - `server/test/postgres.test.js`
  - `server/test/auth-google-otp.test.js`
  - `src/utils/api.js`
  - `Dockerfile`

---

## 9. Remaining Deployment Blockers / Pre-Deploy Requirements

No code-level blockers remain. Before going live in production, operations must complete:
1. **Live PostgreSQL Verification:** Run `RUNUT_TEST_DATABASE_URL=<staging-pg-url> node --test server/test/postgres.test.js` against a real staging PostgreSQL database to verify live migration execution.
2. **Persistent Upload Storage:** `server/.data/uploads` stores immutable original DOCX/PDF files on local disk. On ephemeral container hosts (e.g., Render free tier), mount a persistent disk or migrate `fileStore.js` to object storage (S3/R2) so uploaded templates survive container restarts.
3. **Production Environment Secrets:** Provision fresh, rotated production values for `DATABASE_URL`, `JWT_ACCESS_SECRET` (>= 32 chars), `OPENROUTER_API_KEY`, `GEMINI_API_KEY`, `ADMIN_EMAILS`, `MIDTRANS_SERVER_KEY`, `MAIL_*`, and `GOOGLE_CLIENT_ID`.

---

## 10. Local Development & Production Deployment Instructions

### Local Development
```bash
# 1. Install dependencies
npm install
npm --prefix server install

# 2. Configure environment
cp .env.example .env.local
cp server/.env.example server/.env
# Fill AI_API_KEY / OPENROUTER_API_KEY and optional DATABASE_URL in server/.env

# 3. Run automated tests
cd server && node --test test/*.test.js

# 4. Start backend (port 3000) and frontend (port 5173)
node server/src/index.js
npm run dev
```

### Production Deployment (Docker / Render)
1. Provision a managed PostgreSQL database and automated daily backups.
2. Set all required environment variables (see `docs/PRODUCTION_DEPLOYMENT_CHECKLIST.md`).
3. Build and run via Docker:
   ```bash
   docker build -t runut:prod .
   docker run -p 8080:8080 --env-file /secure/runut.prod.env runut:prod
   ```
4. Place behind an HTTPS reverse proxy (TLS 1.2+, HTTP->HTTPS redirect, `X-Forwarded-For`/`X-Forwarded-Proto` set only by trusted proxy).
5. Verify `GET https://<domain>/api/health` returns `200` with `database.ok: true` and `database.schema_version >= 2`.
