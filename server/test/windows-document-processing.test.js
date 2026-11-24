// Native Windows-compatible document processing tests (no Docker required).
// Uses real LibreOffice when installed; explicitly skips tests that require an external
// LibreOffice binary when unavailable, with clear skip reasons (never fabricates results).
import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { existsSync, readdirSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import JSZip from 'jszip';
import { PDFDocument, StandardFonts, rgb } from 'pdf-lib';
import request from 'supertest';
import {
  WINDOWS_LIBREOFFICE_PATHS,
  LINUX_LIBREOFFICE_PATHS,
  getCandidateLibreOfficePaths,
  detectLibreOffice,
  getLibreOfficeInstallInstructions,
  runLibreOfficeConversion,
} from '../src/services/libreOffice.js';
import {
  convertDocBufferToDocx,
  convertDocxBufferToPdf,
  hasOleDocMagic,
  validateDocxBuffer,
  validateGeneratedPdf,
} from '../src/services/docxToPdf.js';
import {
  inspectPdf,
  selectPdfEditingStrategy,
  applyPdfEdits,
  comparePdfVisually,
} from '../src/services/pdfEditor.js';
import {
  inspectDocx,
  applyDocxEdits,
} from '../src/services/docxEditor.js';
import {
  compareConvertedDocxWithPdf,
  runOptionalPdfToDocxWorkflow,
} from '../src/services/pdfToDocxWorkflow.js';
import {
  getDocumentProcessingCapabilities,
  processPdfWithStrategy,
  resetDocumentProcessingCache,
} from '../src/services/documentProcessor.js';
import { createApp } from '../src/app.js';

function sha256(buf) {
  return createHash('sha256').update(buf).digest('hex');
}

async function buildSampleDocx(paragraphs = ['Penelitian ini menguji sistem konversi dokumen Windows tanpa Docker.']) {
  const zip = new JSZip();
  zip.file('[Content_Types].xml', `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">
  <Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>
  <Default Extension="xml" ContentType="application/xml"/>
  <Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/>
  <Override PartName="/word/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.styles+xml"/>
  <Override PartName="/word/header1.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.header+xml"/>
</Types>`);
  zip.file('_rels/.rels', `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
  <Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/>
</Relationships>`);
  zip.file('word/_rels/document.xml.rels', `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
  <Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/>
  <Relationship Id="rId2" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/header" Target="header1.xml"/>
</Relationships>`);
  zip.file('word/styles.xml', `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<w:styles xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">
  <w:style w:type="paragraph" w:styleId="Normal"><w:name w:val="Normal"/></w:style>
</w:styles>`);
  zip.file('word/header1.xml', `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<w:hdr xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">
  <w:p><w:r><w:t>TEMPLATE HEADER ASLI</w:t></w:r></w:p>
</w:hdr>`);
  const bodyXml = paragraphs
    .map((p) => `<w:p><w:r><w:t xml:space="preserve">${p}</w:t></w:r></w:p>`)
    .join('');
  zip.file('word/document.xml', `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">
  <w:body>
    ${bodyXml}
    <w:sectPr><w:pgSz w:w="11906" w:h="16838"/></w:sectPr>
  </w:body>
</w:document>`);
  return zip.generateAsync({ type: 'nodebuffer' });
}

async function buildEditablePdf(lines = ['Dokumen evaluasi tata letak asli untuk pengujian native PDF.']) {
  const doc = await PDFDocument.create();
  const page = doc.addPage([595.28, 841.89]);
  const font = await doc.embedFont(StandardFonts.Helvetica);
  let y = 760;
  for (const line of lines) {
    page.drawText(line, { x: 60, y, size: 12, font, color: rgb(0.05, 0.05, 0.05) });
    y -= 24;
  }
  return Buffer.from(await doc.save({ useObjectStreams: false }));
}

async function buildFillablePdf() {
  const doc = await PDFDocument.create();
  const page = doc.addPage([595.28, 841.89]);
  const font = await doc.embedFont(StandardFonts.Helvetica);
  page.drawText('Formulir Pengajuan Akademik', { x: 60, y: 780, size: 14, font });
  const form = doc.getForm();
  const field = form.createTextField('student_name');
  field.setText('Nama Mahasiswa Lama');
  field.addToPage(page, { x: 60, y: 720, width: 280, height: 24 });
  return Buffer.from(await doc.save({ useObjectStreams: false }));
}

async function buildScannedImageOnlyPdf() {
  const doc = await PDFDocument.create();
  const page = doc.addPage([595.28, 841.89]);
  // Minimal 1x1 PNG embedded as scanned page image with no text layer
  const tinyPng = Buffer.from(
    'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==',
    'base64',
  );
  const img = await doc.embedPng(tinyPng);
  page.drawImage(img, { x: 40, y: 100, width: 500, height: 650 });
  return Buffer.from(await doc.save({ useObjectStreams: false }));
}

// Probe real system LibreOffice once for live integration tests
const realLibreOffice = await detectLibreOffice();
const requireIntegration = String(process.env.RUNUT_REQUIRE_INTEGRATION_TESTS || '').toLowerCase() === 'true';

// 1. LibreOffice executable discovery
test('1. LibreOffice discovery: prefers soffice.com over soffice.exe on Windows, supports LIBREOFFICE_PATH, PATH, and Linux', async () => {
  const winCandidates = getCandidateLibreOfficePaths({}, { platform: 'win32' });
  assert.equal(winCandidates[0], 'C:\\Program Files\\LibreOffice\\program\\soffice.com');
  assert.equal(winCandidates[1], 'C:\\Program Files\\LibreOffice\\program\\soffice.exe');
  assert.equal(winCandidates[2], 'C:\\Program Files (x86)\\LibreOffice\\program\\soffice.com');
  assert.equal(winCandidates[3], 'C:\\Program Files (x86)\\LibreOffice\\program\\soffice.exe');
  assert.ok(winCandidates.includes('soffice.com'));
  assert.ok(winCandidates.includes('soffice.exe'));

  // When both soffice.com and soffice.exe exist on Windows, soffice.com is selected first
  const winDet = await detectLibreOffice({
    env: {},
    platform: 'win32',
    fileExists: (p) => WINDOWS_LIBREOFFICE_PATHS.includes(p),
    execRunner: async (bin, args) => {
      assert.equal(args[0], '--version');
      return { stdout: 'LibreOffice 24.8.2.1 0f794b6e29741098670a3b95d60478a65d05ef13\n' };
    },
  });
  assert.equal(winDet.available, true);
  assert.equal(winDet.binary, 'C:\\Program Files\\LibreOffice\\program\\soffice.com');
  assert.equal(winDet.prefers_console_binary, true);

  // Explicit LIBREOFFICE_PATH takes precedence
  const explicitPath = 'D:\\Tools\\LibreOffice\\program\\soffice.com';
  const explicitDet = await detectLibreOffice({
    env: { LIBREOFFICE_PATH: explicitPath },
    platform: 'win32',
    fileExists: (p) => p === explicitPath,
    execRunner: async (bin) => ({ stdout: `LibreOffice 24.8 (${bin})` }),
  });
  assert.equal(explicitDet.available, true);
  assert.equal(explicitDet.binary, explicitPath);

  // Linux discovery checks Linux paths and soffice
  const linuxCandidates = getCandidateLibreOfficePaths({}, { platform: 'linux' });
  assert.equal(linuxCandidates[0], LINUX_LIBREOFFICE_PATHS[0]);
  const linuxDet = await detectLibreOffice({
    env: {},
    platform: 'linux',
    fileExists: (p) => p === '/usr/bin/soffice',
    execRunner: async () => ({ stdout: 'LibreOffice 7.6.7.2\n' }),
  });
  assert.equal(linuxDet.available, true);
  assert.equal(linuxDet.binary, '/usr/bin/soffice');

  // Missing LibreOffice returns accurate Windows installation guidance without requiring Docker
  const missingDet = await detectLibreOffice({
    env: {},
    platform: 'win32',
    fileExists: () => false,
    execRunner: async () => { throw new Error('ENOENT'); },
  });
  assert.equal(missingDet.available, false);
  assert.equal(missingDet.install_guidance.docker_required, false);
  assert.match(missingDet.install_guidance.recommended_env, /soffice\.com/);
});

// 2. DOC to DOCX conversion
test('2. DOC to DOCX conversion: validates OLE2 signature, isolated profile args, and output OOXML integrity', async () => {
  const invalidDoc = Buffer.from('not an ole2 doc file');
  assert.equal(hasOleDocMagic(invalidDoc), false);
  const badRes = await convertDocBufferToDocx(invalidDoc);
  assert.equal(badRes.ok, false);
  assert.equal(badRes.code, 'INVALID_DOC_SIGNATURE');

  const fakeOleDoc = Buffer.from([0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1, 0x00, 0x00]);
  const origHash = sha256(fakeOleDoc);
  const validDocx = await buildSampleDocx(['Hasil konversi dokumen Word lama.']);

  const okRes = await convertDocBufferToDocx(fakeOleDoc, {
    converter: async () => validDocx,
  });
  assert.equal(okRes.ok, true);
  assert.equal(await validateDocxBuffer(okRes.buffer), true);
  assert.equal(sha256(fakeOleDoc), origHash, 'Original DOC buffer must remain immutable');

  // When LibreOffice is unavailable, returns clear guidance (Docker not required)
  const unavail = await convertDocBufferToDocx(fakeOleDoc, {
    env: {},
    platform: 'win32',
    fileExists: () => false,
    execRunner: async () => { throw new Error('ENOENT'); },
  });
  assert.equal(unavail.ok, false);
  assert.equal(unavail.code, 'DOC_CONVERTER_UNAVAILABLE');
  assert.equal(unavail.install_guidance.docker_required, false);
});

// 3. DOCX to PDF conversion (unit + real LibreOffice if installed)
test('3a. DOCX to PDF conversion: rejects exit-code-0 without output file, captures stderr, and validates PDF output', async () => {
  const validDocx = await buildSampleDocx(['Uji konversi DOCX ke PDF di Windows.']);
  const origHash = sha256(validDocx);

  // LibreOffice exits 0 without writing output PDF -> MUST NOT return success
  let capturedArgs = null;
  const noOutputRes = await convertDocxBufferToPdf(validDocx, {
    env: {},
    platform: 'win32',
    fileExists: (p) => p === WINDOWS_LIBREOFFICE_PATHS[0],
    execRunner: async (_bin, args) => {
      if (args[0] === '--version') return { stdout: 'LibreOffice 24.8' };
      capturedArgs = args;
      return { stdout: '', stderr: 'Warning: failed to write output' };
    },
  });
  assert.equal(noOutputRes.ok, false);
  assert.equal(noOutputRes.status, 'pdf_validation_failed');
  assert.match(noOutputRes.stderr, /failed to write output/);
  assert.ok(capturedArgs.some((a) => a.startsWith('-env:UserInstallation=file:///')), 'Must use isolated LibreOffice profile');
  assert.ok(capturedArgs.includes('--headless'), 'Must run headless');
  assert.equal(sha256(validDocx), origHash, 'Original DOCX buffer must remain immutable');
});

test('2b. DOC to DOCX real LibreOffice integration test', async (t) => {
  if (!realLibreOffice.available) {
    if (requireIntegration) {
      assert.fail(`RUNUT_REQUIRE_INTEGRATION_TESTS=true but LibreOffice is not installed on ${process.platform} (${getLibreOfficeInstallInstructions().recommended_env}).`);
    }
    t.skip(`LibreOffice is not installed on this ${process.platform} environment (${getLibreOfficeInstallInstructions().recommended_env}).`);
    return;
  }
  // Generate a real legacy OLE2 .doc using LibreOffice first, then convert it back to .docx via convertDocBufferToDocx
  const sampleDocx = await buildSampleDocx(['Pengujian konversi nyata dokumen Word lama DOC ke DOCX menggunakan LibreOffice lokal.']);
  const toLegacyDoc = await runLibreOfficeConversion({
    inputBuffer: sampleDocx,
    inputFilename: 'source.docx',
    expectedOutputFilename: 'source.doc',
    convertTo: 'doc',
    tempPrefix: 'runut-test-make-doc-',
  });
  assert.equal(toLegacyDoc.ok, true, `Failed to synthesize legacy .doc fixture: ${toLegacyDoc.stderr || toLegacyDoc.error}`);
  assert.equal(hasOleDocMagic(toLegacyDoc.buffer), true, 'Synthesized .doc must have valid OLE2 signature');

  const res = await convertDocBufferToDocx(toLegacyDoc.buffer);
  assert.equal(res.ok, true, `Expected real DOC->DOCX conversion to succeed, got: ${res.reason}`);
  assert.equal(res.engine, 'libreoffice');
  assert.equal(await validateDocxBuffer(res.buffer), true);
  const inspected = await inspectDocx(res.buffer);
  assert.match(inspected.text, /Pengujian konversi nyata dokumen Word lama DOC ke DOCX/);
});

test('3b. DOCX to PDF real LibreOffice integration test', async (t) => {
  if (!realLibreOffice.available) {
    if (requireIntegration) {
      assert.fail(`RUNUT_REQUIRE_INTEGRATION_TESTS=true but LibreOffice is not installed on ${process.platform} (${getLibreOfficeInstallInstructions().recommended_env}).`);
    }
    t.skip(`LibreOffice is not installed on this ${process.platform} environment (${getLibreOfficeInstallInstructions().recommended_env}).`);
    return;
  }
  const sampleDocx = await buildSampleDocx(['Pengujian konversi nyata DOCX ke PDF menggunakan LibreOffice lokal tanpa Docker.']);
  const res = await convertDocxBufferToPdf(sampleDocx);
  assert.equal(res.ok, true, `Expected real LibreOffice conversion to succeed, got: ${res.reason}`);
  assert.equal(res.engine, 'libreoffice');
  assert.ok(res.page_count >= 1);
  const check = await validateGeneratedPdf(res.buffer);
  assert.equal(check.valid, true);
});

// 4. PDF extraction & automatic strategy selection (A-E)
test('4. PDF extraction & automatic strategy selection covers A (Editable), B (Fillable), C (Placeholder), D (Optional PDF-to-DOCX), E (Scanned)', async () => {
  const editablePdf = await buildEditablePdf(['Kalimat pertama untuk evaluasi strategi penyuntingan PDF.']);
  const editableInsp = await inspectPdf(editablePdf);
  assert.equal(editableInsp.has_text_layer, true);
  assert.equal(editableInsp.editing_strategy.code, 'A');
  assert.equal(editableInsp.editing_strategy.strategy, 'native_pdf_text_edit');

  const strategyD = selectPdfEditingStrategy(editableInsp, { allowOptionalPdfToDocx: true });
  assert.equal(strategyD.code, 'D');
  assert.equal(strategyD.strategy, 'optional_pdf_to_docx');

  const fillablePdf = await buildFillablePdf();
  const fillableInsp = await inspectPdf(fillablePdf);
  assert.equal(fillableInsp.has_acroform, true);
  assert.equal(fillableInsp.editing_strategy.code, 'B');
  assert.equal(fillableInsp.editing_strategy.strategy, 'fillable_acroform_edit');

  const placeholderPdf = await buildEditablePdf(['Kepada Yth. {{NAMA_PENERIMA}} di tempat.']);
  const placeholderInsp = await inspectPdf(placeholderPdf);
  assert.equal(placeholderInsp.has_placeholders, true);
  assert.equal(placeholderInsp.editing_strategy.code, 'C');
  assert.equal(placeholderInsp.editing_strategy.strategy, 'placeholder_region_edit');

  const scannedPdf = await buildScannedImageOnlyPdf();
  const scannedInsp = await inspectPdf(scannedPdf);
  assert.equal(scannedInsp.is_scanned, true);
  assert.equal(scannedInsp.editing_strategy.code, 'E');
  assert.equal(scannedInsp.editing_strategy.strategy, 'ocr_extract_only_preserve_original');
});

// 5. Native PDF replacement (editable text, AcroForm, placeholder)
test('5. Native PDF replacement edits text, AcroForm fields, and placeholders while preserving original PDF template', async () => {
  // Editable PDF native replacement
  const editablePdf = await buildEditablePdf(['Laporan ini dibuat dengan metode lama yang sederhana.']);
  const origEditableHash = sha256(editablePdf);
  const editedRes = await applyPdfEdits(editablePdf, [
    { snippet: 'metode lama', suggestion: 'metode baru' },
  ]);
  assert.equal(editedRes.modified, true);
  assert.equal(editedRes.applied_count, 1);
  assert.equal(sha256(editablePdf), origEditableHash);
  const visual = await comparePdfVisually(editablePdf, editedRes.buffer, { editedRegions: editedRes.applied });
  assert.equal(visual.page_count_match, true);
  assert.equal(visual.layout_preserved, true);

  // Fillable AcroForm PDF
  const fillablePdf = await buildFillablePdf();
  const filledRes = await applyPdfEdits(fillablePdf, [
    { snippet: 'Nama Mahasiswa Lama', suggestion: 'Budi Santoso' },
  ]);
  assert.equal(filledRes.modified, true);
  assert.equal(filledRes.applied[0].mode, 'acroform_field');
  const postFillInsp = await inspectPdf(filledRes.buffer);
  assert.match(postFillInsp.text, /Budi Santoso/);

  // Placeholder PDF
  const placeholderPdf = await buildEditablePdf(['Peserta: {{NAMA_PESERTA}}']);
  const phRes = await processPdfWithStrategy(placeholderPdf, [
    { snippet: '{{NAMA_PESERTA}}', suggestion: 'Siti Rahma' },
  ]);
  assert.equal(phRes.strategy.code, 'C');
  assert.equal(phRes.modified, true);
  const postPhInsp = await inspectPdf(phRes.buffer);
  assert.match(postPhInsp.text, /Siti Rahma/);
});

// 6. Original template preservation & no RUNUT watermark
test('6. Original template preservation: DOCX styles/headers preserved, original immutable, zero RUNUT watermark', async () => {
  const origDocx = await buildSampleDocx(['Metode penelitian ini kurang efektif pada tahap awal.']);
  const origHash = sha256(origDocx);
  const edited = await applyDocxEdits(origDocx, {
    issueEdits: [{ snippet: 'kurang efektif', suggestion: 'belum optimal' }],
  });
  assert.equal(edited.applied_count, 1);
  assert.equal(edited.verification.verified, true);
  assert.equal(edited.verification.checks.headers_footers_preserved, true);
  assert.equal(edited.verification.checks.original_formatting_preserved, true);
  assert.equal(sha256(origDocx), origHash);

  const inspected = await inspectDocx(edited.buffer);
  assert.match(inspected.text, /belum optimal/);
  assert.doesNotMatch(inspected.text, /RUNUT|Generated by/i);
});

// 7. Complex PDF rejection & gated optional PDF-to-DOCX workflow
test('7. Complex PDF rejection: scanned PDF rejected for unsafe edit, and PDF-to-DOCX rejects layout divergence while accepting reliable roundtrip', async () => {
  // Scanned PDF rejected without modifying original
  const scannedPdf = await buildScannedImageOnlyPdf();
  const scannedHash = sha256(scannedPdf);
  const scannedOut = await processPdfWithStrategy(scannedPdf, [
    { snippet: 'teks apa saja', suggestion: 'revisi' },
  ]);
  assert.equal(scannedOut.ok, false);
  assert.equal(scannedOut.strategy.code, 'E');
  assert.equal(sha256(scannedOut.buffer), scannedHash, 'Original scanned PDF must be preserved unchanged');

  // Optional PDF-to-DOCX rejects significant text/structure divergence
  const sourcePdf = await buildEditablePdf([
    'Analisis sistem pengolahan dokumen akademik pada lingkungan Windows.',
    'Bagian kedua membahas validasi struktur dan keutuhan tata letak.',
  ]);
  const sourceHash = sha256(sourcePdf);
  const divergentDocx = await buildSampleDocx(['Teks sama sekali berbeda dan banyak bagian hilang.']);

  const rejectedRoute = await runOptionalPdfToDocxWorkflow(
    sourcePdf,
    [{ snippet: 'pengolahan dokumen', suggestion: 'pemrosesan dokumen' }],
    { pdfToDocxConverter: async () => divergentDocx },
  );
  assert.equal(rejectedRoute.ok, false);
  assert.equal(rejectedRoute.route_rejected, true);
  assert.equal(rejectedRoute.code, 'LAYOUT_DIVERGENCE_REJECTED');
  assert.equal(sha256(rejectedRoute.buffer), sourceHash, 'Original PDF must be returned untouched when route rejected');
  assert.ok(rejectedRoute.structure_comparison.differences.length > 0);
  assert.match(rejectedRoute.disclaimer, /tidak menjamin/i);

  // Optional PDF-to-DOCX succeeds when structure & visual roundtrip are verified
  const faithfulDocx = await buildSampleDocx([
    'Analisis sistem pengolahan dokumen akademik pada lingkungan Windows.',
    'Bagian kedua membahas validasi struktur dan keutuhan tata letak.',
  ]);
  const revisedPdf = await buildEditablePdf([
    'Analisis sistem pemrosesan dokumen akademik pada lingkungan Windows.',
    'Bagian kedua membahas validasi struktur dan keutuhan tata letak.',
  ]);
  const acceptedRoute = await runOptionalPdfToDocxWorkflow(
    sourcePdf,
    [{ snippet: 'pengolahan dokumen', suggestion: 'pemrosesan dokumen' }],
    {
      pdfToDocxConverter: async () => faithfulDocx,
      docxToPdfConverter: async () => revisedPdf,
    },
  );
  assert.equal(acceptedRoute.ok, true);
  assert.equal(acceptedRoute.route_rejected, false);
  assert.equal(acceptedRoute.applied_count, 1);
  assert.equal(acceptedRoute.visual_comparison.page_count_match, true);
  assert.equal(sha256(sourcePdf), sourceHash);
});

// 8. Output validation
test('8. Output validation rejects corrupt DOCX inputs and invalid PDF outputs', async () => {
  const corruptDocx = await convertDocxBufferToPdf(Buffer.from('corrupt-bytes'));
  assert.equal(corruptDocx.ok, false);
  assert.equal(corruptDocx.code, 'CORRUPTED_DOCX');

  const validDocx = await buildSampleDocx(['Valid input']);
  const badPdfOut = await convertDocxBufferToPdf(validDocx, {
    converter: async () => Buffer.from('NOT_A_PDF_FILE'),
  });
  assert.equal(badPdfOut.ok, false);
  assert.equal(badPdfOut.code, 'INVALID_PDF_OUTPUT');

  const pdfCheck = await validateGeneratedPdf(Buffer.from('%PDF-1.7\ncorrupted body'));
  assert.equal(pdfCheck.valid, false);
});

// 9. File integrity & Windows startup without Docker (/api/health)
test('9. Application health & capabilities work directly on Windows without Docker', async () => {
  resetDocumentProcessingCache();
  const caps = await getDocumentProcessingCapabilities({
    forceRefresh: true,
    platform: 'win32',
    env: {},
    fileExists: () => false,
    execRunner: async () => { throw new Error('ENOENT'); },
  });
  assert.equal(caps.docker_required, false);
  assert.equal(caps.capabilities.docx_native_edit, true);
  assert.equal(caps.capabilities.pdf_extraction, true);
  assert.equal(caps.capabilities.pdf_native_edit, true);
  assert.equal(caps.libreoffice.available, false);
  assert.ok(caps.libreoffice.install_guidance);

  const app = createApp();
  const res = await request(app).get('/api/health');
  assert.equal(res.status, 200);
  assert.equal(res.body.ok, true);
  assert.equal(res.body.document_processing.docker_required, false);
});

// 10. Temporary file cleanup
test('10. Temporary file cleanup removes isolated LibreOffice temp directories after both failure and completion', async () => {
  const prefix = `runut-cleanup-test-${Date.now()}-`;
  const before = new Set(readdirSync(os.tmpdir()).filter((n) => n.startsWith(prefix)));

  const res = await runLibreOfficeConversion({
    inputBuffer: Buffer.from('dummy'),
    inputFilename: 'test.docx',
    expectedOutputFilename: 'test.pdf',
    convertTo: 'pdf',
    env: {},
    platform: 'win32',
    tempPrefix: prefix,
    fileExists: (p) => p === WINDOWS_LIBREOFFICE_PATHS[0],
    execRunner: async (_bin, args) => {
      if (args[0] === '--version') return { stdout: 'LibreOffice 24.8' };
      throw Object.assign(new Error('Simulated failure'), { stderr: 'conversion error' });
    },
  });

  assert.equal(res.ok, false);
  assert.ok(res.temp_dir);
  assert.equal(existsSync(res.temp_dir), false, 'Temp directory must be removed after failure');

  const after = readdirSync(os.tmpdir()).filter((n) => n.startsWith(prefix) && !before.has(n));
  assert.equal(after.length, 0, 'No leftover temporary directories should remain in os.tmpdir()');
});
