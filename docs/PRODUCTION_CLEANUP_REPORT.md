# RUNUT — Production Cleanup, Demo Removal & Local-to-Production Migration Report

**Date:** 2026-11-24  
**Scope:** Full repository file audit, removal of demo/sample/placeholder behaviors, elimination of unused dependencies and legacy database columns, removal of hardcoded production localhost dependencies, production configuration hardening, and end-to-end validation.

---

## 1. Files & Code Removed
- **Removed unused backend dependency:** `pdf-parse` (and its transitive dependency — 2 packages removed via `npm --prefix server uninstall pdf-parse`; replaced by `pdfjs-dist` + `pdf-lib` with zero references in `server/src` or `server/test`).
- **Removed demo account seeding from production server startup:** Removed `seedInitialAccounts()` and unused `bcrypt`, `users`, `tokenTransactions` imports from `server/src/app.js` (previously created `test@runut.local`, `premium@runut.local`, `free@runut.local` with fake 10-token balances and logged plaintext passwords to stdout).
- **Removed frontend sample text & demo button:** Removed `SAMPLE` hardcoded essay constant and the `"Contoh Teks"` (`fa-flask`) button from `src/views/AnalyzeView.vue`.
- **Removed legacy unused database columns & methods:** Removed `users.is_premium`, `users.premium_until`, `payments.premium_days`, `analysis_results.locked`, and `users.extendPremium()` from `server/src/repositories/postgres.js` and `server/src/repositories/memory.js`, with safe `DROP COLUMN IF EXISTS` in migration `v2`.

## 2. Files Retained (Verified Active)
- **All 12 Vue components (`src/components/`), 14 views (`src/views/`), 3 stores (`src/store/`), 2 utils (`src/utils/`), and 2 public images (`public/images/logo.svg`, `public/images/yunani.png`):** Verified via reference audit — 100% actively imported and rendered.
- **All backend services (`server/src/services/`), routes (`server/src/routes/`), middleware (`server/src/middleware/`), and repositories (`server/src/repositories/`):** Verified active via static import & test graph.
- **All 21 automated test suites (`server/test/*.test.js`):** Isolated strictly inside `server/test/` and excluded from the production Docker image via `.dockerignore`.
- **Legal & operational files:** `THIRD_PARTY_NOTICES.md`, `package-lock.json`, `server/package-lock.json`, `Dockerfile`, `.dockerignore`, `render.yaml`, `vercel.json`, `.github/workflows/ci.yml`, `docs/`.

## 3. Reasons for Significant Deletions
| Item | Reason |
| :--- | :--- |
| `seedInitialAccounts()` (`server/src/app.js`) | Created hardcoded demo accounts with fake token balances and printed plaintext passwords in logs; unsafe for production. |
| `SAMPLE` & `"Contoh Teks"` button (`src/views/AnalyzeView.vue`) | User-facing demo/sample text shortcut; production workspace accepts only real user input or uploaded files. |
| `pdf-parse` (`server/package.json`) | Completely unreferenced across `server/src` and `server/test`; superseded by `pdfjs-dist` + `pdf-lib`. |
| `is_premium`, `premium_until`, `premium_days`, `locked`, `extendPremium()` | Obsolete subscription-model columns/methods replaced by the token ledger model. |

## 4. Duplicate Code Eliminated
- Consolidated inline `SCHEMA` `ALTER TABLE` statements in `server/src/repositories/postgres.js` into versioned, advisory-locked SQL migrations in `server/src/repositories/migrations.js`.
- Unified `issues.countPendingByDocument()` across `postgres.js` and `memory.js` to count only active issues of the latest analysis.

## 5. Demo & Mock Features Removed from Production
- No automatic demo/test user seeding (`SEED_ACCOUNTS` removed from runtime).
- No sample text / demo essay button in `AnalyzeView.vue`.
- No mock AI provider or fake AI fallback in production; if OpenRouter and Gemini both fail, the API returns an explicit `502`/`503`/`504` error and automatically refunds deducted tokens.
- No fake similarity percentages or fabricated sources; scope notes explicitly state the checked corpus.
- No demo payment simulator endpoint exists.

