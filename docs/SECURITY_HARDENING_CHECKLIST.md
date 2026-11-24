# RUNUT — Production Security Hardening Checklist

## 1. Authentication & Session Controls
- [x] Password hashing via `bcryptjs` (cost 12 in `NODE_ENV=production`, configurable via `BCRYPT_ROUNDS`).
- [x] Timing-equalized login comparison to mitigate account enumeration.
- [x] JWT access tokens pinned to `HS256` with `issuer: 'runut-api'` and `audience: 'runut-web'`.
- [x] Refresh tokens stored only in `HttpOnly`, `SameSite=Lax`, `Secure` (prod) cookies scoped to `/api/auth`; hashed with SHA-256 in DB.
- [x] Refresh token rotation with **reuse detection** (revokes all user sessions and increments `token_version` on replay).
- [x] Password reset invalidates all refresh tokens and increments `token_version`.
- [ ] Configure strong `JWT_ACCESS_SECRET` (>= 32 random bytes) and `OTP_SECRET` in production environment.

## 2. Authorization & API Security
- [x] Server-side ownership checks (`ownDocument`, `ownedPayment`) on every document, export, report, and payment route.
- [x] Column whitelists (`USER_COLUMNS`, `DOCUMENT_COLUMNS`) prevent mass assignment of `token_balance`, `id`, or privileges.
- [x] `/api/admin/ai-usage` is fail-closed when `ADMIN_EMAILS` is empty and restricted by `adminLimiter`.
- [x] Dedicated rate limiters active on auth, analysis, exports, payments, webhooks (`/api/payments/notify`), and admin routes.

## 3. Document Upload & Processing Isolation
- [x] Magic-byte validation for DOCX (ZIP), DOC (OLE2), PDF (`%PDF-`), and TXT (binary null-byte rejection).
- [x] DOCX archive guards: max 500 entries, max 25 MB uncompressed, max 100:1 compression ratio, Zip Slip block, XXE (`DOCTYPE`/`ENTITY`) block, VBA macro (`vbaProject.bin`) block, external `attachedTemplate`/`oleObject` relationship block.
- [x] PDF parser guards: recursive scan rejecting `/JavaScript`, `/JS`, and `/Launch` actions; `MAX_PDF_PAGES=200` limit.
- [x] LibreOffice runs via `spawn(..., { shell: false })` with isolated `-env:UserInstallation` profiles, unique temp dirs, timeouts, process-tree termination, and `finally` cleanup.
- [x] Non-root container user (`USER node`) in `Dockerfile`.

## 4. Network, SSRF & AI Security
- [x] `sourceFetcher.js` enforces HTTP/HTTPS + ports 80/443, blocks localhost/private IPv4/IPv6/mapped-v6/metadata IPs, validates DNS and redirects per hop, 6 s timeout, 2 MB streaming limit.
- [x] `fetchQrImage` enforces HTTPS Midtrans domain allowlist (`*.midtrans.com` / `*.veritrans.co.id`) with `redirect: 'error'` and 8 s timeout.
- [x] `STRICT_FREE_AI_ONLY=true` blocks paid providers/models; AI outputs undergo strict JSON/category/offset/substring validation (`validateAiIssues`).
- [x] Zero `v-html` / `innerHTML` sinks in Vue frontend; Helmet CSP, HSTS, `X-Content-Type-Options: nosniff`, `Referrer-Policy`, `Permissions-Policy`, and `Cache-Control: no-store` on `/api`.

## 5. Database, Storage & Monitoring
- [x] 100% parameterized PostgreSQL queries (`$1`, `$2`, ...); SSL enforced for non-localhost production hosts.
- [x] Persistent original uploads stored in PostgreSQL `document_files` with `user_id` isolation and `ON DELETE CASCADE` (not publicly accessible).
- [x] Centralized security logger (`securityLog.js`) redacts passwords, tokens, keys, and document contents; alerts on repeated failed logins.
- [ ] Enable automated daily PostgreSQL backups and test restoration in staging.
- [ ] Configure log aggregation alerts for `category: "security"` events with `severity: "high"` or `"critical"`.
