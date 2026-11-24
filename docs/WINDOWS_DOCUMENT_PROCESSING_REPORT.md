# RUNUT — Windows Native Document Processing Report (No Docker Required)

## 1. Executive Summary

RUNUT now supports native Windows document processing and conversion directly without requiring Docker, Podman, or WSL during local development. Docker remains supported as an optional production deployment environment via `Dockerfile` and `docker-compose.yml`.

All document conversion and template-preservation operations are unified behind a centralized cross-platform abstraction (`server/src/services/documentProcessor.js`) and safe headless LibreOffice runner (`server/src/services/libreOffice.js`).

---

## 2. Windows Executable Discovery

Executable discovery is implemented in `server/src/services/libreOffice.js` (`getCandidateLibreOfficePaths` and `detectLibreOffice`).

### Discovery Priority on Windows (`win32`)

1. Explicit environment override: `LIBREOFFICE_PATH` (or legacy `LIBREOFFICE_BIN`).
2. Standard 64-bit Windows installation (console binary preferred for reliable stdout/stderr capture):
   - `C:\Program Files\LibreOffice\program\soffice.com`
   - `C:\Program Files\LibreOffice\program\soffice.exe`
3. Standard 32-bit Windows installation:
   - `C:\Program Files (x86)\LibreOffice\program\soffice.com`
   - `C:\Program Files (x86)\LibreOffice\program\soffice.exe`
4. PATH-based discovery: `soffice.com`, `soffice.exe`, `soffice`, `libreoffice`.

### Discovery Priority on Linux / Docker

1. Explicit `LIBREOFFICE_PATH` / `LIBREOFFICE_BIN`.
2. Standard Linux paths: `/usr/bin/soffice`, `/usr/bin/libreoffice`, `/usr/local/bin/soffice`, `/usr/local/bin/libreoffice`, `/snap/bin/libreoffice`.
3. PATH-based discovery: `soffice`, `libreoffice`.

### Safe Execution Controls

- Uses `child_process.spawn(..., { shell: false, windowsHide: true })` to prevent shell command injection.
- Runs headless with isolated per-job LibreOffice profiles (`-env:UserInstallation=file:///...`) inside unique `os.tmpdir()` directories (`mkdtempSync`).
- Enforces configurable execution timeouts (`DOCX_PDF_TIMEOUT_MS`, default `120000 ms`) with process-tree termination (`taskkill /PID <pid> /T /F` on Windows; `SIGTERM`/`SIGKILL` on POSIX).
- Captures bounded `stdout` and `stderr` diagnostics.
- Always validates output file existence and structural integrity (never treats exit code `0` alone as success).
- Cleans up temporary directories in `finally` blocks with Windows retry handling (`maxRetries: 3`).

---

## 3. Local LibreOffice Installation Status

Verified on this local Windows development machine:

| Check | Result |
| --- | --- |
| `C:\Program Files\LibreOffice\program\soffice.com` | Not found (`False`) |
| `C:\Program Files\LibreOffice\program\soffice.exe` | Not found (`False`) |
| `C:\Program Files (x86)\LibreOffice\program\soffice.com` | Not found (`False`) |
| `C:\Program Files (x86)\LibreOffice\program\soffice.exe` | Not found (`False`) |
| `soffice` / `soffice.com` / `soffice.exe` in `PATH` | Not found |
| Docker / Podman / WSL | Not installed (not required) |

### How to Enable Local LibreOffice Conversions on Windows (Without Docker)

1. Install LibreOffice directly on Windows:
   ```powershell
   winget install --id TheDocumentFoundation.LibreOffice -e
   ```
   Or download the official Windows `.msi` installer from <https://www.libreoffice.org/download/download-libreoffice/>.
2. Optionally configure `server/.env`:
   ```env
   LIBREOFFICE_PATH=C:\Program Files\LibreOffice\program\soffice.com
   DOCX_PDF_CONVERSION_ENABLED=true
   ```
