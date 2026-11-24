# RUNUT — Application Security Audit & Remediation Report

## 1. Audit Scope & Standards

- **Target**: RUNUT full-stack application (`src/` Vue 3 frontend, `server/` Node.js/Express API, PostgreSQL repositories, document processing pipeline, AI provider integration, Midtrans QRIS payment integration, CI/CD & Docker configuration).
- **Standards Referenced** (targeted baseline equivalent to ASVS Level 2; no formal third-party certification claimed):
  - OWASP Application Security Verification Standard (ASVS) 5.0.0
  - OWASP Top 10:2025
  - OWASP API Security Top 10:2023
  - OWASP Web Security Testing Guide (WSTG)
  - NIST Secure Software Development Framework (SSDF, SP 800-218)
  - OWASP Secrets Management & Input Validation Cheat Sheets

---

## 2. RUNUT Threat Model

### Protected Assets
- User accounts, bcrypt password hashes, JWT signing secrets, rotating refresh tokens (`runut_rt` HttpOnly cookie).
- Uploaded private documents (`.pdf`, `.docx`, `.doc`, `.txt`), immutable original templates (`document_files`), AI analysis results, rewritten documents, similarity & citation reports.
- Token balances, atomic ledger records (`token_transactions`, `download_transactions`), Midtrans QRIS payment orders & webhook secrets.
- AI provider API keys (OpenRouter, Gemini, Groq), SMTP credentials, database credentials, administrative quota endpoints.

### Threat Actors & Primary Attack Surfaces
| Entry Point | Trust Boundary | Key Attack Scenarios | Mitigations |
| --- | --- | --- | --- |
| `/api/auth/*` | Public Internet -> Auth API | Credential stuffing, account enumeration, refresh token replay, JWT alg/issuer forgery | Rate limiting, timing-equalized bcrypt compare, refresh reuse revocation (`token_version` bump), HS256+iss+aud JWT pinning |
| `/api/analysis` (multipart upload) | Untrusted User File -> Document Parsers & LibreOffice | ZIP bomb, Zip Slip, XXE, VBA macros, external template SSRF, PDF `/JavaScript` & `/Launch`, page-count DoS | Magic-byte validation, compression-ratio & entry-count guards, macro & external-rels blocking, recursive PDF action scan, `MAX_PDF_PAGES=200`, `spawn(..., { shell: false })`, isolated profiles |
| `sourceFetcher.js` | Document URLs -> Outbound Network | SSRF to localhost/RFC1918/IPv6/cloud metadata, DNS rebinding, redirect to private IP | Protocol/port allowlist, private IPv4/IPv6/mapped-v6 blocklist, per-hop DNS & redirect validation, 6 s timeout, 2 MB streaming cap |
| `aiProvider.js` & `aiValidate.js` | Untrusted Document/Web Text -> LLM -> App | Prompt injection overriding instructions, malformed JSON, XSS payloads, unauthorized fields | Strict `<<<...>>>` data boundary, strict category/offset/substring schema validation, numerical/name mutation manual-review flag, Vue auto-escaping (zero `v-html`) |
| `/api/documents/*` & `/api/payments/*` | Authenticated User -> DB & Files | BOLA/IDOR cross-user access, mass assignment, race conditions on tokens, webhook forgery, QR URL SSRF | Server-side `ownDocument` / `ownedPayment` checks, `user_id`-scoped `document_files`, column whitelists, DB atomic transactions, constant-time SHA-512 signature + amount + currency checks, Midtrans QR domain allowlist |

---

## 3. Vulnerabilities Discovered, Fixed & Retested

