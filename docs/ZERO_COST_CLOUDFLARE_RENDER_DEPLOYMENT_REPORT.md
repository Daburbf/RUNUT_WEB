# RUNUT — Strictly Zero-Cost Deployment & Persistent Login Architecture Report

## 1. Final Zero-Cost Infrastructure Architecture

| Layer | Service | Plan | Role | Published Free Allowance & Key Limits |
| --- | --- | --- | --- | --- |
| **Frontend Hosting** | **Cloudflare Pages** | Free | Serves static Vue/Vite `dist/` on `https://<project>.pages.dev` | Unlimited static requests/bandwidth, 500 builds/mo, free HTTPS, commercial use permitted |
| **Same-Origin API Proxy** | **Cloudflare Pages Functions** (`functions/api/[[path]].js`) | Free | Proxies `/api/*` on the Pages origin to fixed `BACKEND_ORIGIN` | 100,000 Workers/Functions requests/day (shared free quota); static assets bypass Functions |
| **Backend API + Document Engine** | **Render Web Service** (`render.yaml` / `Dockerfile`) | Free | Node.js/Express + LibreOffice + PDF/DOCX/OCR processing | 750 free instance hours/mo, 512 MB RAM, shared CPU, spins down after 15 min idle (~30–60 s cold start), ephemeral local disk |
| **Primary Database** | **Neon PostgreSQL** | Free | Users, tokens, refresh hashes, payments, document metadata (`document_files` v6) | 0.5 GB storage, non-expiring, TLS required, scale-to-zero auto-suspend (~1–3 s wake-up; `PG_CONNECTION_TIMEOUT_MS=10000`) |
| **Persistent Document Storage** | **Cloudflare R2** (`server/src/services/r2Storage.js`) | Free | Authoritative private storage for immutable original PDF/DOCX/DOC uploads | 10 GB-month storage, 1M Class A ops/mo, 10M Class B ops/mo, $0 egress (requires payment method on file for R2 activation; stays $0 within free tier) |
| **AI Providers** | **OpenRouter (`:free`) -> Gemini Free -> Groq Free** | Free Only | Writing analysis & revisions (`STRICT_FREE_AI_ONLY=true`) | Upstream RPM/RPD free limits; paid models/providers strictly blocked |
| **Payments** | **Midtrans QRIS** | Sandbox (`MIDTRANS_IS_PRODUCTION=false`) | Safe sandbox testing only | No live payment collection enabled without explicit authorization |

---

## 2. Persistent Authentication Cookie Configuration

Implemented in `server/src/middleware/auth.js`:

- **Cookie Name**: `__Secure-runut_refresh` (legacy `runut_rt` still accepted on read for smooth session migration and cleared on logout)
- **Attributes**:
  - `HttpOnly` (inaccessible to frontend JavaScript)
  - `Secure` (`COOKIE_SECURE=true` in production)
  - `SameSite=Lax` (`COOKIE_SAME_SITE=lax` through Cloudflare same-origin proxy — no third-party cookie dependency!)
  - `Max-Age=2592000` (30 days) + matching `Expires` timestamp
  - `Path=/api/auth`
  - **No `Domain` attribute** (host-only cookie scoped strictly to `https://<project>.pages.dev`)
- **Security Controls**:
  - Refresh tokens are never stored in `localStorage` or `sessionStorage`; only SHA-256 hashes are stored in PostgreSQL `refresh_tokens`.
  - Short-lived HS256 JWT access tokens (`issuer: 'runut-api'`, `audience: 'runut-web'`) live in memory only.
  - Refresh token rotation with **reuse detection** (replaying a rotated token revokes all user sessions and increments `token_version`).
  - Logout revokes the server-side session and clears `__Secure-runut_refresh` with identical `Path`, `SameSite`, `Secure`, and `HttpOnly` attributes.

---

## 3. Cloudflare Pages Same-Origin API Proxy (`functions/api/[[path]].js`)

- Routes **only** `/api/*` through Cloudflare Pages Functions; static frontend assets are served directly by Cloudflare CDN.
- Uses fixed server-side `env.BACKEND_ORIGIN` (HTTPS only in production; rejects user-supplied destinations, credentials in URL, or subpaths -> prevents SSRF/open proxy).
- Preserves HTTP method, query string, request body, `Cookie`, `Authorization`, and `X-Forwarded-*` headers.
- Preserves **every `Set-Cookie` header individually** via `headers.getSetCookie()` + `responseHeaders.append('Set-Cookie', ...)` (never comma-joined).
- Strips any upstream `Domain=...` attribute so cookies stay strictly host-only on the Cloudflare Pages domain.
- Uses `redirect: 'manual'` and blocks upstream 3xx redirects to external hosts (`502 UNTRUSTED_UPSTREAM_REDIRECT`).
- Frontend `src/utils/api.js` uses relative `/api` paths (`VITE_API_BASE_URL` left empty in Cloudflare Pages production).

---

## 4. Persistent Document Storage (Cloudflare R2 + Neon Metadata)

Implemented in `server/src/services/r2Storage.js`, `server/src/services/fileStore.js`, and PostgreSQL Migration v6 (`server/src/repositories/migrations.js`):

- Private per-user object key namespace: `users/<userId>/documents/<docId>/original.<ext>`.
- Signed via built-in Node.js `node:crypto` AWS Signature V4 (`AWS4-HMAC-SHA256`, zero extra npm dependencies).
- Neon PostgreSQL stores authoritative metadata (`document_id`, `user_id`, `ext`, `original_name`, `size_bytes`, `sha256`, `storage_provider='r2'`, `storage_key`).
- **Fail-Closed Persistence**: When `FILE_STORAGE_PROVIDER=r2` is active, uploads write to R2 first; if R2 fails or is unconfigured, RUNUT returns `503` and **never** silently falls back to Render's ephemeral local disk or reports a false upload success.
- Verifies SHA-256 integrity on retrieval and enforces per-user ownership (`403` / `null` on cross-user access).
- Supports short-lived AWS SigV4 pre-signed download URLs (`generateR2SignedDownloadUrl`) in addition to authenticated backend streaming.

