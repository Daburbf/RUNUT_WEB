import test from 'node:test';
import assert from 'node:assert/strict';
import { PDFDocument, StandardFonts, rgb, PDFName } from 'pdf-lib';
import { createCanvas } from '@napi-rs/canvas';
import {
  inspectPdf,
  applyPdfEdits,
  comparePdfVisually,
} from '../src/services/pdfEditor.js';

async function createEditableMultiPagePdfWithTableAndImage() {
  const doc = await PDFDocument.create();
  const font = await doc.embedFont(StandardFonts.Helvetica);
  const bold = await doc.embedFont(StandardFonts.HelveticaBold);

  // Page 1: Title, paragraph, table grid, and embedded PNG image
  const p1 = doc.addPage([595, 842]);
  p1.drawText('LAPORAN PENELITIAN AKADEMIK', { x: 56, y: 780, size: 16, font: bold, color: rgb(0, 0, 0) });
  p1.drawText('Dalam era modern, sistem informasi membantu pengelolaan data.', { x: 56, y: 740, size: 11, font, color: rgb(0, 0, 0) });

  // Draw a simple 2x2 table grid
  p1.drawRectangle({ x: 56, y: 650, width: 300, height: 48, borderColor: rgb(0, 0, 0), borderWidth: 1 });
  p1.drawLine({ start: { x: 56, y: 674 }, end: { x: 356, y: 674 }, thickness: 1, color: rgb(0, 0, 0) });
  p1.drawLine({ start: { x: 206, y: 650 }, end: { x: 206, y: 698 }, thickness: 1, color: rgb(0, 0, 0) });
  p1.drawText('Metrik', { x: 64, y: 682, size: 10, font: bold });
  p1.drawText('95.4%', { x: 214, y: 682, size: 10, font });

  // Embed a real PNG image
  const canvas = createCanvas(80, 40);
  const ctx = canvas.getContext('2d');
  ctx.fillStyle = '#003366';
  ctx.fillRect(0, 0, 80, 40);
  const pngImg = await doc.embedPng(canvas.toBuffer('image/png'));
  p1.drawImage(pngImg, { x: 450, y: 760, width: 80, height: 40 });

  // Page 2: Second editable paragraph
  const p2 = doc.addPage([595, 842]);
  p2.drawText('Halaman kedua memuat hasil evaluasi sistem secara ringkas.', { x: 56, y: 760, size: 11, font, color: rgb(0, 0, 0) });

  return Buffer.from(await doc.save({ useObjectStreams: false }));
}

async function createSubsetFontPdf() {
  const doc = await PDFDocument.create();
  const font = await doc.embedFont(StandardFonts.Helvetica);
  const page = doc.addPage([595, 842]);
  page.drawText('Teks dengan font subset tertanam untuk pengujian keamanan.', { x: 56, y: 760, size: 11, font });
  await font.embed();

  // Tag the font dictionary BaseFont with a standard 6-letter PDF subset prefix (ABCDEF+)
  for (const [, obj] of doc.context.enumerateIndirectObjects()) {
    if (obj && typeof obj.get === 'function' && String(obj.get(PDFName.of('Type'))) === '/Font') {
      obj.set(PDFName.of('BaseFont'), PDFName.of('ABCDEF+CustomSerif'));
    }
  }
  return Buffer.from(await doc.save({ useObjectStreams: false }));
}

async function createScannedImageOnlyPdf() {
  const doc = await PDFDocument.create();
  const page = doc.addPage([595, 842]);
  const canvas = createCanvas(300, 100);
  const ctx = canvas.getContext('2d');
  ctx.fillStyle = '#FFFFFF';
  ctx.fillRect(0, 0, 300, 100);
  ctx.fillStyle = '#000000';
  ctx.font = '20px sans-serif';
  ctx.fillText('Scanned Document Page', 20, 50);
  const img = await doc.embedPng(canvas.toBuffer('image/png'));
  page.drawImage(img, { x: 50, y: 650, width: 300, height: 100 });
  return Buffer.from(await doc.save({ useObjectStreams: false }));
}

