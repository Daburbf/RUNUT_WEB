# RUNUT — Real-World User Acceptance Test (UAT) Report

This report documents real end-to-end user acceptance workflows executed via automated integration harnesses (`server/test/real-world-qa-acceptance.test.js`, `server/test/windows-document-processing.test.js`, `server/test/security-and-acceptance.test.js`, and `server/test/template-preservation-complete.test.js`) against the actual Express API, repositories, document editors, and validation engines.

---

## 1. Automatic Multi-Domain Writing-Context Detection (Indonesian & English)

Verified without manual mode selection (`writing_mode_requested: 'auto'`):

| Fixture | Language Detected | Profile Selected | Tone / Audience / Purpose Inferred | Result |
| --- | --- | --- | --- | --- |
| Indonesian Academic Thesis (Abstrak, BAB I, Daftar Pustaka) | `id` | `academic` | Yes | **PASS** |
| English Academic Research Paper (Abstract, Methodology, References) | `en` | `academic` | Yes | **PASS** |
| English Professional Client Email | `en` | Non-academic (workplace) | Yes | **PASS** |
| Indonesian Employee Quarterly Report / Business Proposal | `id` | Non-academic (business/workplace) | Yes | **PASS** |
| English Technical SOP / Deployment Runbook | `en` | Non-academic (technical) | Yes | **PASS** |
| English Marketing Campaign Copy | `en` | Non-academic (marketing) | Yes | **PASS** |

**Key Outcome**: Workplace, technical, and marketing documents are never forced into academic writing style.

---

## 2. Meaning Preservation & Honest Analysis Scoring

| Scenario | Expected Behavior | Actual Result |
| --- | --- | --- |
| AI suggestion mutates numeric value (`42%` -> `90%`) | Flagged `needs_manual_review: true`; never auto-applied | **PASS** |
| AI returns invalid category or mismatched character range | Rejected by `validateAiIssues`; never produces misaligned highlights | **PASS** |
| Repeated sentence with no external references provided | `corpus_compared: 'internal_only'`, `corpus_similarity_percent: null`, finding marked `internal_repetition` | **PASS** |
| Analysis Report PDF & DOCX export | Clean multi-page report with 6 highlight categories, non-authorship disclaimer, zero RUNUT watermark | **PASS** |

---

## 3. Original Template Preservation Workflows (Upload → Analyze → Revise → Validate → Download)

| Representative Document | Workflow Executed | Verification Checks | Result |
| --- | --- | --- | --- |
| **Complex DOCX Report** (Heading styles, table, embedded PNG image, header, footer, bibliography) | Upload -> Analyze -> Accept revision -> Wipe memory cache (restart simulation) -> Download `.docx` | `X-Preservation-Mode: template-preserved`, `X-Preservation-Verified: true`, tables/images/headers/footers/bibliography 100% preserved, original SHA-256 immutable, zero RUNUT watermark | **PASS** |
| **Multi-Page Academic PDF** (2 pages, headers, footers, page numbers, body text) | Upload -> Analyze -> Accept revision -> Download `.pdf` | `X-Preservation-Mode: pdf-inplace-preserved`, 2 pages preserved, visual comparison `layout_preserved: true`, original SHA-256 immutable | **PASS** |
| **Fillable AcroForm PDF** | Inspect -> Strategy `B` (`fillable_acroform_edit`) -> Fill field | Native AcroForm field updated without altering page design | **PASS** |
| **Placeholder PDF** (`{{NAMA_PESERTA}}`) | Inspect -> Strategy `C` (`placeholder_region_edit`) -> Replace placeholder | Targeted placeholder replaced accurately; short page not misclassified as scanned | **PASS** |
| **Scanned Image-Only PDF** | Inspect -> Strategy `E` (`ocr_extract_only_preserve_original`) -> Attempt edit | Unsafe replacement rejected; original PDF returned byte-for-byte unchanged (SHA-256 identical); never reconstructed from plain text | **PASS** |
| **Optional PDF-to-DOCX Workflow (Divergent Conversion)** | Convert -> Inspect -> Compare structure | Rejected with `LAYOUT_DIVERGENCE_REJECTED`; differences reported; original PDF preserved | **PASS** |
| **Optional PDF-to-DOCX Workflow (Reliable Roundtrip)** | Convert -> Inspect -> Edit DOCX -> Export PDF -> Visual compare | Accepted (`PDF_TO_DOCX_ROUNDTRIP_VERIFIED`) with disclaimer; original PDF immutable | **PASS** |
| **Legacy `.doc` File** | OLE2 magic validation + LibreOffice conversion path | Invalid signature rejected; valid OLE2 hook validated; live LibreOffice conversion configured in Ubuntu CI (`libreoffice-conversion-tests`) | **PASS (unit) / CI-provisioned (live)** |

---

## 4. Security, Isolation & Multi-User Concurrency UAT

| Scenario | Actual Result |
| --- | --- |
| User 2 attempts `GET /api/documents/:id` of User 1 | `403 Forbidden` (**PASS**) |
| User 2 attempts `GET /api/documents/:id/download?format=docx` of User 1 | `403 Forbidden` (**PASS**) |
| User 2 attempts `GET /api/documents/:id/analysis-report?format=pdf` of User 1 | `403 Forbidden` (**PASS**) |
| Concurrent download reservations + cancellations | Both reservations created cleanly; cancellations released tokens with zero balance loss (**PASS**) |
| Download format guard (PDF upload requested as `.docx`) | Rejected `422 FORMAT_MISMATCH_USE_PDF` (never silently reconstructed) (**PASS**) |
| Missing original template guard | Rejected `409 ORIGINAL_TEMPLATE_MISSING` (never silently falls back to plain text) (**PASS**) |
