# RUNUT — Known Limitations & Honest Operational Constraints

This document transparently lists current technical, environmental, and zero-cost infrastructure limitations so users and operators can plan realistically.

---

## 1. Local Windows Development Machine (Current Environment)
- **LibreOffice Not Installed Locally**: Live LibreOffice binary tests (`DOC -> DOCX` and `DOCX -> PDF` via `soffice.com`) are skipped on this Windows workstation because LibreOffice is not installed locally. Installing LibreOffice via `winget install --id TheDocumentFoundation.LibreOffice -e` enables them immediately without code changes.
- **PostgreSQL Not Running Locally**: Live PostgreSQL v5 tests are skipped locally when `RUNUT_TEST_DATABASE_URL` is unset. Both PostgreSQL and LibreOffice live tests are enforced with zero skips allowed (`RUNUT_REQUIRE_INTEGRATION_TESTS=true`) in GitHub Actions CI (`.github/workflows/ci.yml`).
- **PowerShell Execution Policy**: On Windows systems where PowerShell blocks `npm.ps1`, use `npm.cmd` or `node --test` directly.

## 2. Public Deployment Status
- **Not Yet Deployed to a Live Public URL**: Hosting account credentials and deployment authorization were not provided in this session. All production configuration (`Dockerfile`, `render.yaml`, `vercel.json`, `ci.yml`, PostgreSQL v5 persistent file storage, security headers) is complete and verified locally, but no public URL is claimed live until deployed and externally verified.

## 3. Zero-Cost Free-Tier Infrastructure Constraints
- **Render Free Web Service**:
  - Spins down after ~15 minutes of inactivity (30–60 second cold start on first request).
  - Limited to 512 MB RAM and shared CPU; heavy concurrent LibreOffice conversions or multi-page Tesseract OCR jobs may hit memory/timeout limits under sustained load.
- **Free PostgreSQL Storage (~500 MB on Neon/Supabase Free)**:
  - Storing uploaded original DOCX/PDF binaries in PostgreSQL `document_files` solves ephemeral container disk loss at $0 cost, but total stored files are bounded by the free database storage quota (mitigated by 5 MB upload limit and 30-day automatic retention cleanup).
  - Note: Render's own Free PostgreSQL tier expires after 30 days; use Neon Free or Supabase Free for persistent zero-cost hosting.
- **Free AI Provider Quotas**:
  - `STRICT_FREE_AI_ONLY=true` prevents unexpected billing, but OpenRouter `:free`, Gemini Free Tier, and Groq Free Tier enforce upstream RPM/RPD rate limits. When all three free tiers are exhausted simultaneously, RUNUT returns an explicit `AI_FREE_QUOTA_EXHAUSTED` error rather than faking results.
- **Payment Gateway Transaction Fees**:
  - While RUNUT uses zero paid software licenses, Midtrans live QRIS transactions incur standard per-transaction MDR fees regulated by Bank Indonesia/Midtrans when live payments are enabled.

## 4. Document Processing & Format Boundaries
- **Complex Scanned / Photographic PDFs**: OCR extracts text for review and reporting, but RUNUT intentionally refuses to overwrite complex photographic backgrounds in-place and returns the original PDF untouched.
- **Subset Fonts Without ToUnicode CMap**: In-place PDF text replacement is rejected to prevent garbled glyphs; users are guided to upload the source DOCX.
- **Optional PDF-to-DOCX Fidelity**: `writer_pdf_import` cannot guarantee 100% identical formatting on intricate multi-column/magazine PDFs; RUNUT gates and rejects conversions that show significant structural or visual divergence.
- **Cross-Platform Font Parity**: Identical line wrapping between Windows and Linux/Docker LibreOffice exports requires matching installed fonts (e.g., Noto, DejaVu, Liberation).

## 5. Similarity & AI-Pattern Analysis Scope
- **External Similarity**: Checks only user-uploaded references, accessible public URLs in the document, and open academic metadata/OA APIs (OpenAlex/Crossref/Semantic Scholar). It does **not** claim parity with proprietary paid databases such as Turnitin or iThenticate.
- **AI-Style Writing Indicators**: Deterministic stylistic pattern metrics (repetition, uniform sentence structure, formulaic phrases) are **not** definitive proof of AI authorship and are explicitly labeled as writing-quality indicators.
