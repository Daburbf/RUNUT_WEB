# RUNUT — Final Vercel Hobby Free Deployment Report

> **Architecture Update**: RUNUT's primary zero-cost production architecture is **Cloudflare Pages Free + Pages Functions + Oracle Cloud Always Free (A1 ARM64 + OCI Object Storage Always Free) + Neon Free PostgreSQL** (see [FINAL_ZERO_COST_DEPLOYMENT_REPORT.md](./FINAL_ZERO_COST_DEPLOYMENT_REPORT.md)). Vercel Hobby remains an optional non-commercial alternative only.

> **CRITICAL ELIGIBILITY GATE (VERCEL HOBBY)**:
> Vercel Hobby is strictly restricted to **personal, non-commercial use**.
> - **Eligible**: Personal, academic, portfolio, or non-commercial evaluation with `MIDTRANS_IS_PRODUCTION=false` (sandbox only, zero live token sales).
> - **NOT Eligible**: Operating RUNUT as a commercial service or selling tokens for real money. If commercial operation is intended, **STOP** — do not use Vercel Hobby; use **Cloudflare Pages Free** (already supported via `functions/api/[[path]].js`) or upgrade to **Vercel Pro**.

---

## 1. Final USD 0 Hosting Architecture (Eligible Non-Commercial Use)

| Component | Service | Plan | Purpose & Key Constraints |
| --- | --- | --- | --- |
| **Frontend + API Rewrite** | **Vercel** (`vercel.json`) | Hobby (Free) | Static Vite `dist/` on `https://<project>.vercel.app`; External Rewrite `/api/:path*` avoids the 4.5 MB Vercel Function body limit; 120 s proxy timeout; **non-commercial only**. |
| **Backend API + Document Engine** | **Render** (`render.yaml` / `Dockerfile`) | Free Web Service | Node.js/Express + LibreOffice + PDF/DOCX/OCR; 512 MB RAM, sleeps after 15 min idle (~30–60 s cold start), ephemeral local disk. |
| **Relational Database** | **Neon** | Free PostgreSQL | Non-expiring external PostgreSQL with TLS (`DATABASE_SSL=true`, Migration v6, `PG_CONNECTION_TIMEOUT_MS=10000` for scale-to-zero wake-up, 0.5 GB storage). |
| **Permanent Document Storage** | **Cloudflare R2** (`server/src/services/r2Storage.js`) | Free | Private bucket (`users/<userId>/documents/<docId>/original.<ext>`), AWS SigV4, SHA-256 verification, 10 GB-mo free, $0 egress, fail-closed `503` on outage (never falls back to Render local disk). |
| **AI & Payments** | **OpenRouter (`:free`) -> Gemini Free -> Groq Free** + **Midtrans Sandbox** | Free / Sandbox | `STRICT_FREE_AI_ONLY=true`; `MIDTRANS_IS_PRODUCTION=false` (no real charges). |

---

## 2. Vercel External Rewrite & Persistent Cookie Design

### External Rewrite (`vercel.json`)
- Current `vercel.json` intentionally contains **no placeholder Render URL** (verified by `vercel-deployment-config.test.js`), includes `Cache-Control: no-store` on `/api/(.*)`, immutable caching on `/assets/(.*)`, security headers (`X-Content-Type-Options`, `X-Frame-Options`, `Referrer-Policy`, `Permissions-Policy`), and SPA fallback `/((?!api/|assets/).*) -> /index.html`.
- **Immediately after deploying Render Free and obtaining the real `*.onrender.com` hostname**, prepend this exact rewrite rule as the **first** entry in `vercel.json` `rewrites`:
  ```json
  {
    "source": "/api/:path*",
    "destination": "https://<ACTUAL-ASSIGNED-RENDER-HOST>.onrender.com/api/:path*"
  }
  ```
- Frontend `src/utils/api.js` uses relative `/api/...` paths (`VITE_API_BASE_URL` left empty in Vercel production) so the browser communicates strictly same-origin with `https://<project>.vercel.app`.

### Persistent Login Cookie (`__Secure-runut_refresh`)
- Issued by backend (`server/src/middleware/auth.js`) with:
  - `HttpOnly`, `Secure` (`COOKIE_SECURE=true`), `SameSite=Lax` (`COOKIE_SAME_SITE=lax`), `Max-Age=2592000`, matching `Expires`, `Path=/api/auth`, **no `Domain` attribute**.
- Because Vercel External Rewrites proxy `/api/*` same-origin, the browser stores `__Secure-runut_refresh` under the Vercel hostname without relying on third-party cookies.

---

## 3. Deployment URLs & Configuration Status

