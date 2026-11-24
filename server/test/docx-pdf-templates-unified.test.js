import test from 'node:test';
import assert from 'node:assert/strict';
import JSZip from 'jszip';
import { PDFDocument, StandardFonts } from 'pdf-lib';
import {
  detectLibreOffice,
  convertDocxBufferToPdf,
  WINDOWS_LIBREOFFICE_PATHS,
} from '../src/services/docxToPdf.js';
import { inspectPdf, applyPdfEdits, comparePdfVisually } from '../src/services/pdfEditor.js';
import { buildPdf } from '../src/services/pdf.js';

async function createMinimalValidDocx() {
  const zip = new JSZip();
  zip.file('word/document.xml', '<?xml version="1.0"?><w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body><w:p><w:r><w:t>Hello DOCX</w:t></w:r></w:p></w:body></w:document>');
  return zip.generateAsync({ type: 'nodebuffer' });
}

test('LibreOffice Detection: checks LIBREOFFICE_PATH, Windows Program Files paths, and verifies executable actually runs', async () => {
  // 1. Simulated Windows installation at Program Files
  const winDet = await detectLibreOffice({
    env: {},
    fileExists: (p) => p === WINDOWS_LIBREOFFICE_PATHS[0],
    execRunner: async (bin, args) => {
      if (bin === WINDOWS_LIBREOFFICE_PATHS[0] && args[0] === '--version') {
        return { stdout: 'LibreOffice 24.8.3.2' };
      }
      throw new Error('ENOENT');
    },
  });
  assert.equal(winDet.available, true);
  assert.equal(winDet.binary, WINDOWS_LIBREOFFICE_PATHS[0]);
  assert.match(winDet.version, /LibreOffice/);

  // 2. Configured LIBREOFFICE_PATH that does NOT actually run must NOT be assumed valid
  const badEnvDet = await detectLibreOffice({
    env: { LIBREOFFICE_PATH: 'C:\\Fake\\soffice.exe' },
    fileExists: () => false,
    execRunner: async () => { throw new Error('ENOENT'); },
  });
  assert.equal(badEnvDet.available, false);
  assert.equal(badEnvDet.binary, null);

  // 3. Simulated Linux/Docker installation on PATH ('soffice')
  const dockerDet = await detectLibreOffice({
    env: {},
    fileExists: () => false,
    execRunner: async (bin) => {
      if (bin === 'soffice') return { stdout: 'LibreOffice 24.2.5.2 (Alpine)' };
      throw new Error('ENOENT');
    },
  });
  assert.equal(dockerDet.available, true);
  assert.equal(dockerDet.binary, 'soffice');
});

test('DOCX-to-PDF Conversion: handles valid conversion, corrupted DOCX, timeout, disabled flag, and missing LibreOffice', async () => {
  const validDocx = await createMinimalValidDocx();
  const validPdf = await buildPdf({ body: 'Converted PDF output without any RUNUT watermark.' });

  // 1. Corrupted DOCX rejected before conversion
  const corrupt = await convertDocxBufferToPdf(Buffer.from('not a docx'));
  assert.equal(corrupt.ok, false);
  assert.equal(corrupt.code, 'CORRUPTED_DOCX');
  assert.equal(corrupt.status, 'pdf_validation_failed');

  // 2. Disabled via env
  const disabled = await convertDocxBufferToPdf(validDocx, { env: { DOCX_PDF_CONVERSION_ENABLED: 'false' } });
  assert.equal(disabled.ok, false);
  assert.equal(disabled.code, 'CONVERSION_DISABLED');

  // 3. Missing LibreOffice executable
  const missing = await convertDocxBufferToPdf(validDocx, {
    env: {},
    fileExists: () => false,
    execRunner: async () => { throw new Error('ENOENT'); },
  });
  assert.equal(missing.ok, false);
  assert.equal(missing.code, 'CONVERTER_UNAVAILABLE');
  assert.equal(missing.status, 'docx_pdf_converter_unavailable');

  // 4. Conversion timeout
  const timedOut = await convertDocxBufferToPdf(validDocx, {
    timeoutMs: 30,
    converter: async () => new Promise((resolve) => setTimeout(() => resolve(validPdf), 200)),
  });
  assert.equal(timedOut.ok, false);
  assert.equal(timedOut.code, 'CONVERSION_TIMEOUT');

  // 5. Valid conversion & PDF output validation
  const okRes = await convertDocxBufferToPdf(validDocx, {
    converter: async () => validPdf,
  });
  assert.equal(okRes.ok, true);
  assert.equal(okRes.status, 'docx_pdf_conversion_success');
  assert.equal(okRes.page_count, 1);
});

test('Native PDF Templates: detects & edits Fillable AcroForm fields and Designated Placeholders without altering layout', async () => {
  // 1. Fillable AcroForm PDF
  const formDoc = await PDFDocument.create();
  const font = await formDoc.embedFont(StandardFonts.Helvetica);
  const page = formDoc.addPage([595, 842]);
  page.drawText('FORMULIR LAPORAN AKADEMIK', { x: 56, y: 780, size: 14, font });

  const form = formDoc.getForm();
  const titleField = form.createTextField('report_title');
  titleField.setText('Dalam era modern, laporan sistem informasi');
  titleField.addToPage(page, { x: 56, y: 720, width: 400, height: 24 });
  const formBuf = Buffer.from(await formDoc.save({ useObjectStreams: false }));

  const formInfo = await inspectPdf(formBuf);
  assert.equal(formInfo.has_acroform, true);
  assert.equal(formInfo.editable_status, 'fillable_acroform_pdf');
  assert.equal(formInfo.acroform_fields[0].name, 'report_title');

  const formEdited = await applyPdfEdits(formBuf, [{
    snippet: 'Dalam era modern',
    suggestion: 'Saat ini',
  }]);
  assert.equal(formEdited.modified, true);
  assert.equal(formEdited.applied[0].mode, 'acroform_field');
  const reloadedFormDoc = await PDFDocument.load(formEdited.buffer);
  assert.equal(reloadedFormDoc.getForm().getTextField('report_title').getText(), 'Saat ini, laporan sistem informasi');

  // 2. Designated placeholder PDF ({{PLACEHOLDER}})
  const phDoc = await PDFDocument.create();
  const phFont = await phDoc.embedFont(StandardFonts.Helvetica);
  const phPage = phDoc.addPage([595, 842]);
  phPage.drawText('Judul: {{JUDUL_LAPORAN}} untuk penelitian akademik tahun ini.', { x: 56, y: 740, size: 11, font: phFont });
  const phBuf = Buffer.from(await phDoc.save({ useObjectStreams: false }));

  const phInfo = await inspectPdf(phBuf);
  assert.equal(phInfo.has_placeholders, true);
  assert.equal(phInfo.placeholders[0].token, '{{JUDUL_LAPORAN}}');

  const phEdited = await applyPdfEdits(phBuf, [{
    snippet: '{{JUDUL_LAPORAN}}',
    suggestion: 'Analisis Kualitas Tulisan',
  }]);
  assert.equal(phEdited.modified, true);
  const phAfter = await inspectPdf(phEdited.buffer);
  assert.ok(phAfter.text.includes('Analisis Kualitas Tulisan'));
  const phVisual = await comparePdfVisually(phBuf, phEdited.buffer, { scale: 0.5, editedRegions: phEdited.applied });
  assert.equal(phVisual.layout_preserved, true);
  assert.equal(phVisual.white_patch_artifacts_detected, false);
});