test('PDF Editing: inspects coordinates, bbox, fonts, tables, images, and multi-page structure', async () => {
  const pdfBuf = await createEditableMultiPagePdfWithTableAndImage();
  const info = await inspectPdf(pdfBuf);

  assert.equal(info.page_count, 2);
  assert.equal(info.is_scanned, false);
  assert.equal(info.is_mixed, false);
  assert.equal(info.pages[0].image_count, 1);
  assert.ok(info.regions.length >= 4);

  const targetLine = info.regions.find((r) => r.text.includes('Dalam era modern'));
  assert.ok(targetLine);
  assert.equal(targetLine.page, 1);
  assert.equal(targetLine.font_size, 11);
  assert.ok(targetLine.bbox.x >= 50 && targetLine.bbox.y >= 730);
  assert.equal(targetLine.safe_to_edit, true);
});

test('PDF Editing: applies safe in-place edit on page 2 while keeping page 1 pixel-identical and visual layout preserved', async () => {
  const originalBuf = await createEditableMultiPagePdfWithTableAndImage();
  const edited = await applyPdfEdits(originalBuf, [
    {
      snippet: 'secara ringkas',
      suggestion: 'secara terukur',
    },
  ]);

  assert.equal(edited.modified, true);
  assert.equal(edited.applied_count, 1);
  assert.equal(edited.flagged_count, 0);

  const afterInfo = await inspectPdf(edited.buffer);
  assert.ok(afterInfo.text.includes('secara terukur'));
  assert.ok(afterInfo.pages[0].image_count === 1);

  const visual = await comparePdfVisually(originalBuf, edited.buffer, { scale: 0.5 });
  assert.equal(visual.page_count_match, true);
  assert.equal(visual.layout_preserved, true);
  // Page 1 was untouched -> 100% visually identical!
  assert.equal(visual.pages[0].visual_similarity_percent, 100);
  // Page 2 had only a small localized text change -> high visual similarity (>95%)
  assert.ok(visual.pages[1].visual_similarity_percent > 95);
});

test('PDF Editing: detects subset fonts and safely rejects unsafe replacement with DOCX recommendation', async () => {
  const subsetBuf = await createSubsetFontPdf();
  const info = await inspectPdf(subsetBuf);
  assert.equal(info.has_subset_fonts, true);
  assert.equal(info.editable_status, 'editable_with_subset_fonts');

  const edited = await applyPdfEdits(subsetBuf, [
    { snippet: 'font subset', suggestion: 'font standar' },
  ]);
  assert.equal(edited.modified, false);
  assert.equal(edited.flagged_count, 1);
  assert.equal(edited.flagged_regions[0].reason, 'subset_font_unsafe');
  assert.equal(edited.recommend_docx, true);
});

test('PDF Editing: detects text overflow without shrinking fonts, and succeeds when shorter revision fits', async () => {
  const originalBuf = await createEditableMultiPagePdfWithTableAndImage();
  const superLong = 'penjelasan yang sangat panjang sekali sehingga pasti melebihi lebar margin kanan halaman A4 dan menyebabkan luapan teks pada tata letak PDF tetap';

  // Without shorter revision callback -> safely flagged as text_overflow
  const overflowRes = await applyPdfEdits(originalBuf, [
    { snippet: 'Dalam era modern', suggestion: superLong },
  ]);
  assert.equal(overflowRes.modified, false);
  assert.equal(overflowRes.flagged_count, 1);
  assert.equal(overflowRes.flagged_regions[0].reason, 'text_overflow');
  assert.equal(overflowRes.recommend_docx, true);

  // With shorter meaning-preserving revision callback -> fits safely without shrinking font!
  const shortRes = await applyPdfEdits(
    originalBuf,
    [{ snippet: 'Dalam era modern', suggestion: superLong }],
    { shortenRevision: async () => 'Saat ini' },
  );
  assert.equal(shortRes.modified, true);
  assert.equal(shortRes.applied_count, 1);
  assert.equal(shortRes.applied[0].font_size, 11);
});

test('PDF Editing: detects scanned image-only PDF and refuses destructive in-place editing', async () => {
  const scannedBuf = await createScannedImageOnlyPdf();
  const info = await inspectPdf(scannedBuf);
  assert.equal(info.is_scanned, true);
  assert.equal(info.pages[0].image_count, 1);

  const edited = await applyPdfEdits(scannedBuf, [
    { snippet: 'Scanned Document Page', suggestion: 'Edited Page' },
  ]);
  assert.equal(edited.modified, false);
  assert.equal(edited.flagged_count, 1);
  assert.equal(edited.recommend_docx, true);
});