3. Verify via `GET /api/health` under `document_processing.libreoffice`.

When LibreOffice is not installed, RUNUT still starts normally on Windows without Docker, supports DOCX native editing, PDF extraction, PDF native editing, AcroForm filling, placeholder editing, OCR, and document downloads, and returns explicit installation instructions (`install_guidance`) whenever a LibreOffice-dependent conversion is requested.

---

## 4. DOC Conversion Results

- Implemented in `convertDocBufferToDocx` (`server/src/services/docxToPdf.js`), delegated through `runLibreOfficeConversion`.
- Validates legacy OLE2 magic bytes (`D0 CF 11 E0`) before attempting conversion.
- Keeps the original `.doc` buffer immutable (operates on isolated temp copy).
- Validates the resulting `.docx` ZIP/OOXML structure (`word/document.xml`) before returning success.
- **Local Windows verification**: OLE2 signature rejection, immutability, OOXML validation, and unavailable-converter guidance passed in automated tests. Live LibreOffice binary conversion on this machine was not executed because LibreOffice is not installed locally; Linux CI (`libreoffice-conversion-tests` in `.github/workflows/ci.yml`) is configured to run live LibreOffice conversion tests on Ubuntu.

---

## 5. DOCX-to-PDF Results

- Implemented in `convertDocxBufferToPdf` (`server/src/services/docxToPdf.js`).
- Validates input DOCX structure (`word/document.xml`) and output PDF structure (`%PDF-` header, `pdf-lib` parseability, positive page count, and positive page dimensions).
- Explicitly rejects cases where LibreOffice exits with code `0` without producing a valid PDF file.
- Preserves original DOCX files immutably and introduces zero RUNUT watermarks.
- **Local Windows verification**:
  - Unit/contract tests (corrupt input rejection, exit-code-0 missing output rejection, isolated profile & headless args verification, stderr capture, timeout handling, output PDF validation, temp cleanup): **PASSED**.
  - Live LibreOffice integration test (`3b. DOCX to PDF real LibreOffice integration test`): **SKIPPED** with explicit reason: `LibreOffice is not installed on this win32 environment (LIBREOFFICE_PATH=C:\Program Files\LibreOffice\program\soffice.com)`.

---

## 6. PDF-Native Editing & Template Preservation Results

Implemented automatic PDF strategy selection (`selectPdfEditingStrategy` in `server/src/services/pdfEditor.js` and `processPdfWithStrategy` in `server/src/services/documentProcessor.js`):

| Strategy | Trigger | Behavior | Local Test Result |
| --- | --- | --- | --- |
| **A. Editable PDF** (`native_pdf_text_edit`) | Standard text layer with extractable fonts | Native in-place PDF text editing + visual layout comparison | **PASSED** (100% page count match, layout preserved) |
| **B. Fillable PDF** (`fillable_acroform_edit`) | Active AcroForm text fields | Native AcroForm field update without altering page design | **PASSED** |
| **C. Placeholder-based PDF** (`placeholder_region_edit`) | Designated `{{PLACEHOLDER}}` regions | Targeted replacement on placeholder regions (exempt from short-page scanned false positives) | **PASSED** |
| **D. Suitable Fixed-Layout PDF** (`optional_pdf_to_docx`) | Reliable text layer + low photographic complexity (opt-in or subset font with ToUnicode) | Gated 9-step optional PDF-to-DOCX workflow | **PASSED** (divergence rejected, faithful roundtrip verified) |
| **E. Scanned / Complex Photographic PDF** (`ocr_extract_only_preserve_original`) | Scanned image-only pages, mixed scanned pages, incomplete ToUnicode mapping, or photographic backgrounds | OCR text extraction only; rejects unsafe background replacement and retains original PDF untouched | **PASSED** (SHA-256 of original preserved) |

Original PDF templates are never replaced with generic PDFs reconstructed from plain text.

---

## 7. Optional PDF-to-DOCX Conversion Suitability

