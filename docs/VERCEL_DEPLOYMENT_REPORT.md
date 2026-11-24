# RUNUT — Vercel Deployment Report (Superseded by Cloudflare Pages + R2 Zero-Cost Architecture)

> **Architecture Update**: Due to Vercel Hobby's non-commercial restriction and third-party cookie constraints, RUNUT's primary zero-cost production architecture has been finalized on **Cloudflare Pages Free + Cloudflare Pages Functions same-origin proxy + Render Free + Neon Free PostgreSQL + Cloudflare R2 Free**. See [ZERO_COST_CLOUDFLARE_RENDER_DEPLOYMENT_REPORT.md](./ZERO_COST_CLOUDFLARE_RENDER_DEPLOYMENT_REPORT.md) for the active deployment blueprint. This report is retained for reference if Vercel Pro is ever selected.

## 1. Vercel Project Configuration

Configured in `vercel.json` at repository root:

- **Framework Preset**: `vite`
- **Root Directory**: `.` (repository root)
- **Install Command**: `npm ci` (matches `package-lock.json`)
- **Build Command**: `npm run build`
- **Output Directory**: `dist`
- **SPA Rewrite**: `/((?!api/|assets/).*)` -> `/index.html` (serves all Vue routes on direct load & browser refresh without intercepting `/api/*` or `/assets/*`)
- **Static Security Headers**: `X-Content-Type-Options: nosniff`, `X-Frame-Options: DENY`, `Referrer-Policy: strict-origin-when-cross-origin`, `Permissions-Policy`, plus `Cache-Control: public, max-age=31536000, immutable` on `/assets/*`.
- **Frontend API Client** (`src/utils/api.js`): Reads `VITE_API_BASE_URL` (with backward-compatible fallback to `VITE_API_URL`) and warns if a production build points to `localhost`. Zero secrets are placed in `VITE_*` variables.

---

## 2. Frontend Deployment Status

- **Status**: **Configured & Locally Build-Verified; Pending Live Vercel Deployment**
- **Reason**: Vercel CLI is not installed globally on this local machine and `VERCEL_TOKEN` is not set in the environment. Per execution rules, no deployment URL is fabricated or claimed live prior to external verification.
- **Exact Steps to Deploy Frontend to Vercel**:
  1. Push the repository changes to `https://github.com/Daburbf/RUNUT_WEB.git`.
  2. In Vercel Dashboard -> **Add New Project** -> Import `Daburbf/RUNUT_WEB` (or run `npx vercel` after `npx vercel login`).
  3. Confirm root directory `.`, Framework `Vite`, Build `npm run build`, Output `dist`.
  4. Set Environment Variable (Production & Preview):
     - `VITE_API_BASE_URL=https://<your-deployed-backend-domain>`
  5. Deploy Preview first, verify routes & API connectivity, then promote to Production.

---

## 3. Backend Deployment Architecture (Option B: Separate Persistent Backend)

**Decision**: Retain the Express backend as a **separate persistent Docker/Node.js service** (e.g., Render Web Service via `render.yaml` / `Dockerfile`) rather than migrating it into Vercel Functions.

### Technical Justification
- **LibreOffice Headless (`soffice`)**: Required for legacy `.doc -> .docx`, `.docx -> .pdf`, and optional `.pdf -> .docx`. LibreOffice + Noto/DejaVu fonts exceed Vercel Function bundle limits (~250 MB) and require writable temporary profiles.
- **Tesseract OCR & PDF Rendering**: `@napi-rs/canvas`, `pdfjs-dist`, and `tesseract.js` (`ind.traineddata`/`eng.traineddata`) require native bindings and execution durations beyond Vercel Hobby's serverless timeout limits.
- **Cross-Origin Auth Compatibility**: Updated `server/src/middleware/auth.js` with `COOKIE_SAME_SITE=none` (automatically enforcing `Secure=true`, `HttpOnly=true`) so the `runut_rt` refresh cookie works seamlessly across Vercel (`https://<app>.vercel.app`) and a separate HTTPS backend (`https://<api>.onrender.com`).

---

## 4. Database Configuration

