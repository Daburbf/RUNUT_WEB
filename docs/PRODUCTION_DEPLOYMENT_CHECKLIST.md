# RUNUT — Production Deployment & Verification Checklist

## 1. Pre-Deployment Release Gate
- [ ] All GitHub Actions jobs in `.github/workflows/ci.yml` pass:
  - `frontend-build`
  - `backend-unit-tests`
  - `postgres-integration-tests` (`RUNUT_REQUIRE_INTEGRATION_TESTS=true`, live `postgres:16-alpine`)
  - `libreoffice-conversion-tests` (`RUNUT_REQUIRE_INTEGRATION_TESTS=true`, live Ubuntu `libreoffice-writer`)
  - `windows-native-tests` (`windows-latest`, no Docker)
  - `production-smoke-e2e` (live production Express server + PostgreSQL + built `dist/`)
  - `docker-build`
- [ ] `npm audit --omit=dev --audit-level=high` returns 0 high/critical vulnerabilities on both root and `server/`.
- [ ] No `.env`, `.env.local`, or `server/.env` files are tracked in Git.
- [ ] Pre-deployment PostgreSQL backup snapshot taken.

## 2. Hosting & Domain Configuration (Strictly Zero-Cost Architecture)
- [ ] **Eligibility Gate (if using Vercel Hobby)**: Confirm deployment is strictly **personal/non-commercial** with `MIDTRANS_IS_PRODUCTION=false`. If selling tokens commercially, use **Cloudflare Pages Free** (`functions/api/[[path]].js`) instead of Vercel Hobby.
- [ ] **Frontend + Same-Origin API Proxy**:
  - **Option A — Vercel Hobby (Non-Commercial)**: Deploy Vite `dist/` via `vercel.json`, leave `VITE_API_BASE_URL` empty, and prepend `{ "source": "/api/:path*", "destination": "https://<ACTUAL-RENDER-HOST>.onrender.com/api/:path*" }` in `vercel.json` **only after** Render assigns the real hostname (never deploy a placeholder URL).
  - **Option B — Cloudflare Pages Free (Commercial-Permitted)**: Deploy Vite `dist/` + `functions/api/[[path]].js` on `https://<project>.pages.dev`, leave `VITE_API_BASE_URL` empty, and set server-side `BACKEND_ORIGIN=https://<ACTUAL-RENDER-HOST>.onrender.com`.
- [ ] **Backend API + LibreOffice**: Deploy `Dockerfile` via **Render Free Web Service** (`render.yaml`) with `COOKIE_SAME_SITE=lax`, `COOKIE_SECURE=true`, `FRONTEND_URL=https://<actual-frontend-domain>`, `CORS_ORIGINS=https://<actual-frontend-domain>`.
- [ ] **Database**: Provision a **non-expiring** managed PostgreSQL database on **Neon Free** (1 GB storage/project, 100 CU-hours/project/mo, 5 GB public network transfer/project/mo, up to 20 GB combined; `DATABASE_URL` with TLS, `DATABASE_SSL=true`, `PG_CONNECTION_TIMEOUT_MS=10000`, Migration v8). Do NOT use expiring 30-day Render Free PostgreSQL.
- [ ] **Persistent Document Storage (Primary: OCI Object Storage Always Free; Optional: Cloudflare R2)**:
  - Primary (`OBJECT_STORAGE_PROVIDER=oci`, `STRICT_STORAGE_QUOTA_MODE=true`): Create private Standard-tier OCI bucket + Customer Secret Key (`OCI_OS_NAMESPACE`, `OCI_OS_REGION`, `OCI_OS_BUCKET`, `OCI_OS_ACCESS_KEY_ID`, `OCI_OS_SECRET_ACCESS_KEY`). Application-side safety limits: **8 GB default** (safe during 10 GB Standard Free Trial; raisable up to **16 GB max** only after explicit `OCI_OS_ALWAYS_FREE_VERIFIED=true` + explicit `OCI_MAX_MANAGED_BYTES` on an Always Free-only account) / **40,000 API reqs/mo** / **8 TB outbound/mo** (zero auto-failover to R2).
  - Optional (`OBJECT_STORAGE_PROVIDER=r2`): Private R2 bucket + billing alerts (application-side safety limits: 8 GB / 800k Class A / 8M Class B). Never rely on ephemeral local disk for permanent user documents.
