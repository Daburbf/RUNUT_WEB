# RUNUT — Final Zero-Cost Deployment Report
## Simplest Zero-Card Path: Cloudflare Pages Free + Render Free + Neon Free (PostgreSQL)

> **Simplest Zero-Card Deployment Target (Academic / Demo / Limited Testing)**:
> For the fewest cloud setup steps with **zero credit card required**, deploy using **Cloudflare Pages Free** (`functions/api/[[path]].js`, `BACKEND_ORIGIN=https://<actual-service>.onrender.com`) + **Render Free Web Service** (`render.yaml`, Docker Node 24 + LibreOffice, `OBJECT_STORAGE_PROVIDER=postgres`, `MAX_CONCURRENT_CONVERSIONS=1`, `CONVERSION_MAX_RSS_MB=380`) + **Neon Free PostgreSQL** (`BYTEA` original file persistence with **700 MB** managed storage / **4 GB/mo** outbound application-side safety limits).
>
> **Preserved Optional Alternatives**: Oracle Cloud Always Free ARM64 + OCI Object Storage (`OBJECT_STORAGE_PROVIDER=oci`, `deploy/oracle-always-free/docker-compose.oci.yml`) and Cloudflare R2 (`OBJECT_STORAGE_PROVIDER=r2`) remain fully implemented and tested as optional providers.

## 1. Selected Zero-Cost Architecture (Render Free + Neon Free + Cloudflare Pages Free)

| Component | Provider | Plan | Role & Published Free Allowance |
| --- | --- | --- | --- |
| **Frontend** | **Cloudflare Pages** | Free | Static Vite `dist/` on `https://<project>.pages.dev`, unlimited static bandwidth, zero credit card required |
| **Same-Origin API Proxy** | **Cloudflare Pages Functions** (`functions/api/[[path]].js`) | Free | Proxies `/api/*` to fixed `BACKEND_ORIGIN=https://<actual-service>.onrender.com`, 100,000 requests/day free, preserves multiple `Set-Cookie` headers, strips upstream `Domain` |
| **Backend + LibreOffice** | **Render Web Service** (`render.yaml` / `Dockerfile`) | Free | Node.js 24 + LibreOffice + Noto/DejaVu fonts + OCR; **512 MB RAM**, **750 free instance hours/mo**, sleeps after 15 min idle (~1 min cold start), ephemeral local disk, guarded by `MAX_CONCURRENT_CONVERSIONS=1` & `CONVERSION_MAX_RSS_MB=380` |
| **Database + Document Storage** | **Neon PostgreSQL** (`OBJECT_STORAGE_PROVIDER=postgres`) | Free | **1 GB storage per project**, **100 CU-hours per project/mo**, **5 GB public network transfer per project/mo**, TLS, Migration v8; stores metadata + immutable `BYTEA` originals with **700 MB** storage & **4 GB/mo** outbound application-side safety limits |
| **AI & Payments** | **OpenRouter (`:free`) -> Gemini Free -> Groq Free** + **Midtrans Sandbox** | Free / Sandbox | `STRICT_FREE_AI_ONLY=true`; `MIDTRANS_IS_PRODUCTION=false` |

### Optional Higher-Capacity Alternative (Oracle Cloud Always Free + OCI Object Storage)
| Component | Provider | Plan | Role & Published Free Allowance |
| --- | --- | --- | --- |
| **Backend + LibreOffice** | **Oracle Cloud A1** (`VM.Standard.A1.Flex`, Ubuntu ARM64) | Always Free | **2 OCPUs total, 12 GB memory total** (`1,500 OCPU-hours/mo`, `9,000 GB-hours/mo`), `200 GB` Always Free block volume; runs `Dockerfile` (`cpus: 1.5`, `mem_limit: 9g`) |
| **HTTPS & Hostname** | **Caddy** + **DuckDNS** | Open Source / Free | Automatic Let's Encrypt TLS in front of RUNUT (`deploy/oracle-always-free/docker-compose.oci.yml`, `Caddyfile`) |
| **Optional Object Storage** | **Oracle Object Storage** (`server/src/services/ociObjectStorage.js`) | Always Free | **Free Trial**: 10 GB Standard / 10 GB Infrequent Access / 10 GB Archive; **Always Free-only (post-trial)**: 20 GB combined; **50,000 API requests/mo**, **10 TB outbound/mo**; private Standard bucket, AWS SigV4 with real OCI region (`OBJECT_STORAGE_PROVIDER=oci`, zero auto-failover to R2) |

