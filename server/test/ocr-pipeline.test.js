import test from 'node:test';
import assert from 'node:assert/strict';
import { PDFDocument, StandardFonts } from 'pdf-lib';
import { createCanvas } from '@napi-rs/canvas';
import { inspectPdf } from '../src/services/pdfEditor.js';
import {
  processPdfWithOcr,
  normalizeOcrLanguage,
  validateOcrPageResult,
} from '../src/services/ocr.js';

async function createScannedPdf(pageCount = 1) {
  const doc = await PDFDocument.create();
  const canvas = createCanvas(200, 80);
  const ctx = canvas.getContext('2d');
  ctx.fillStyle = '#FFFFFF';
  ctx.fillRect(0, 0, 200, 80);
  ctx.fillStyle = '#000000';
  ctx.fillRect(10, 20, 150, 20);
  const png = await doc.embedPng(canvas.toBuffer('image/png'));

  for (let i = 0; i < pageCount; i++) {
    const page = doc.addPage([595, 842]);
    page.drawImage(png, { x: 50, y: 650, width: 200, height: 80 });
  }
  return Buffer.from(await doc.save({ useObjectStreams: false }));
}

async function createMixedEditableAndScannedPdf() {
  const doc = await PDFDocument.create();
  const font = await doc.embedFont(StandardFonts.Helvetica);

  // Page 1: Editable text
  const p1 = doc.addPage([595, 842]);
  p1.drawText('Halaman pertama berisi teks PDF asli yang dapat disunting secara langsung.', { x: 56, y: 760, size: 11, font });

  // Page 2: Scanned image only
  const p2 = doc.addPage([595, 842]);
  const canvas = createCanvas(200, 80);
  const ctx = canvas.getContext('2d');
  ctx.fillStyle = '#FFFFFF';
  ctx.fillRect(0, 0, 200, 80);
  const png = await doc.embedPng(canvas.toBuffer('image/png'));
  p2.drawImage(png, { x: 50, y: 650, width: 200, height: 80 });

  return Buffer.from(await doc.save({ useObjectStreams: false }));
}

test('OCR Pipeline: supports Indonesian (ind), English (eng), and mixed (ind+eng) scanned PDFs', async () => {
  assert.equal(normalizeOcrLanguage('id'), 'ind');
  assert.equal(normalizeOcrLanguage('en'), 'eng');
  assert.equal(normalizeOcrLanguage('mixed'), 'ind+eng');

  const scannedBuf = await createScannedPdf(1);
  const inspection = await inspectPdf(scannedBuf);
  assert.equal(inspection.is_scanned, true);

  // Indonesian OCR
  const idRes = await processPdfWithOcr(scannedBuf, inspection, {
    language: 'ind',
    scale: 0.5,
    ocrRunner: async (_png, lang) => {
      assert.equal(lang, 'ind');
      return {
        text: 'Penelitian ini membahas kualitas penulisan akademik di perguruan tinggi.',
        confidence: 92.5,
        lines: [{ text: 'Penelitian ini membahas kualitas penulisan akademik di perguruan tinggi.', confidence: 92.5, bbox: { x: 20, y: 40, width: 400, height: 18 } }],
      };
    },
  });
  assert.equal(idRes.ocr_applied, true);
  assert.equal(idRes.language, 'ind');
  assert.equal(idRes.average_confidence, 92.5);
  assert.equal(idRes.needs_user_verification, false);

  // English OCR
  const enRes = await processPdfWithOcr(scannedBuf, inspection, {
    language: 'eng',
    scale: 0.5,
    ocrRunner: async (_png, lang) => {
      assert.equal(lang, 'eng');
      return {
        text: 'This study evaluates academic writing quality across graduate theses.',
        confidence: 94.0,
        lines: [{ text: 'This study evaluates academic writing quality across graduate theses.', confidence: 94.0, bbox: { x: 20, y: 40, width: 420, height: 18 } }],
      };
    },
  });
  assert.equal(enRes.language, 'eng');
  assert.ok(enRes.combined_text.includes('graduate theses'));

  // Mixed ind+eng OCR
  const mixedRes = await processPdfWithOcr(scannedBuf, inspection, {
    language: 'ind+eng',
    scale: 0.5,
    ocrRunner: async (_png, lang) => {
      assert.equal(lang, 'ind+eng');
      return {
        text: 'Analisis machine learning diterapkan pada korpus bahasa Indonesia.',
        confidence: 88.0,
        lines: [{ text: 'Analisis machine learning diterapkan pada korpus bahasa Indonesia.', confidence: 88.0, bbox: { x: 20, y: 40, width: 420, height: 18 } }],
      };
    },
  });
  assert.equal(mixedRes.language, 'ind+eng');
  assert.ok(mixedRes.combined_text.includes('machine learning'));
});

test('OCR Pipeline: processes mixed editable + scanned PDF page-by-page without running OCR on editable pages', async () => {
  const mixedBuf = await createMixedEditableAndScannedPdf();
  const inspection = await inspectPdf(mixedBuf);

  assert.equal(inspection.is_mixed, true);
  assert.deepEqual(inspection.editable_pages, [1]);
  assert.deepEqual(inspection.scanned_pages, [2]);

  const ocrPagesCalled = [];
  const res = await processPdfWithOcr(mixedBuf, inspection, {
    language: 'ind+eng',
    scale: 0.5,
    ocrRunner: async (_png, _lang, meta) => {
      ocrPagesCalled.push(meta.page);
      return {
        text: 'Halaman kedua hasil pindai diekstrak melalui OCR.',
        confidence: 89.0,
        lines: [{ text: 'Halaman kedua hasil pindai diekstrak melalui OCR.', confidence: 89.0, bbox: { x: 10, y: 10, width: 300, height: 16 } }],
      };
    },
  });

  assert.deepEqual(ocrPagesCalled, [2]);
  assert.equal(res.page_results[0].source, 'native_pdf_text');
  assert.equal(res.page_results[1].source, 'ocr');
  assert.ok(res.combined_text.includes('Halaman pertama berisi teks PDF asli'));
  assert.ok(res.combined_text.includes('Halaman kedua hasil pindai'));
});

test('OCR Pipeline: flags low-resolution OCR, tables, numbers, and formulas for mandatory user verification', () => {
  const lowConfPage = {
    confidence: 58.2,
    lines: [
      { text: 'Tabel 1 | Akurasi | 94,5% | p = 0.001 ± 0.02', confidence: 61.0, bbox: { x: 10, y: 50, width: 350, height: 15 } },
      { text: 'Persamaan y = a0 + b1x2 pada sampel 2024', confidence: 55.0, bbox: { x: 10, y: 80, width: 300, height: 15 } },
      { text: 'Teks biasa yang terbaca jelas.', confidence: 91.0, bbox: { x: 10, y: 110, width: 220, height: 15 } },
    ],
  };

  const { uncertainSegments, warnings } = validateOcrPageResult(lowConfPage, 1, 75);
  assert.equal(uncertainSegments.length, 2);
  assert.ok(uncertainSegments[0].reasons.includes('contains_numbers_or_formula_under_low_confidence'));
  assert.ok(uncertainSegments[1].reasons.includes('contains_numbers_or_formula_under_low_confidence'));
  assert.equal(warnings.length, 1);
  assert.match(warnings[0], /58\.2%/);
});
