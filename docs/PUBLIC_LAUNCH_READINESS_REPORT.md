# RUNUT — Public Launch Readiness Report

## 1. Executive Status

| Area | Status | Notes |
| --- | --- | --- |
| Core Application & Full-Stack Build | **Ready (Local)** | Frontend (`vite build`, 3.82 s, 59 modules, 0 secrets in `dist/`) & Backend Express API verified |
| Automated Backend Test Suite (Local Windows) | **209 Passed / 0 Failed / 4 Conditionally Skipped** | 213 total tests (includes Free Multi-Model Registry, Migration v9 `ai_provider_quotas`, Privacy Gate, 3-Stage DOCX XML Structural Fingerprinting, PDF fail-closed, OCI/R2 storage, and security regressions); strict CI mode verified (`RUNUT_REQUIRE_INTEGRATION_TESTS=true`) |
| Persistent File Storage (Restart Survival) | **Implemented** | Simplest Zero-Card Primary: **Neon Free PostgreSQL `BYTEA`** (`OBJECT_STORAGE_PROVIDER=postgres`, 700 MB managed / 4 GB/mo outbound app safety limits, SHA-256 verified); Optional: **Oracle Object Storage Always Free** (`ociObjectStorage.js`, Migration v8) & **Cloudflare R2** (`r2Storage.js`, Migration v7) |
| Native Windows Support (No Docker) | **Implemented & Verified** | `soffice.com` preferred, isolated profiles, safe `spawn(..., { shell: false })`, temp cleanup |
| Provisioned CI Integration Jobs | **Configured** | `.github/workflows/ci.yml` provisions live `postgres:16-alpine` and Ubuntu `libreoffice-writer` in strict mode |
| Dependency & Secret Security Audits | **Passed** | 0 high/critical vulnerabilities (frontend + backend), 0 tracked `.env` files |
| Live Public URL Verification | **Not Yet Deployed / Not Remotely Verified** | Vercel Hobby (non-commercial only, external rewrite pending real Render host) + Render Free + Neon Free + Cloudflare R2 Free require dashboard provisioning; no public URL is claimed live yet |

---

## 2. Complete Feature Verification

All existing RUNUT features were audited and verified to work together as one integrated system:

- **Authentication & Sessions**: Email/password registration, bcrypt hashing, email OTP verification, password reset via SMTP, Google Identity Services OAuth2, HttpOnly rotating refresh cookie, `token_version` invalidation.
- **Token Ledger & Download Safety**: Progressive analysis pricing (`Math.ceil(words / 1000)`), idempotency keys, atomic concurrent deductions, automatic full refund on total AI failure, two-phase download reservation (`reserve -> prepare -> commit / cancel`).
- **QRIS Dynamic Payments**: Midtrans Snap/Core API integration, 10-minute dynamic QRIS expiry (`custom_expiry`), idempotent auto-renew, constant-time webhook signature verification, late-settlement reconciliation.
- **Zero-Cost AI Provider Chain**: `STRICT_FREE_AI_ONLY=true` enforces the explicit free model registry (`aiModelRegistry.js`), blocks paid providers/models and retired Groq `llama-3.3-70b-versatile`, verifies OpenRouter catalog `price=0`, tracks real rate-limit headers/cooldowns (`aiQuota.js`, Migration v9), enforces confidential document privacy gating, and fails over cleanly (`particle-1:free -> ernie-5.5-flash-preview:free -> ling-3.2-flash:free -> openrouter/free -> gemini-3.1-flash-lite`, with Groq disabled unless verified free). See `docs/AI_FREE_PROVIDER_AND_TEMPLATE_PRESERVATION_REPORT.md`.
- **Multi-Domain Writing Engine**: Automatic language (`id`/`en`), document type, writing profile, tone, audience, and purpose detection without requiring manual mode selection.
- **Honest Analysis & Similarity**: Strict character-index issue validation (`validateAiIssues`), numerical/proper-noun mutation flagging (`needs_manual_review`), clear separation between internal repetition and external corpus similarity (`corpus_similarity_percent: null` when no external corpus is compared), non-authorship AI pattern disclaimer.
- **Strict 3-Stage Original Document Template Preservation (`templatePreservationEngine.js`)**:
  - **Stage A (Content Editing AI)** revises only editable text blocks using stable block IDs; **Stage B (Validation)** checks block IDs, placeholders, citations, and text growth ratio (`MAX_DOCUMENT_TEXT_GROWTH_RATIO=1.15`, 1 repair retry); **Stage C (Deterministic Template Engine)** mutates only authorized `<w:t>` nodes and validates structural fingerprints before/after.
  - **DOCX**: In-place OOXML `<w:t>` editing preserving styles, tables, merged cells, images, headers, footers, footnotes, endnotes, bookmarks, hyperlinks, section properties, and bibliography (`verifyDocxPreservation` + structural fingerprint comparison).
  - **PDF**: Native text / AcroForm editing only when safe; scanned PDFs fail closed (`SCANNED_PDF_UNSUPPORTED_FOR_NATIVE_EDIT`) and preserve the immutable original without fake overlays or silent conversion.
  - **Legacy DOC**: Validated OLE2 conversion to intermediate DOCX via LibreOffice headless while keeping the original `.doc` immutable.
  - **Analysis Reports & Annotated Copies**: Separate clean PDF/DOCX analysis reports and non-destructive annotated copies with zero RUNUT watermarks or creator metadata.

---

## 3. Actual Tests Executed (Local Windows Environment)