| ID | Severity | Component | Vulnerability & Root Cause | Fix Implemented | Retest Status |
| --- | --- | --- | --- | --- | --- |
| **VULN-01** | **High** | `server/src/routes/auth.js` | **Missing Refresh Token Reuse Detection**: Replaying a previously rotated refresh token returned `401` without revoking the user's active sessions or access tokens. | On replay of any revoked refresh token, revokes all user refresh tokens (`revokeAllForUser`), increments `token_version` (invalidating active access tokens), logs `auth_refresh_token_reuse_detected`, and returns `401 REFRESH_REUSE_DETECTED`. | **FIXED & VERIFIED** (`Security Regression 1`) |
| **VULN-02** | **High** | `server/src/middleware/auth.js` | **Unpinned JWT Verification**: `jwt.sign` / `jwt.verify` did not pin `algorithms: ['HS256']` or validate `issuer` / `audience`. | Pinned `HS256`, `issuer: 'runut-api'`, and `audience: 'runut-web'` on both sign and verify. | **FIXED & VERIFIED** (`Security Regression 2`) |
| **VULN-03** | **High** | `server/src/services/payments.js` | **Payment QR Image Fetch SSRF / Credential Leak**: `fetchQrImage` sent Midtrans `Basic` auth (`serverKey`) to `row.instructions.qr_url` without domain allowlisting or redirect blocking. | Added `isAllowedMidtransQrUrl()` allowing only HTTPS `*.midtrans.com` / `*.veritrans.co.id` (or configured `MIDTRANS_API_BASE` origin), disabled redirects (`redirect: 'error'`), and added 8 s timeout. | **FIXED & VERIFIED** (`Security Regression 6`) |
| **VULN-04** | **Medium** | `server/src/services/pdfEditor.js`, `routes/analysis.js` | **PDF Active Content & Page-Count DoS**: Parser did not reject PDFs with `/JavaScript` / `/Launch` actions (including nested direct `/OpenAction` dicts) or excessive page counts. | Added recursive `scanPdfSecurityRisks()` (depth-guarded) rejecting `/JavaScript`, `/JS`, and `/Launch`, plus `MAX_PDF_PAGES` (`200`), returning HTTP `400 UNSAFE_PDF_DOCUMENT`. | **FIXED & VERIFIED** (`Security Regression 5`) |
| **VULN-05** | **Medium** | `server/src/services/docxEditor.js`, `routes/analysis.js` | **DOCX Macro, Compression Ratio & External Relationship Gaps**: Archive validator did not block VBA macros (`vbaProject.bin`), extreme compression ratios (>100:1), or external `attachedTemplate`/`oleObject` relationships. | Hardened `validateDocxArchive` and added `validateDocxRelationships` rejecting VBA macros, >100:1 ZIP bombs, and external template/OLE injection with HTTP `400 UNSAFE_DOCX_ARCHIVE`. | **FIXED & VERIFIED** (`Security Regression 4`) |
| **VULN-06** | **Medium** | `server/src/services/payments.js`, `server/src/app.js` | **Webhook Currency Check & Endpoint Rate-Limiting Gaps**: Midtrans webhook did not validate `currency === 'IDR'`, and `/api/payments/notify` & `/api/admin/ai-usage` lacked dedicated rate limiters. | Enforced `IDR` currency validation (`409 CURRENCY_MISMATCH`), added security logging on signature/amount/currency failures, and added `webhookLimiter` & `adminLimiter`. | **FIXED & VERIFIED** (`Security Regression 6`, full suite) |
| **VULN-07** | **Medium** | `server/src/routes/auth.js`, `server/src/services/securityLog.js` | **Login Timing Enumeration & Missing Security Event Monitoring**: Non-existent email login skipped bcrypt comparison; no centralized redacting security logger or failed-login threshold monitor. | Equalized login timing with dummy bcrypt comparison, bumped production bcrypt cost to 12, and added `securityLog.js` with strict secret/document redaction and failed-login alerting. | **FIXED & VERIFIED** (`Security Regression 8`) |
| **VULN-08** | **Medium** | `.github/workflows/ci.yml` | **Missing Automated SAST, Secret & Container Security Gates**: CI lacked Semgrep SAST, Gitleaks history scanning, Trivy vuln/misconfig scanning, and dedicated security regression job. | Added `security-sast-semgrep`, `security-secrets-gitleaks`, `security-trivy-scan`, and `security-regression-tests` jobs to CI. | **FIXED & CONFIGURED** |

---

## 4. ASVS 5.0.0 Traceability Matrix

| ASVS Domain | Affected Component | Implemented Protection | Automated Test Case | Actual Result | Remaining Risk |
| --- | --- | --- | --- | --- | --- |
| V2 Authentication | `routes/auth.js` | bcrypt (cost 12 prod), OTP TTL/attempts, timing equalization, failed-login alerting | `auth-google-otp.test.js`, `security-audit-regression.test.js` | **PASS** | Consider Argon2id migration & Admin MFA in future milestone |
| V3 Session Mgmt | `middleware/auth.js`, `routes/auth.js` | HS256+iss+aud JWT, HttpOnly+SameSite+Secure refresh cookie, rotation + reuse revocation | `security-audit-regression.test.js` (#1, #2) | **PASS** | Split-origin deployments require careful `SameSite`/`CORS` config |
| V4 Access Control | `routes/documents.js`, `routes/payments.js`, `app.js` | Server-side `ownDocument`/`ownedPayment`, `user_id`-scoped `document_files`, fail-closed admin | `security-audit-regression.test.js` (#3), `security-and-acceptance.test.js` | **PASS** | Low (all user-owned routes verified) |
| V5 Input & Files | `docxEditor.js`, `pdfEditor.js`, `analysis.js` | Magic bytes, ZIP bomb/ratio, Zip Slip, XXE, VBA macro, external rels, PDF JS/Launch/pages | `security-audit-regression.test.js` (#4, #5), `security-and-acceptance.test.js` | **PASS** | LibreOffice OS sandboxing depends on host/container isolation |
| V10 SSRF / External | `sourceFetcher.js`, `payments.js` | IPv4/IPv6/mapped-v6 blocklist, per-hop DNS/redirect checks, Midtrans QR allowlist | `security-audit-regression.test.js` (#6, #7), `security-and-acceptance.test.js` | **PASS** | Standard Node `fetch` does not pin resolved socket IP directly (DNS rebinding window minimized via per-hop check) |
| V14 Config & Secrets | `app.js`, `config.js`, `securityLog.js`, `ci.yml` | Helmet CSP/HSTS/nosniff/no-store, log redaction, Gitleaks/Semgrep/Trivy CI | `security-audit-regression.test.js` (#8), `npm audit`, secret scan | **PASS** | DAST (OWASP ZAP) must be run against live staging URL once deployed |

---

## 5. Remaining Open Risks (Honestly Documented)

1. **Password Hashing Algorithm**: Currently uses `bcryptjs` (cost 12 in production). Migrating to `Argon2id` with transparent on-login rehash is recommended for a future release (avoided native C++ build friction on Windows during this audit).
2. **Admin MFA**: `/api/admin/ai-usage` is fail-closed and rate-limited, but does not yet enforce TOTP/WebAuthn MFA for administrator accounts.
3. **DNS Rebinding Socket Pinning**: `sourceFetcher.js` validates DNS records immediately before each hop and blocks redirects to private IPs, but Node's built-in `fetch` resolves DNS independently at connect time; a custom `undici` dispatcher binding directly to the validated IP is recommended for high-security deployments.
4. **Live DAST (OWASP ZAP)**: Active/passive DAST requires a running staging URL and has not yet been executed against a live hosted environment.