- **Engine**: Managed PostgreSQL 16+ with TLS/SSL (`DATABASE_URL`, `DATABASE_SSL=true`).
- **Recommended Zero-Cost Providers**: **Neon Free** or **Supabase Free** (~500 MB persistent storage without 30-day expiry; Render Free PostgreSQL expires after 30 days).
- **Schema Migrations**: Idempotent, advisory-locked migrations v1–v5 (`server/src/repositories/migrations.js`), automatically applied on startup and verified in CI (`postgres-integration-tests` with `RUNUT_REQUIRE_INTEGRATION_TESTS=true`).

---

## 5. File Storage Configuration

- **Original Uploaded Documents**: Persisted in PostgreSQL `document_files` (`BYTEA`, Migration v5, max 10 MB, `user_id` ownership isolation, `ON DELETE CASCADE`) via `server/src/services/fileStore.js`. Files survive container restarts on ephemeral free hosts and are never exposed via public URLs.
- **Temporary Processing Files**: Isolated per-job `os.tmpdir()` directories cleaned in `finally` blocks (`libreOffice.js`).
- **Vercel Blob Evaluation**: Private Vercel Blob storage is optional for future high-volume scaling (>500 MB), but is not required at launch and has free-tier storage/transfer quotas that must be monitored.

---

## 6. Environment Variable Checklist (No Secret Values)

### Vercel Frontend (Public Build-Time Only — Zero Secrets)
| Variable | Environment | Purpose |
| --- | --- | --- |
| `VITE_API_BASE_URL` | Production / Preview | Public HTTPS URL of the persistent backend API |

### Persistent Backend (`server/.env` / Render Dashboard)
| Variable | Required | Purpose |
| --- | --- | --- |
| `NODE_ENV` | Yes (`production`) | Enables production security enforcement & HSTS |
| `PORT` | Yes (`8080`) | HTTP listen port |
| `FRONTEND_URL` | Yes | Public Vercel HTTPS origin (e.g., `https://runut.vercel.app`) |
| `CORS_ORIGINS` | Recommended | Comma-separated allowed Vercel production/preview origins |
| `COOKIE_SAME_SITE` | Yes (`none` for split-origin) | Required for cross-origin HttpOnly refresh cookie |
| `DATABASE_URL` | Yes | Managed PostgreSQL connection string |
| `DATABASE_SSL` | Yes (`true`) | Enforces TLS for managed PostgreSQL |
| `JWT_ACCESS_SECRET` | Yes (>=32 chars) | HS256 JWT signing secret |
| `ADMIN_EMAILS` | Recommended | Comma-separated admin emails (fail-closed if empty) |
| `STRICT_FREE_AI_ONLY` | Yes (`true`) | Blocks paid AI providers/models |
| `AI_PROVIDER` | Yes (`openrouter`) | Primary free AI provider |
| `OPENROUTER_API_KEY` / `OPENROUTER_MODEL` | Yes | Primary `:free` model |
| `GEMINI_API_KEY` / `GEMINI_MODEL` | Recommended | Free fallback #1 |
| `GROQ_API_KEY` / `GROQ_MODEL` | Recommended | Free fallback #2 |
| `DOCX_PDF_CONVERSION_ENABLED` | Yes (`true`) | Enables LibreOffice conversion |
| `MIDTRANS_SERVER_KEY` / `MIDTRANS_CLIENT_KEY` / `MIDTRANS_IS_PRODUCTION` | Optional | Keep `MIDTRANS_IS_PRODUCTION=false` (sandbox) until authorized |
| `MAIL_HOST` / `MAIL_PORT` / `MAIL_USER` / `MAIL_PASS` / `MAIL_FROM` | Optional | SMTP for OTP & password reset |
| `GOOGLE_CLIENT_ID` | Optional | Google Sign-In OAuth2 Web Client ID |

---

## 7. Free-Tier & Commercial-Use Assessment

