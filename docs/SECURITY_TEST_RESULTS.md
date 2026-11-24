# RUNUT — Security Test Results

Executed directly on Windows (`win32`, Node.js, isolated test storage — zero production credentials, zero real payments, zero third-party targets).

---

## 1. Summary of Executed Security & Functional Tests

| Category | Tool / Suite | Result | Details |
| --- | --- | --- | --- |
| **Security Audit Regression Suite** | `node --test server/test/security-audit-regression.test.js` | **8 passed, 0 failed, 0 skipped** | Refresh reuse detection, JWT alg/iss/aud pinning, BOLA/IDOR, DOCX macros & external rels, PDF `/JavaScript` & page limit, Payment QR SSRF, SSRF URL validator, AI schema rejection, security log redaction |
| **Security & Acceptance Suite** | `server/test/security-and-acceptance.test.js` | **Passed (included in full suite)** | Admin fail-closed, SSRF private/metadata/redirect blocks, magic bytes/ZIP traversal/XXE, prompt injection boundary, constant-time Midtrans signature |
| **Token & Payment Integrity** | `download-token-safety.test.js`, `qris-dynamic-payment.test.js` | **Passed (included in full suite)** | Atomic reservations, cancel/commit, concurrent deductions, 10-min QRIS expiry, idempotent renew, late settlement reconciliation |
| **Full Backend Test Suite** | `node --test test/*.test.js` (in `server/`) | **178 total: 175 passed, 0 failed, 3 skipped** (9.45 s) | All security, auth, document preservation, AI fallback, and QA tests passed |
| **Frontend Static XSS Audit** | Pattern scan (`v-html`, `innerHTML`, `eval`, `localStorage`) | **Clean** | Zero `v-html`, `innerHTML`, `eval`, or `localStorage` token storage found in `src/` |
| **Secret Scan** | `git ls-files` + `git grep` API key patterns | **Clean** | 0 tracked `.env` files, 0 hardcoded OpenRouter/Gemini/Groq/Midtrans keys |
| **Dependency Vulnerability Scan** | `npm.cmd audit --omit=dev --audit-level=high` (root + `server/`) | **0 vulnerabilities** | Clean on both frontend and backend production dependencies |
| **Frontend Production Build** | `npm.cmd run build` | **Passed** | `vite build` succeeded in 2.02 s |

---

## 2. CI/CD Security Tools Status

| Tool | Layer | Status | Notes |
| --- | --- | --- | --- |
| **Semgrep** (`p/javascript`, `p/nodejs`, `p/owasp-top-ten`) | SAST | Configured in `.github/workflows/ci.yml` (`security-sast-semgrep`) | Runs automatically on push/PR in GitHub Actions |
| **Gitleaks** (`fetch-depth: 0`) | Secret Scanning | Configured in `.github/workflows/ci.yml` (`security-secrets-gitleaks`) | Scans full Git commit history on push/PR |
| **Trivy** (`vuln,misconfig,secret`, `CRITICAL,HIGH`) | Dependency + IaC + Secret | Configured in `.github/workflows/ci.yml` (`security-trivy-scan`) | Fails build on any HIGH or CRITICAL finding |
| **OWASP ZAP** | DAST | Pending staging URL | Recommended passive scan first against isolated staging deployment before active scan |

---

## 3. Skipped Tests & Exact Reasons

The 3 skipped tests in the local Windows run are strictly external-binary/database integration tests (never security bypasses):

1. `server/test/postgres.test.js` — live PostgreSQL v5 test (skipped locally because `RUNUT_TEST_DATABASE_URL` is unset; **enforced fail-closed** via `RUNUT_REQUIRE_INTEGRATION_TESTS=true` in CI job `postgres-integration-tests`).
2. `server/test/windows-document-processing.test.js` (`2b`) — live LibreOffice `DOC -> DOCX` conversion (skipped locally because LibreOffice is not installed on this Windows machine; **enforced fail-closed** via `RUNUT_REQUIRE_INTEGRATION_TESTS=true` in CI job `libreoffice-conversion-tests`).
3. `server/test/windows-document-processing.test.js` (`3b`) — live LibreOffice `DOCX -> PDF` conversion (skipped locally because LibreOffice is not installed; **enforced fail-closed** in CI job `libreoffice-conversion-tests`).