---

## 5. Verification Status Matrix (Honest Breakdown)

| Verification Layer | Status | Actual Evidence |
| --- | --- | --- |
| **Locally Verified (Windows, No Docker)** | **PASS** | **187 total backend tests: 184 passed, 0 failed, 3 conditionally skipped** (`postgres.test.js` live PG + `windows-document-processing.test.js` live `DOC->DOCX` & `DOCX->PDF`); `cloudflare-r2-and-persistent-auth.test.js` (3/3 pass); `deployment-durability-and-cors.test.js` (3/3 pass); `vite build` passed in 2.10 s; `npm audit` 0 high/critical vulns. |
| **CI Configured (GitHub Actions)** | **Configured, Pending Push** | `.github/workflows/ci.yml` includes strict `postgres-integration-tests` (`postgres:16-alpine`), `libreoffice-conversion-tests` (Ubuntu `libreoffice-writer`), `windows-native-tests`, `production-smoke-e2e`, `security-sast-semgrep`, `security-secrets-gitleaks`, `security-trivy-scan`, and `security-regression-tests`. |
| **Deployed & Remotely Verified** | **Not Yet Deployed** | Cloud CLIs/credentials (`wrangler`, `render`, `neon`, `gh`) are not available on this local workstation. No live `pages.dev` or `onrender.com` URL is claimed yet. |
| **Not Yet Verified Remotely** | **Pending Live Deploy** | Real browser restart cookie test on `https://<project>.pages.dev`, live Neon cold-start wake-up, live R2 bucket persistence across Render redeploy, and live Render Free 512 MB RAM LibreOffice/OCR execution under real load. |

---

## 6. Manual Dashboard Deployment Steps (Exact Order)

1. **GitHub Push**: Commit and push `main` to `https://github.com/Daburbf/RUNUT_WEB.git`; confirm all GitHub Actions jobs pass (zero skips in PostgreSQL & LibreOffice jobs).
2. **Cloudflare R2**: In Cloudflare Dashboard -> **R2** -> Create private bucket (e.g., `runut-private-docs`) -> Create R2 API Token (Object Read & Write scoped strictly to that bucket) -> record `R2_ACCOUNT_ID`, `R2_ACCESS_KEY_ID`, `R2_SECRET_ACCESS_KEY`, `R2_BUCKET`.
3. **Neon Free PostgreSQL**: In Neon Dashboard -> Create Free project -> copy pooled TLS `DATABASE_URL` (`?sslmode=require`).
4. **Render Free Backend**: In Render Dashboard -> **New Blueprint** from `Daburbf/RUNUT_WEB` (`render.yaml`) -> fill `DATABASE_URL`, `FRONTEND_URL=https://<your-pages-subdomain>.pages.dev`, `CORS_ORIGINS=https://<your-pages-subdomain>.pages.dev`, `R2_*`, `OPENROUTER_API_KEY`, `GEMINI_API_KEY`, `GROQ_API_KEY`, `ADMIN_EMAILS`, and optional SMTP/Google/Midtrans Sandbox keys -> deploy and verify `GET https://<render-host>/api/health` returns `200 OK` with `schema_version: 6`.
5. **Cloudflare Pages Frontend + Proxy**: In Cloudflare Dashboard -> **Workers & Pages** -> **Create** -> **Pages** -> Connect `Daburbf/RUNUT_WEB`:
   - Framework preset: `Vite`
   - Build command: `npm run build`
   - Build output directory: `dist`
   - Environment Variables (Production & Preview):
     - `BACKEND_ORIGIN=https://<render-host>` (server-side for `functions/api/[[path]].js`)
     - Leave `VITE_API_BASE_URL` **empty** so browser calls relative `/api/*` same-origin.
6. **Live Verification**:
   - Open `https://<project>.pages.dev`, log in, verify `__Secure-runut_refresh` in DevTools (Application -> Cookies: `HttpOnly`, `Secure`, `SameSite=Lax`, `Path=/api/auth`, `Max-Age=2592000`, host-only on `pages.dev`).
   - Close browser completely, reopen `https://<project>.pages.dev`, confirm session auto-restores via `/api/auth/refresh`.
   - Upload a PDF/DOCX, trigger Render redeploy/restart, confirm original template downloads with identical SHA-256.
   - Verify no provider has been upgraded to a paid plan.

---

## 7. Known Free-Tier Limitations

- **Render Free 512 MB RAM**: Heavy multi-page Tesseract OCR or simultaneous LibreOffice headless conversions may hit Render Free's 512 MB RAM limit or 30–60 s cold-start delay; if LibreOffice OOMs on large files, DOCX native editing and PDF native editing still operate without LibreOffice, and explicit errors are returned rather than generic text reconstruction.
- **Cloudflare R2 Free Activation**: Cloudflare R2 offers 10 GB free storage + $0 egress, but Cloudflare requires adding a payment method to activate R2 on an account (remains $0/month within the published free allowance).
- **AI Free Quotas**: `STRICT_FREE_AI_ONLY=true` prevents paid fallbacks; simultaneous exhaustion of OpenRouter `:free`, Gemini Free, and Groq Free returns an explicit `AI_FREE_QUOTA_EXHAUSTED` message.