| Service | Free Tier Limits | Commercial-Use Restriction |
| --- | --- | --- |
| **Vercel Hobby** | 100 GB bandwidth/mo, non-commercial personal projects | **IMPORTANT**: Vercel Hobby prohibits commercial use. Acceptable for academic/prototype/sandbox evaluation; if live paid QRIS monetization is enabled, use **Vercel Pro** OR a commercial-permitted free static host (**Cloudflare Pages Free** or single-origin **Render Web Service**). |
| **Render Free Web Service** | 512 MB RAM, shared CPU, 15-min idle sleep (30–60 s cold start) | Permitted for low-traffic prototypes; upgrade when eliminating cold starts or scaling concurrent LibreOffice/OCR jobs. |
| **Neon / Supabase Free Postgres** | ~500 MB storage, TLS included | Suitable for initial launch with 30-day document retention cleanup. |
| **OpenRouter / Gemini / Groq Free** | Upstream RPM/RPD quotas | Zero-cost enforced via `STRICT_FREE_AI_ONLY=true`; no automatic billing. |

---

## 8. Actual Deployment & Health URLs

- **Vercel Production URL**: *Not yet deployed in this session (requires Vercel authentication / GitHub integration).*
- **Backend Public Health URL**: *Not yet deployed in this session (expected path: `https://<backend-domain>/api/health`).*

---

## 9. Local Build, Durability & Cross-Origin Verification Results

- **Storage Durability & Cross-Origin Auth Tests** (`server/test/deployment-durability-and-cors.test.js`): **3 passed, 0 failed**
  - Verified uploaded original PDF survives simulated backend restart with identical SHA-256 hash and strict owner-only access (`403 Forbidden` for other users, including disk-fallback isolation fix in `server/src/services/fileStore.js`).
  - Verified exact-origin CORS allowlist (`Access-Control-Allow-Origin: https://runut-web.vercel.app`, `Access-Control-Allow-Credentials: true`), untrusted origin rejection, `SameSite=None; Secure; HttpOnly` refresh cookie, credentialed refresh, and matching-attribute logout.
  - Verified `render.yaml` no longer provisions an expiring 30-day Render Free PostgreSQL database (`DATABASE_URL: sync: false` for Neon/Supabase Free) and defaults `MIDTRANS_IS_PRODUCTION` to `"false"` (sandbox).
- **Vercel Config Tests** (`server/test/vercel-deployment-config.test.js`): **3 passed, 0 failed**.
- **Full Backend Test Suite** (`node --test test/*.test.js`): **184 total — 181 passed, 0 failed, 3 conditionally skipped** (PostgreSQL live + 2 live LibreOffice binary tests, all 3 enforced fail-closed in GitHub Actions CI via `RUNUT_REQUIRE_INTEGRATION_TESTS=true`).
- **Frontend Production Build** (`npm.cmd run build`): **Passed** (`vite build` in 2.20 s, 59 modules, `dist/` verified).

---

## 10. Public Website Test Results & Security Verification

- **Local Equivalent Verification**: All core workflows (routing, auth, cross-origin cookies, refresh token reuse protection, BOLA/IDOR isolation, storage durability across restart, upload/analyze/revise/download, PDF & DOCX template preservation, zero RUNUT watermark, token reservations/cancellations, QRIS sandbox, SSRF/upload security) verified in automated local tests.
- **Live Public URL Verification**: Pending actual deployment to Vercel (`runut-web` project linked in `.vercel/project.json`) + persistent backend host.

---

## 11. Remaining Blockers & Limitations

1. **Missing Cloud CLI & Credentials on Local Machine**: Neither `vercel`, `render`, `gh`, `docker`, `psql`, nor `soffice` are installed locally, and `VERCEL_TOKEN` is unset. Pushing `main` to GitHub triggers all strict CI integration jobs (live PostgreSQL + live LibreOffice + SAST/Gitleaks/Trivy) and allows deploying directly via Vercel & Render dashboards.
2. **Commercial-Use Policy on Vercel Hobby**: Vercel Hobby prohibits commercial use. For live paid QRIS monetization, use Vercel Pro, Cloudflare Pages Free, or single-origin Render Web Service.
3. **Cross-Origin Cookie Restrictions (Safari ITP)**: While `COOKIE_SAME_SITE=none; Secure; HttpOnly` works on standard browsers, Safari/WebKit ITP may block cross-site cookies across unrelated domains (`*.vercel.app` vs `*.onrender.com`). Using a shared custom root domain (`app.yourdomain.com` + `api.yourdomain.com`) or single-origin deployment eliminates third-party cookie restrictions.