---

## 2. Oracle Object Storage vs Cloudflare R2 Comparison

| Dimension | Oracle Object Storage (Always Free — Primary) | Cloudflare R2 (Free — Optional Alternative) |
| --- | --- | --- |
| **Storage Allowance & App Cap** | Free Trial: 10 GB Standard (default app safety cap: **8 GB**); Always Free-only post-trial: 20 GB combined (max app safety cap: **16 GB** ONLY after explicit `OCI_OS_ALWAYS_FREE_VERIFIED=true` + explicit `OCI_MAX_MANAGED_BYTES`; never increases automatically) | 10 GB-month Standard (App safety limit: **8 GB**) |
| **Monthly API Requests** | **50,000 total requests/mo** (App safety limit: **40,000/mo**) | 1,000,000 Class A + 10,000,000 Class B/mo (App safety limit: 800k A / 8M B) |
| **Outbound Transfer** | 10 TB/mo (App safety limit: **8 TB/mo**) | Unlimited ($0 egress) |
| **Billing Risk on Free Account** | **Lower overage risk on Always Free-only OCI account** (no PAYG upgrade -> cannot silently bill overages, requests fail at quota) | **Higher overage risk** (requires payment method on file; no provider-side hard billing cap — overages beyond free tier are billed) |
| **Best Fit** | Academic demos, personal portfolios, low-to-moderate traffic betas where strict $0 billing safety is top priority | Higher request-volume workloads (>40,000 object ops/mo) where R2's 1M/10M request headroom is needed |

**Verdict**: OCI Object Storage Always Free is a **better fit for strict zero-billing-exposure goals** at academic/personal/small-beta traffic levels because an Always Free-only OCI account does not silently bill overages, and its conservative **8 GB default cap** (safely under the 10 GB Free Trial Standard tier, raisable manually up to **16 GB** only after explicit Always Free-only verification) protects against accidental tier overruns. However, **50,000 monthly API requests** (40,000 application-side safety limit) is the primary bottleneck — heavy multi-user downloads or multipart uploads can exhaust 40,000 requests faster than R2. Cloudflare R2 (`server/src/services/r2Storage.js`) is preserved as an explicit opt-in alternative (`OBJECT_STORAGE_PROVIDER=r2`) with **zero automatic failover**.

---

## 3. OCI S3 Compatibility, Persistent Quota Accounting (Migration v8) & Security