Implemented in `server/src/services/pdfToDocxWorkflow.js` (`runOptionalPdfToDocxWorkflow` and `compareConvertedDocxWithPdf`):

1. Preserves original PDF immutably (SHA-256 recorded).
2. Converts a working copy to DOCX (`--infilter=writer_pdf_import --convert-to docx` or injected tool).
3. Inspects resulting DOCX structure (`inspectDocx`).
4. Compares converted DOCX against original PDF (word-level F1 text retention, paragraph/block ratio, image count delta, table/vector heuristics).
5. Identifies concrete differences across `text`, `layout`, `tables`, and `images`.
6. Rejects editing (`LAYOUT_DIVERGENCE_REJECTED`) when structure is unreliable (e.g., text retention `< 85%`, severe paragraph collapse, or image loss) and returns the original PDF untouched.
7. Applies edits only to verified reliable DOCX structures (`applyDocxEdits`).
8. Exports revised DOCX back to PDF (`convertDocxBufferToPdf`).
9. Renders and visually compares the resulting PDF against the original (`comparePdfVisually`), rejecting the route (`FINAL_VISUAL_DIVERGENCE_REJECTED`) if page count or visual similarity diverges.

Includes an explicit disclaimer (`PDF_TO_DOCX_DISCLAIMER`) stating that PDF-to-DOCX conversion does not guarantee identical formatting.

---

## 8. Actual Test Results

Executed directly on Windows (`win32`, Node.js, no Docker):

### New Windows Document Processing Test Suite
Command: `node --test server/test/windows-document-processing.test.js`

- **Total**: 11 tests
- **Passed**: 10
- **Failed**: 0
- **Skipped**: 1 (`3b. DOCX to PDF real LibreOffice integration test` — skipped because LibreOffice is not installed on this local Windows machine)
- **Duration**: ~1.45 s

### Full Backend Automated Test Suite
Command: `node --test test/*.test.js` (inside `server/`)

- **Total**: 166 tests
- **Passed**: 164
- **Failed**: 0
- **Skipped**: 2 (PostgreSQL live test without `TEST_DATABASE_URL`, and live LibreOffice conversion test without local LibreOffice)
- **Duration**: ~9.29 s

### Frontend Production Build
Command: `npm.cmd run build`

- **Result**: Passed (`vite build` succeeded in 2.12 s, 59 modules transformed).

### Independent Linux CI Job
Added `libreoffice-conversion-tests` to `.github/workflows/ci.yml` which installs `libreoffice-writer`, `libreoffice-core`, `fonts-dejavu`, and `fonts-noto-core` on `ubuntu-latest` and runs `server/test/windows-document-processing.test.js` and `server/test/docx-pdf-templates-unified.test.js` against a real LibreOffice installation without Docker.

---

## 9. Remaining Limitations

1. **Local Live LibreOffice Execution**: Because LibreOffice is not installed on this local Windows workstation, live binary conversion tests (`DOC -> DOCX`, `DOCX -> PDF`, `PDF -> DOCX` via `soffice.com`) were skipped rather than fabricated. Installing LibreOffice via `winget install --id TheDocumentFoundation.LibreOffice -e` immediately enables them locally without any code changes.
2. **Font Parity Across Environments**: Even when using the same LibreOffice version on Windows, Linux, and Docker, visual line-wrapping parity depends on having matching fonts installed (e.g., Liberation / Noto / DejaVu / Microsoft Core Fonts).
3. **PDF-to-DOCX Fidelity**: PDF is a fixed-layout presentation format; `writer_pdf_import` cannot guarantee 100% identical formatting on complex multi-column or magazine-style PDFs. RUNUT intentionally gates and rejects such conversions rather than producing degraded output.
4. **PowerShell Execution Policy**: On Windows machines with restricted PowerShell execution policy (`npm.ps1` blocked), developers can invoke `npm.cmd` or `node --test` directly.