- [ ] **Midtrans Mode**: Keep `MIDTRANS_IS_PRODUCTION=false` (sandbox) until live production credentials and authorization are explicitly approved.
- [ ] **HTTPS**: Automatic TLS 1.2+ on frontend and Render backend.

## 3. Required Production Environment Variables
- [ ] `NODE_ENV=production`
- [ ] `PORT=8080`
- [ ] `FRONTEND_URL=https://<your-public-domain>` (must NOT be `localhost`)
- [ ] `CORS_ORIGINS=https://<your-public-domain>` (if additional origins needed)
- [ ] `DATABASE_URL=postgresql://...` (managed PostgreSQL with SSL)
- [ ] `DATABASE_SSL=true` (auto-enabled for non-localhost hosts in production)
- [ ] `JWT_ACCESS_SECRET=<random 64-hex string>` (`node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"`)
- [ ] `ADMIN_EMAILS=<comma-separated admin emails>` (fail-closed if empty)
- [ ] `STRICT_FREE_AI_ONLY=true`
- [ ] `AI_PROVIDER=openrouter`
- [ ] `OPENROUTER_API_KEY=<key>` + `OPENROUTER_MODEL=particle-ai/particle-1:free`
- [ ] `GEMINI_API_KEY=<key>` + `GEMINI_MODEL=gemini-3.1-flash-lite` (fallback #1)
- [ ] `GROQ_API_KEY=<key>` + `GROQ_MODEL=llama-3.3-70b-versatile` (fallback #2)
- [ ] `DOCX_PDF_CONVERSION_ENABLED=true`
- [ ] `DOCX_PDF_TIMEOUT_MS=120000`
- [ ] `GOOGLE_CLIENT_ID=<OAuth2 Web Client ID>` (add public HTTPS origin to Google Cloud Console Authorized JavaScript Origins)
- [ ] `MIDTRANS_SERVER_KEY`, `MIDTRANS_CLIENT_KEY`, `MIDTRANS_IS_PRODUCTION=true` (configure Midtrans Notification URL to `https://<public-domain>/api/payments/notify`)
- [ ] `MAIL_HOST`, `MAIL_PORT`, `MAIL_SECURE`, `MAIL_USER`, `MAIL_PASS`, `MAIL_FROM` (for OTP & password reset)

## 4. Persistent Document Storage
- [ ] Verify PostgreSQL Migration v5 (`document_files`) applied cleanly (`schema_version >= 5` in `GET /api/health`).
- [ ] Uploaded original DOCX/PDF files are persisted in PostgreSQL `document_files` (`BYTEA`, max 10 MB, `ON DELETE CASCADE`, per-user `user_id` isolation), surviving container restarts on ephemeral free-tier hosts.
- [ ] Retention job (`retention.js`) purges expired documents (30-day default), cascading to `document_files`.

## 5. Post-Deployment Verification (Public URL)
- [ ] `GET https://<public-domain>/api/health` returns `200 OK` with:
  - `"ok": true`
  - `"database": { "ok": true, "driver": "postgresql", "schema_version": 5 }`
  - `"document_processing": { "docker_required": false, "libreoffice": { "available": true } }`
- [ ] Security headers present on `/api/health`: `Strict-Transport-Security`, `X-Content-Type-Options: nosniff`, `Referrer-Policy`, `Permissions-Policy`, `Cache-Control: no-store`.
- [ ] End-to-end public smoke test: Register -> Login -> Upload `.docx` -> Analyze -> Apply revision -> Restart container (or wait) -> Download `.docx` and `.pdf` -> Verify template preserved and zero RUNUT watermark.
- [ ] Verify `/api/admin/ai-usage` returns `403` for normal users and `200` for `ADMIN_EMAILS`.

## 6. Backup & Rollback Procedures
- **Backups**: Enable automated daily backups / point-in-time recovery on your managed PostgreSQL provider (Neon/Supabase) and test restore in a staging branch monthly.
- **Rollback**:
  1. Roll back the Render/container deployment to the previous verified release image/commit.
  2. If a schema migration introduced an issue, restore the pre-deployment PostgreSQL snapshot into staging, verify integrity, then promote.
  3. Re-verify `GET /api/health`, authentication, and document download endpoints.