- **Actual Vercel Deployment URL**: *Not yet deployed* (requires Render backend deployment first so the real `*.onrender.com` hostname can be placed in `vercel.json`, plus Vercel dashboard import/auth).
- **Actual Render Backend URL**: *Not yet deployed* (requires Render dashboard Blueprint deployment with Neon `DATABASE_URL` and Cloudflare R2 credentials).
- **Neon & R2 Configuration**: Schema Migration v6 (`document_files` with `storage_provider='r2'` and `storage_key`) and AWS SigV4 R2 client are implemented and verified locally; live credentials are configured only in Render Environment Variables (never committed to Git).

---

## 4. Verification Breakdown (5-Tier Honest Separation)

| Tier | Status | Evidence |
| --- | --- | --- |
| **1. Locally Verified** | **PASS** | `vercel-deployment-config.test.js` (3/3 pass), `cloudflare-r2-and-persistent-auth.test.js` (3/3 pass), `deployment-durability-and-cors.test.js` (3/3 pass), full backend suite (**187 total: 184 passed, 0 failed, 3 conditionally skipped** — live PG + 2 live LibreOffice binary tests), `vite build` passed in ~2.1 s, `npm audit` 0 high/critical vulns. |
| **2. CI Verified** | **Configured & Pushed** | Repository pushed to `https://github.com/Daburbf/RUNUT_WEB.git` (`main`); `.github/workflows/ci.yml` executes live PostgreSQL v6, live Ubuntu LibreOffice, Windows native tests, production smoke E2E, Semgrep, Gitleaks, and Trivy. |
| **3. Deployed** | **Not Yet Deployed** | Cloud dashboard access/tokens for Render, Neon, Cloudflare R2, and Vercel are not available in this local session. |
| **4. Remotely Verified** | **Not Yet Verified** | Pending live Render + Vercel Preview deployment. |
| **5. Not Yet Verified** | **Pending Live Preview** | Live Render `GET /api/health` + LibreOffice under 512 MB RAM, live Neon v6 migration, live R2 persistence across Render redeploy, real browser restart persistence of `__Secure-runut_refresh` on `*.vercel.app`, and 5 MB multipart upload through Vercel External Rewrite. |

---

## 5. Exact Manual Deployment Sequence (Dashboard Only — No Cloud CLIs Required)

1. **Confirm Eligibility**: Verify this deployment is strictly personal/non-commercial (`MIDTRANS_IS_PRODUCTION=false`). If commercial, use Cloudflare Pages Free instead of Vercel Hobby.
2. **Provision Neon Free PostgreSQL**: Create Free project at neon.tech -> copy pooled TLS `DATABASE_URL` (`?sslmode=require`).
3. **Provision Cloudflare R2 Free**: Create private bucket (e.g., `runut-private-docs`) + scoped Object Read/Write API token -> record `R2_ACCOUNT_ID`, `R2_ACCESS_KEY_ID`, `R2_SECRET_ACCESS_KEY`, `R2_BUCKET`.
4. **Deploy Render Free Backend**: In Render Dashboard -> **New Blueprint** -> connect `Daburbf/RUNUT_WEB` (`render.yaml`) -> enter `DATABASE_URL`, `R2_*`, `OPENROUTER_API_KEY`, `GEMINI_API_KEY`, `GROQ_API_KEY`, `ADMIN_EMAILS`, and keep `COOKIE_SAME_SITE=lax`, `COOKIE_SECURE=true`, `FILE_STORAGE_PROVIDER=r2`, `MIDTRANS_IS_PRODUCTION=false`, `STRICT_FREE_AI_ONLY=true`.
5. **Verify Render Health**: Note the real assigned hostname `https://<actual-render-host>.onrender.com` and confirm `GET https://<actual-render-host>.onrender.com/api/health` returns `200 OK` (`database.ok: true`, `schema_version: 6`, `libreoffice.available: true`).
6. **Add Real Render Host to `vercel.json`**: Insert `{ "source": "/api/:path*", "destination": "https://<actual-render-host>.onrender.com/api/:path*" }` as the first rewrite in `vercel.json`, commit, and push.
7. **Deploy Vercel Preview**: Import `Daburbf/RUNUT_WEB` in Vercel (root `.`, Vite, `npm ci`, `npm run build`, `dist`, leave `VITE_API_BASE_URL` empty). Set `FRONTEND_URL` & `CORS_ORIGINS` on Render to the Vercel Preview/Production URL.
8. **Run Preview Acceptance Tests**: Verify `__Secure-runut_refresh` in DevTools, close & reopen browser to confirm persistent login, test 5 MB PDF/DOCX upload + download + Render restart R2 durability, then promote to Production.
