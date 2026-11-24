# RUNUT — Security Incident Response Plan

## 1. Detection & Triage
Monitor structured JSON logs (`category: "security"`) and platform alerts for:
- `auth_refresh_token_reuse_detected` (session hijack / token replay)
- `auth_suspicious_failed_logins` (brute-force / credential stuffing)
- `payment_webhook_invalid_signature`, `payment_webhook_amount_mismatch`, `payment_webhook_currency_mismatch`
- `payment_qr_ssrf_blocked` or repeated `403` authorization failures / `UNSAFE_DOCX_ARCHIVE` / `UNSAFE_PDF_DOCUMENT` spikes
- Unexpected AI quota depletion via `/api/admin/ai-usage`

Assign severity: **P1 Critical** (active data/key/payment compromise), **P2 High** (isolated account compromise or exploit attempt), **P3 Medium** (abuse/rate-limit spike).

---

## 2. Playbooks by Incident Type

### A. Suspected User Account Compromise
1. **Contain**: Increment the affected user's `token_version` in PostgreSQL (`UPDATE users SET token_version = token_version + 1 WHERE id = $1`) and revoke all refresh tokens (`UPDATE refresh_tokens SET revoked_at = now() WHERE user_id = $1 AND revoked_at IS NULL`).
2. **Investigate**: Review `token_transactions`, `download_transactions`, and `documents` timestamps for unauthorized actions.
3. **Recover**: Force password reset via verified email OTP and notify the affected user.

### B. Exposed API Key or Secret (OpenRouter, Gemini, Groq, Midtrans, JWT, SMTP, DB)
1. **Revoke Immediately**: Revoke the exposed key in the upstream provider dashboard (removing from Git does NOT invalidate a leaked key).
2. **Rotate**: Generate a new credential and update hosting environment variables.
   - If `JWT_ACCESS_SECRET` was exposed: rotating it immediately invalidates all active access tokens; also revoke active `refresh_tokens` rows.
   - If `DATABASE_URL` password was exposed: rotate DB user password and review PostgreSQL audit/connection logs.
3. **Verify**: Confirm the old key is rejected and `GET /api/health` is healthy with the new credential.
4. **Git Hygiene**: If committed to Git, purge from history carefully and run Gitleaks to confirm clean state.

### C. Unauthorized Document Access / Data Leakage
1. **Contain**: Revoke suspect sessions, temporarily disable affected export/download route or deploy hotfix if an authorization bug is identified.
2. **Assess Scope**: Identify affected `document_id` and `user_id` records from access logs and `download_transactions`.
3. **Remediate & Notify**: Patch authorization check, add regression test, verify fix, and notify affected users transparently.

### D. Payment Manipulation / Forged Webhooks
1. **Contain**: Verify `MIDTRANS_SERVER_KEY` integrity; inspect `payments` rows where `reconciliation_flag IS NOT NULL` or status transitioned unexpectedly.
2. **Reconcile**: Cross-check `payments.order_id` and `amount` against the official Midtrans merchant dashboard; reverse fraudulent token credits if any occurred.
3. **Harden**: Rotate Midtrans Server Key if compromised and tighten `RATE_LIMIT_WEBHOOK_MAX`.

### E. Database Exposure or Corruption
1. **Contain**: Rotate DB credentials, restrict inbound IP/network rules, and enforce `DATABASE_SSL=true`.
2. **Recover**: Restore the latest clean pre-incident PostgreSQL backup snapshot into a staging instance, verify schema/data integrity (`schema_version >= 5`), then promote/restore per recovery plan.

---

## 3. Post-Incident Review
Within 72 hours of resolution:
1. Document root cause, timeline, and blast radius (never include raw secrets, passwords, or private user documents).
2. Add an automated security regression test in `server/test/security-audit-regression.test.js` preventing recurrence.
3. Update `docs/SECURITY_HARDENING_CHECKLIST.md` and CI gates as needed.