- **Endpoint**: `https://<namespace>.compat.objectstorage.<region>.oci.customer-oci.com` (real OCI region required; R2's `'auto'` region is explicitly rejected).
- **Operations Supported & Metered Individually**: `PutObject`, `GetObject`, `HeadObject`, `DeleteObject`, `ListObjects`, `InitiateMultipartUpload`, `UploadPart`, `CompleteMultipartUpload`, `AbortMultipartUpload`. Every multipart step counts as an individual API request. No unsupported S3 ACL headers are sent.
- **Persistent Accounting (Migration v8)**: `object_storage_monthly_usage` + `object_storage_quota_reservations` in Neon PostgreSQL (`SELECT ... FOR UPDATE`, unique `idempotency_key`, automatic abandoned reservation expiry, fail-closed `503 QUOTA_SERVICE_UNAVAILABLE` on DB failure). Migration v7 (`r2_monthly_usage`, `r2_quota_reservations`) remains intact so existing R2 records stay readable when R2 is configured.
- **Strict Signed URL Policy**: `STRICT_STORAGE_QUOTA_MODE=true` blocks reusable direct download URLs (`403 SIGNED_URL_DISABLED_IN_STRICT_QUOTA_MODE`). Every download authenticates the user, verifies ownership, reserves 1 API request + outbound bytes, streams via the backend, and commits actual streamed bytes.
- **Persistent Login Cookie**: `__Secure-runut_refresh` (`HttpOnly; Secure; SameSite=Lax; Max-Age=2592000; Expires; Path=/api/auth`, no `Domain`) stored host-only on `*.pages.dev` via `functions/api/[[path]].js`.

---

## 4. Verification Status (6-Tier Honest Separation)

| Tier | Status | Evidence |
| --- | --- | --- |
| **1. Locally Verified** | **PASS** | Full backend suite: **198 total — 194 passed, 0 failed, 4 conditionally skipped** (`postgres.test.js` live PG, `windows-document-processing.test.js` live `DOC->DOCX` & `DOCX->PDF`, `oci-object-storage.test.js` opt-in live OCI); `oci-object-storage.test.js` (4 passed, 1 opt-in skipped); `r2-quota-audit.test.js` (5/5 passed); `vite build` passed in 2.40 s. |
| **2. CI Verified** | **Configured (Pending Push)** | `.github/workflows/ci.yml` verifies live PostgreSQL v8 (`schema_version >= 8`), live Ubuntu LibreOffice, Windows native tests, production smoke E2E, Semgrep, Gitleaks, Trivy, and `oci-object-storage.test.js`. |
| **3. OCI Integration Verified** | **Not Yet Run (Opt-In)** | Live OCI test (`OCI 5`) is gated by `RUNUT_OCI_OBJECT_STORAGE_TEST=true` and requires real OCI test bucket credentials. |
| **4. Deployed** | **Not Yet Deployed** | Cloud dashboard provisioning on Neon, OCI, DuckDNS, and Cloudflare Pages has not been executed from this local machine. No public URL is fabricated. |
| **5. Remotely Verified** | **Not Yet Verified** | Pending live OCI ARM64 + Cloudflare Pages deployment. |
| **6. Not Yet Verified** | **Pending Live Deploy** | Live OCI ARM64 LibreOffice/OCR execution, live OCI Object Storage Standard bucket verification, live Neon v8 migration, DuckDNS + Caddy Let's Encrypt HTTPS, and real browser restart cookie test on `https://<project>.pages.dev`. |

---

## 5. Exact Manual Deployment Steps

1. Commit and push to `https://github.com/Daburbf/RUNUT_WEB.git` (`main`) and verify all GitHub Actions jobs pass.
2. **Neon Free**: Create Free PostgreSQL project -> copy pooled TLS `DATABASE_URL` (`?sslmode=require`).
3. **OCI Always Free**: Create Always Free-only account (do NOT upgrade to PAYG) -> create Ubuntu ARM64 `VM.Standard.A1.Flex` (<= 2 OCPUs / <= 12 GB RAM) in home region -> open ingress TCP 80 & 443 in VCN Security List.
4. **OCI Object Storage**: Create private Standard-tier bucket -> create Customer Secret Key + least-privilege IAM policy -> record `OCI_OS_NAMESPACE`, `OCI_OS_REGION`, `OCI_OS_BUCKET`, `OCI_OS_ACCESS_KEY_ID`, `OCI_OS_SECRET_ACCESS_KEY`.
5. **DuckDNS + Caddy**: Register free `<name>.duckdns.org` pointing to OCI VM public IP -> set `BACKEND_DOMAIN=<name>.duckdns.org` and `server/.env` (`OBJECT_STORAGE_PROVIDER=oci`, `STRICT_STORAGE_QUOTA_MODE=true`, `COOKIE_SAME_SITE=lax`, `COOKIE_SECURE=true`, `MIDTRANS_IS_PRODUCTION=false`, `STRICT_FREE_AI_ONLY=true`) -> run `docker compose -f deploy/oracle-always-free/docker-compose.oci.yml up -d`.
6. **Verify Backend**: Confirm `GET https://<name>.duckdns.org/api/health` returns `200 OK` (`schema_version: 8`, `libreoffice.available: true`).
7. **Cloudflare Pages**: Connect `Daburbf/RUNUT_WEB` (`npm ci`, `npm run build`, `dist`, `functions`), set server-side `BACKEND_ORIGIN=https://<name>.duckdns.org`, leave `VITE_API_BASE_URL` empty, update backend `FRONTEND_URL` & `CORS_ORIGINS` to `https://<project>.pages.dev`.
8. **Live Verification**: Test `__Secure-runut_refresh` across a full browser restart, test PDF/DOCX upload/conversion/download, restart backend container to verify OCI persistence & SHA-256, and optionally run `RUNUT_OCI_OBJECT_STORAGE_TEST=true node --test server/test/oci-object-storage.test.js` against a disposable test bucket.