## 6. Local-Only Dependencies Removed from Production
- **CORS (`server/src/app.js` & `server/src/config.js`):** Removed hardcoded `'http://localhost:5173'` and `'http://localhost:4173'` from production CORS allowlist. Production now uses `CORS_ORIGINS` + `FRONTEND_URL` exclusively; localhost is permitted only when `NODE_ENV !== 'production'`.
- **Frontend URL default (`server/src/config.js`):** In `NODE_ENV=production`, `FRONTEND_URL` no longer defaults to `http://localhost:5173`; startup validation warns if unset.
- **Fail-fast production validation (`validateProductionConfig()`):** In `NODE_ENV=production`, startup fails immediately if `JWT_ACCESS_SECRET` or `DATABASE_URL` is missing.
- **Startup logs (`server/src/app.js`):** Replaced hardcoded `http://localhost:${config.port}` startup log with environment-neutral `API listening on port ${config.port} (env=${config.env})`.
- **Deployment blueprint (`render.yaml`):** Replaced outdated Gemini-only config with production OpenRouter (`particle-ai/particle-1:free`) + Gemini (`gemini-3.1-flash-lite`) fallback, `ADMIN_EMAILS`, `CORS_ORIGINS`, Midtrans, SMTP, and Google OAuth variables.

## 7. Production Environment Changes
- Root `.env.example` added for frontend (`VITE_API_URL`).
- `server/.env.example` updated with `CORS_ORIGINS` and PostgreSQL pool/SSL/timeout variables (`PG_POOL_MAX`, `PG_IDLE_TIMEOUT_MS`, `PG_CONNECTION_TIMEOUT_MS`, `PG_STATEMENT_TIMEOUT_MS`, `DATABASE_SSL`, `DATABASE_SSL_REJECT_UNAUTHORIZED`).
- `Dockerfile` hardened with pinned `node:20.18-alpine`, multi-stage build, non-root `USER node`, writable `/app/server/.data/uploads`, and `HEALTHCHECK`.

## 8. Dependency Changes
- **Removed:** `pdf-parse` (unused).
- **Security Patched:** `body-parser`, `multer`, `qs` (via `npm audit fix`), and `nodemailer` upgraded to `^10.6.1`.
- **Final Audit:** `0 vulnerabilities` in both frontend (`package.json`) and backend (`server/package.json`).

## 9. Database Changes
- Introduced `schema_migrations` table with PostgreSQL advisory lock (`server/src/repositories/migrations.js`).
- `v1_initial_schema` & `v2_cleanup_legacy_and_hardening`: added `CHECK` constraints, `set_updated_at()` triggers, missing unique/partial indexes, fixed `token_version` whitelist in `USER_COLUMNS`, and dropped legacy columns safely.

## 10. Production Build, Test & Security Scan Results
| Check | Result |
| :--- | :--- |
| Frontend Production Build (`npm run build`) | **PASS** (59 modules, 2.83s) |
| Backend Automated Tests (`node --test test/*.test.js`) | **134 PASS / 0 FAIL / 1 SKIPPED** (live PG test skipped without `RUNUT_TEST_DATABASE_URL`) |
| Frontend Dependency Audit (`npm audit --omit=dev`) | **0 vulnerabilities** |
| Backend Dependency Audit (`npm --prefix server audit --omit=dev`) | **0 vulnerabilities** |
| Git Secret Check | `.env` / `server/.env` are gitignored and untracked |

## 11. Remaining Operational Limitations
1. **Ephemeral Disk on Container Hosts:** `server/.data/uploads` stores immutable original DOCX/PDF files on disk. Attach a persistent volume or migrate `fileStore.js` to S3/R2 on ephemeral hosts.
2. **Staging PostgreSQL Smoke Test:** Run `RUNUT_TEST_DATABASE_URL=<staging_pg> node --test server/test/postgres.test.js` before production cutover.

## 12. Exact Production Deployment Instructions
1. Provision managed PostgreSQL + daily backups.
2. Configure all required production environment variables listed in [`docs/PRODUCTION_DEPLOYMENT_CHECKLIST.md`](./PRODUCTION_DEPLOYMENT_CHECKLIST.md) (never commit secrets).
3. Build and deploy the container:
   ```bash
   docker build -t runut:prod .
   docker run -d --name runut -p 8080:8080 --env-file /secure/runut.prod.env -v runut_uploads:/app/server/.data/uploads runut:prod
   ```
4. Terminate TLS (HTTPS) at your reverse proxy with upload limit `>= 10 MB` and timeout `>= 120s`.
5. Verify `GET https://<domain>/api/health` returns HTTP `200` with `"database": { "ok": true, "driver": "postgresql", "schema_version": 2 }`.
