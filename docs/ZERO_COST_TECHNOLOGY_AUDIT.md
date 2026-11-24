# RUNUT — Zero-Cost Technology Stack & Free-Only Service Audit

**Audit Date:** 2026-11-24  
**Policy:** Strict $0 / Open-Source First. Zero paid AI APIs, zero commercial PDF/OCR/plagiarism SDKs, zero automatic paid fallback or billing activation.

---

## 1. AI Providers (100% Free-Only 3-Tier Fallback Chain)

Enforced in code via `STRICT_FREE_AI_ONLY=true` in `server/src/services/aiProvider.js` (blocks non-`:free` OpenRouter models with `AI_PAID_MODEL_BLOCKED` and blocks paid providers like `openai` with `AI_PAID_PROVIDER_BLOCKED`).

| Priority | Provider | Model | Free Tier Status | Typical Free Limits | API Key Required | Privacy / Data Policy Caveat | Official Docs |
| :---: | :--- | :--- | :---: | :--- | :---: | :--- | :--- |
| **1 (Primary)** | **OpenRouter (Free Tier)** | `particle-ai/particle-1:free` (or any `:free` model) | **$0** | ~50 req/day (up to 1,000 req/day on eligible free accounts), ~20 RPM | `OPENROUTER_API_KEY` | Free endpoints may log prompts depending on upstream provider settings; avoid sending regulated confidential data without opt-out. | https://openrouter.ai/pricing |
| **2 (Fallback #1)** | **Google Gemini API (Free Tier)** | `gemini-3.1-flash-lite` / `gemini-2.5-flash` | **$0** | Free RPM/RPD & TPM quotas per Google AI Studio free tier | `GEMINI_API_KEY` | Google Free Tier may use prompts to improve products; do not treat free tier as zero-retention enterprise SLA. | https://ai.google.dev/pricing |
| **3 (Fallback #2)** | **Groq (Free Developer Tier)** | `llama-3.3-70b-versatile` | **$0** | Free RPM/RPD & TPM developer tier limits (no credit card required) | `GROQ_API_KEY` | Subject to Groq developer terms; monitor daily token caps. | https://groq.com/pricing |

**Quota Exhaustion Behavior:** When all 3 free providers are rate-limited or exhausted, RUNUT returns `503 AI_FREE_QUOTA_EXHAUSTED`, never activates a paid endpoint, never fabricates AI output, and automatically refunds 100% of deducted user analysis tokens.

---

## 2. Free External Academic & Citation APIs

| Service | Purpose | Cost | Rate / Access Rules | Official Docs |
| :--- | :--- | :---: | :--- | :--- |
| **Crossref** | DOI & bibliographic metadata | **$0** | Polite pool via `User-Agent: Runut/1.0 (mailto:...)` | https://api.crossref.org |
| **OpenAlex** | Open-access discovery & abstracts | **$0** | Public free tier (100k req/day polite pool) | https://docs.openalex.org |
| **Unpaywall** | Legal OA vs paywalled status | **$0** | Free with email param (`UNPAYWALL_EMAIL`), up to 100k/day | https://unpaywall.org/products/api |
| **Semantic Scholar** | Paper metadata & OA PDF links | **$0** | Free public Graph API (rate-limited) | https://api.semanticscholar.org |
| **DOAJ** | Open-access journal metadata | **$0** | Public free API | https://doaj.org/api/docs |
| **PubMed Central** | Open-access PMC ID conversion | **$0** | Free NCBI public utility | https://pmc.ncbi.nlm.nih.gov/tools/id-converter-api/ |

---

## 3. Free & Open-Source Document Processing & OCR Libraries

| Component | Package / Tool | License | Cost | Role |
| :--- | :--- | :---: | :---: | :--- |
| **DOCX Editing & Creation** | `jszip`, `@xmldom/xmldom`, `docx`, `mammoth` | MIT / BSD-2-Clause | **$0** | OOXML in-place editing, DOCX report export, fallback extraction |
| **PDF Inspection & Editing** | `pdf-lib`, `pdfjs-dist`, `@napi-rs/canvas` | MIT / Apache-2.0 | **$0** | PDF text/font/bbox inspection, in-place replacement, visual comparison |
| **OCR (Scanned PDFs)** | `tesseract.js` (Tesseract OCR) | Apache-2.0 | **$0** | Local/server OCR (`ind+eng`) without paid cloud OCR |
| **DOCX-to-PDF Conversion** | **LibreOffice Headless** (`soffice`) | MPL-2.0 | **$0** | High-fidelity DOCX-to-PDF template conversion (installed in Docker) |

---

## 4. Database, Storage, Email, Auth & Hosting (Free Options)

| Layer | Technology | Cost / Free-Tier Options | Limits & Honest Caveats |
| :--- | :--- | :--- | :--- |
| **Database** | **PostgreSQL** (`pg`, MIT) | **$0** (Self-hosted, Neon Free, Supabase Free, Render Free) | Managed free tiers have storage caps (e.g. 0.5 GB–1 GB) and Render Free DB expires after 30–90 days; use Neon/Supabase Free or self-hosted PostgreSQL for long-term persistence. |
| **File Storage** | Local persistent disk (`fileStore.js`) | **$0** (Self-hosted / VPS) | Ephemeral free container hosts (Render Free) wipe disk on restart; free alternative: **Cloudflare R2 Free Tier (10 GB/mo, $0 egress)** or **Supabase Storage Free (1 GB)**. |
| **Email (OTP / Reset)** | `nodemailer` (MIT-0) + **Gmail SMTP App Password** or **Brevo Free** | **$0** | Gmail free ~500 emails/day; Brevo free 300 emails/day. |
| **Authentication** | Google Identity Services (OAuth2 JWKS) + `jsonwebtoken` + `bcryptjs` | **$0** | Google Sign-In is 100% free; all JWT/password libs are MIT. |
| **Frontend Hosting** | **Vercel Free / Cloudflare Pages Free** or single-container Docker | **$0** | Free static/SPA hosting with HTTPS included. |
| **Payments (Business Logic)** | **Midtrans** (Sandbox $0; Live merchant fee per successful transaction) | **$0 fixed / $0 subscription** | Midtrans has no monthly subscription fee, but live merchant transactions incur standard payment-gateway MDR per paid transaction (separate from infrastructure cost). |

---

## 5. Verification Summary
- Automated test suite [`server/test/zero-cost-ai-policy.test.js`](../server/test/zero-cost-ai-policy.test.js) verified:
  1. Paid OpenRouter models (without `:free`) are blocked (`AI_PAID_MODEL_BLOCKED`).
  2. Paid providers (`openai`) are blocked (`AI_PAID_PROVIDER_BLOCKED`).
  3. 3-tier free fallback (`OpenRouter :free` → `Gemini Free` → `Groq Free`) activates seamlessly.
  4. Full free-quota exhaustion returns `503 AI_FREE_QUOTA_EXHAUSTED` with automatic user token refund and zero paid fallback.