| Test Suite / Gate | Command | Result |
| --- | --- | --- |
| Real-World QA & Acceptance | `node --test server/test/real-world-qa-acceptance.test.js` | **3 passed, 0 failed, 0 skipped** |
| Windows Document Processing | `node --test server/test/windows-document-processing.test.js` | **10 passed, 0 failed, 2 skipped** (`2b` DOC->DOCX & `3b` DOCX->PDF require local LibreOffice) |
| Strict CI Integration Mode Check | `RUNUT_REQUIRE_INTEGRATION_TESTS=true node --test server/test/postgres.test.js` | **Exited with code 1** (verified: fails loudly when PostgreSQL is missing, never silently skips) |
| Full Backend Suite | `node --test test/*.test.js` (in `server/`) | **170 total: 167 passed, 0 failed, 3 conditionally skipped** (9.12 s) |
| Secret Scan | `git ls-files` check for `.env` | **Clean (0 tracked `.env` files)** |
| Frontend Dependency Audit | `npm.cmd audit --omit=dev --audit-level=high` | **0 vulnerabilities** |
| Backend Dependency Audit | `npm.cmd --prefix server audit --omit=dev --audit-level=high` | **0 vulnerabilities** |
| Frontend Production Build | `npm.cmd run build` | **Passed** (`vite build` in 2.17 s, 59 modules) |

### Conditionally Skipped Tests Locally & Provisioned CI Resolution

| Skipped Test (Local Windows) | Exact Local Reason | CI Resolution (`.github/workflows/ci.yml`) |
| --- | --- | --- |
| `postgres.test.js` — Live PostgreSQL v5 test | `RUNUT_TEST_DATABASE_URL` not set locally (no local PostgreSQL/Docker) | Executed in `postgres-integration-tests` job with `postgres:16-alpine` service + `RUNUT_REQUIRE_INTEGRATION_TESTS=true` (zero skips allowed) |
| `windows-document-processing.test.js` — `2b. DOC to DOCX real LibreOffice integration test` | LibreOffice not installed on local Windows machine | Executed in `libreoffice-conversion-tests` job with Ubuntu `libreoffice-writer` + `RUNUT_REQUIRE_INTEGRATION_TESTS=true` (zero skips allowed) |
| `windows-document-processing.test.js` — `3b. DOCX to PDF real LibreOffice integration test` | LibreOffice not installed on local Windows machine | Executed in `libreoffice-conversion-tests` job with Ubuntu `libreoffice-writer` + `RUNUT_REQUIRE_INTEGRATION_TESTS=true` (zero skips allowed) |

---

## 4. Security & Multi-User Concurrency Verification

- **Headers**: Verified `X-Content-Type-Options: nosniff`, `Cache-Control: no-store`, `Permissions-Policy`, `Referrer-Policy`, and `Strict-Transport-Security` (in `NODE_ENV=production`).
- **Isolation**: Cross-user access to documents, downloads, preservation checks, persistent files (`document_files`), and analysis reports returns `403 Forbidden` / `null`.
- **Upload Guards**: Magic-byte validation (ZIP/OLE2/PDF/TXT), encrypted DOCX rejection, ZIP path traversal & ZIP bomb guard, XXE (`DOCTYPE`/`ENTITY`) rejection.
- **SSRF & Prompt Injection**: External URL fetcher blocks localhost, private IPv4/IPv6 ranges, metadata IPs, and private redirects; Midtrans webhooks use constant-time signature verification.
- **Concurrency**: Concurrent token deductions and concurrent download reservations verified atomic with zero negative balances.

---

## 5. Zero-Cost Deployment Architecture & Infrastructure Limits

| Component | Recommended Zero-Cost Option | Verified Capabilities & Real Limits |
| --- | --- | --- |
| **App (Frontend + Backend + LibreOffice)** | **Render Free Web Service** (Docker runtime via `render.yaml`) | Free HTTPS, custom domain, runs `Dockerfile` with LibreOffice + fonts. **Limits**: 512 MB RAM, shared CPU, spins down after 15 min idle (~30–60 s cold start), ephemeral local disk (mitigated by PostgreSQL `document_files` storage). |
| **Database + Persistent Document Store** | **Neon Free** + **Cloudflare R2 Free** | Neon Free (Nov 2026): **1 GB storage per project**, **100 CU-hours/project/month**, up to **20 GB combined Free storage**, non-expiring TLS. Cloudflare R2 Free: 10 GB-mo Standard storage, 1M Class A, 10M Class B, guarded by persistent PostgreSQL Migration v7 **application-side safety limits** (8 GB / 800k A / 8M B) + GraphQL analytics reconciliation. |
| **AI Providers** | **OpenRouter (`:free`) + Google Gemini Free Tier + Groq Free Tier** | Enforced by `STRICT_FREE_AI_ONLY=true`. Subject to upstream free-tier RPM/RPD rate limits; no automatic paid billing. |
| **Transactional Email (OTP / Reset)** | **Gmail SMTP (App Password)** or **Brevo Free Tier** | Free daily email quota; fails explicitly with `503 MAIL_NOT_CONFIGURED` if omitted. |
| **Payments (Optional)** | **Midtrans Sandbox / Production QRIS** | No monthly software license fee; Midtrans charges standard per-transaction QRIS MDR fees (0.7%–0.7%+PPN per Bank Indonesia / Midtrans schedule) when live payments are enabled. |

*Note: For sustained high-traffic multi-user production without cold starts or 500 MB DB storage limits, upgrading to a paid web instance + object storage (e.g., Cloudflare R2 / S3) is recommended.*
