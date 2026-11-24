import test from 'node:test';
import assert from 'node:assert/strict';
import { PDFDocument, StandardFonts, rgb, PDFName } from 'pdf-lib';
import { createCanvas } from '@napi-rs/canvas';
import {
  inspectPdf,
  applyPdfEdits,
  comparePdfVisually,
  renderPdfPageToCanvas,
} from '../src/services/pdfEditor.js';
import { classifyRegionBackground } from '../src/services/pdfBackground.js';

async function createMultiLineParagraphPdf({ justified = false } = {}) {
  const doc = await PDFDocument.create();
  const font = await doc.embedFont(StandardFonts.Helvetica);
  const bold = await doc.embedFont(StandardFonts.HelveticaBold);
  const page = doc.addPage([595, 842]);

  page.drawText('BAB I PENDAHULUAN', { x: 56, y: 780, size: 14, font: bold });

  // Multi-line paragraph (3 lines, 15pt line spacing)
  if (justified) {
    // Draw lines spanning identical left=56 and right=~490 widths to simulate justified alignment
    page.drawText('Penelitian ini menganalisis kualitas tulisan akademik mahasiswa tingkat sarjana', { x: 56, y: 740, size: 11, font });
    page.drawText('dengan membandingkan struktur paragraf serta kejelasan argumen pada laporan', { x: 56, y: 725, size: 11, font });
    page.drawText('akhir yang telah dikumpulkan oleh mahasiswa.', { x: 56, y: 710, size: 11, font });
  } else {
    page.drawText('Penelitian ini membahas kualitas tulisan akademik', { x: 56, y: 740, size: 11, font });
    page.drawText('pada laporan akhir mahasiswa secara menyeluruh', { x: 56, y: 725, size: 11, font });
    page.drawText('berdasarkan data primer.', { x: 56, y: 710, size: 11, font });
  }

  // Next paragraph placed close below to test vertical overflow protection
  page.drawText('Paragraf kedua membahas metode evaluasi yang digunakan dalam penelitian.', { x: 56, y: 675, size: 11, font });

  return Buffer.from(await doc.save({ useObjectStreams: false }));
}

async function createSubsetFontPdf({ withToUnicode = false } = {}) {
  const doc = await PDFDocument.create();
  const font = await doc.embedFont(StandardFonts.Helvetica);
  const page = doc.addPage([595, 842]);
  page.drawText('Teks dengan font subset tertanam untuk pengujian pemetaan.', { x: 56, y: 760, size: 11, font });
  await font.embed();

  for (const [, obj] of doc.context.enumerateIndirectObjects()) {
    if (obj && typeof obj.get === 'function' && String(obj.get(PDFName.of('Type'))) === '/Font') {
      obj.set(PDFName.of('BaseFont'), PDFName.of('XYZABC+CustomSerif'));
      if (withToUnicode) {
        // Real valid PDF ToUnicode CMap stream mapping ASCII 0x20-0x7E 1:1
        const cmap = [
          '/CIDInit /ProcSet findresource begin',
          '12 dict begin begincmap',
          '/CMapName /TestToUnicode def',
          '/CMapType 2 def',
          '1 begincodespacerange <00> <FF> endcodespacerange',
          '1 beginbfrange <20> <7E> <0020> endbfrange',
          'endcmap CMapName currentdict /CMap defineresource pop end end',
        ].join('\n');
        const ref = doc.context.register(doc.context.flateStream(cmap));
        obj.set(PDFName.of('ToUnicode'), ref);
      } else {
        obj.delete(PDFName.of('Encoding'));
      }
    }
  }
  return Buffer.from(await doc.save({ useObjectStreams: false }));
}

async function createBackgroundTestPdf(kind) {
  const doc = await PDFDocument.create();
  const font = await doc.embedFont(StandardFonts.Helvetica);
  const page = doc.addPage([595, 842]);

  if (kind === 'solid_color') {
    page.drawRectangle({ x: 40, y: 700, width: 515, height: 90, color: rgb(0.82, 0.9, 0.96) });
    page.drawText('Judul pada latar belakang biru muda seragam.', { x: 56, y: 740, size: 12, font, color: rgb(0.05, 0.05, 0.05) });
  } else if (kind === 'gradient') {
    // Draw a smooth vertical gradient canvas embedded as PNG behind text
    const c = createCanvas(515, 90);
    const ctx = c.getContext('2d');
    const g = ctx.createLinearGradient(0, 0, 0, 90);
    g.addColorStop(0, '#c8dff5');
    g.addColorStop(1, '#f5dec8');
    ctx.fillStyle = g;
    ctx.fillRect(0, 0, 515, 90);
    const png = await doc.embedPng(c.toBuffer('image/png'));
    page.drawImage(png, { x: 40, y: 700, width: 515, height: 90 });
    page.drawText('Judul pada latar belakang gradien halus.', { x: 56, y: 740, size: 12, font, color: rgb(0.05, 0.05, 0.05) });
  } else if (kind === 'photographic') {
    // High-variance multi-color photographic noise image behind text
    const c = createCanvas(515, 90);
    const ctx = c.getContext('2d');
    const imgData = ctx.createImageData(515, 90);
    for (let i = 0; i < imgData.data.length; i += 4) {
      const p = i / 4;
      imgData.data[i] = (p * 37) % 256;
      imgData.data[i + 1] = (p * 73 + 50) % 256;
      imgData.data[i + 2] = (p * 113 + 120) % 256;
      imgData.data[i + 3] = 255;
    }
    ctx.putImageData(imgData, 0, 0);
    const png = await doc.embedPng(c.toBuffer('image/png'));
    page.drawImage(png, { x: 40, y: 700, width: 515, height: 90 });
    page.drawText('Teks di atas foto kompleks yang memiliki banyak warna latar.', { x: 56, y: 740, size: 12, font, color: rgb(0.05, 0.05, 0.05) });
  } else if (kind === 'illustrated') {
    // Alternating high-contrast vector stripes behind text (illustration/graphic)
    for (let x = 40; x < 550; x += 8) {
      page.drawRectangle({ x, y: 700, width: 4, height: 90, color: rgb(0.2, 0.4, 0.7) });
    }
    page.drawText('Teks di atas ilustrasi grafis bergaris.', { x: 56, y: 740, size: 12, font, color: rgb(0, 0, 0) });
  }

  return Buffer.from(await doc.save({ useObjectStreams: false }));
}

// ---- Subset Font & Multi-Line PDF Tests ----

test('Subset Fonts: distinguishes incomplete ToUnicode mapping from subset_with_tounicode and never silently substitutes', async () => {
  const incompleteBuf = await createSubsetFontPdf({ withToUnicode: false });
  const incInfo = await inspectPdf(incompleteBuf);
  assert.equal(incInfo.has_subset_fonts, true);
  assert.equal(incInfo.has_incomplete_font_mapping, true);
  assert.equal(incInfo.fonts[0].mapping_status, 'subset_incomplete_mapping');

  // Even if allowCompatibleSubstitution=true, incomplete ToUnicode MUST still be rejected!
  const incEdit = await applyPdfEdits(incompleteBuf, [{ snippet: 'font subset', suggestion: 'font standar' }], { allowCompatibleSubstitution: true });
  assert.equal(incEdit.modified, false);
  assert.equal(incEdit.flagged_regions[0].reason, 'incomplete_tounicode_mapping');

  const withToUniBuf = await createSubsetFontPdf({ withToUnicode: true });
  const toUniInfo = await inspectPdf(withToUniBuf);
  assert.equal(toUniInfo.fonts[0].mapping_status, 'subset_with_tounicode');
  assert.equal(toUniInfo.fonts[0].text_extractable_reliably, true);

  // Default rejects silent substitution
  const defaultEdit = await applyPdfEdits(withToUniBuf, [{ snippet: 'font subset', suggestion: 'font standar' }]);
  assert.equal(defaultEdit.modified, false);
  assert.equal(defaultEdit.flagged_regions[0].reason, 'subset_font_unsafe');

  // Explicit opt-in allows compatible substitution and marks font_substituted=true
  const optInEdit = await applyPdfEdits(withToUniBuf, [{ snippet: 'font subset', suggestion: 'font standar' }], { allowCompatibleSubstitution: true });
  assert.equal(optInEdit.modified, true);
  assert.equal(optInEdit.applied[0].font_substituted, true);
});

test('Multi-line PDF: groups paragraphs, detects alignment & line spacing, wraps multi-line edits, and rejects vertical overflow', async () => {
  const paraBuf = await createMultiLineParagraphPdf({ justified: false });
  const info = await inspectPdf(paraBuf);
  assert.ok(info.paragraphs.length >= 2);
  const firstPara = info.paragraphs.find((p) => p.text.includes('kualitas tulisan akademik'));
  assert.ok(firstPara);
  assert.equal(firstPara.line_count, 3);
  assert.equal(firstPara.line_spacing, 15);

  // Edit spanning across line 1 & line 2
  const edited = await applyPdfEdits(paraBuf, [{
    snippet: 'kualitas tulisan akademik pada laporan akhir mahasiswa secara menyeluruh',
    suggestion: 'mutu penulisan ilmiah pada laporan akhir mahasiswa secara sistematis',
  }]);
  assert.equal(edited.modified, true);
  assert.equal(edited.applied[0].mode, 'multi_line_paragraph');
  assert.ok(edited.applied[0].line_count >= 2);

  // Long paragraph causing vertical overflow into paragraph 2 MUST be rejected safely!
  const overflowEdit = await applyPdfEdits(paraBuf, [{
    snippet: 'kualitas tulisan akademik pada laporan akhir mahasiswa secara menyeluruh berdasarkan data primer.',
    suggestion: 'mutu penulisan ilmiah yang dianalisis secara mendalam '.repeat(12),
  }]);
  assert.equal(overflowEdit.modified, false);
  assert.equal(overflowEdit.flagged_regions[0].reason, 'paragraph_vertical_overflow');
  assert.equal(overflowEdit.recommend_docx, true);

  // Justified paragraph detection
  const justBuf = await createMultiLineParagraphPdf({ justified: true });
  const justInfo = await inspectPdf(justBuf);
  const justPara = justInfo.paragraphs.find((p) => p.text.includes('menganalisis kualitas tulisan'));
  assert.equal(justPara.alignment, 'justified');
});

// ---- Complex Background Classification & Restoration Tests ----

test('Background Restoration: solid colored background is matched accurately with ZERO white-patch artifacts', async () => {
  const solidBuf = await createBackgroundTestPdf('solid_color');
  const edited = await applyPdfEdits(solidBuf, [{
    snippet: 'biru muda seragam',
    suggestion: 'berwarna seragam',
  }]);

  assert.equal(edited.modified, true);
  assert.equal(edited.applied[0].background_type, 'uniform_colored');
  assert.equal(edited.applied[0].restoration_mode, 'solid_color');

  const visual = await comparePdfVisually(solidBuf, edited.buffer, { scale: 0.75, editedRegions: edited.applied });
  assert.equal(visual.white_patch_artifacts_detected, false);
  assert.equal(visual.layout_preserved, true);
  assert.ok(visual.average_visual_similarity_percent > 96);
});

test('Background Restoration: simple gradient background uses interpolated gradient patch without white rectangle', async () => {
  const gradBuf = await createBackgroundTestPdf('gradient');
  const edited = await applyPdfEdits(gradBuf, [{
    snippet: 'gradien halus',
    suggestion: 'gradasi lembut',
  }]);

  assert.equal(edited.modified, true);
  assert.equal(edited.applied[0].background_type, 'simple_gradient');
  assert.equal(edited.applied[0].restoration_mode, 'gradient_patch_png');

  const visual = await comparePdfVisually(gradBuf, edited.buffer, { scale: 0.75, editedRegions: edited.applied });
  assert.equal(visual.white_patch_artifacts_detected, false);
  assert.equal(visual.layout_preserved, true);
});

test('Background Restoration: photographic and illustrated backgrounds are safely rejected to protect original visual integrity', async () => {
  const photoBuf = await createBackgroundTestPdf('photographic');
  const photoEdit = await applyPdfEdits(photoBuf, [{
    snippet: 'foto kompleks',
    suggestion: 'gambar latar',
  }]);
  assert.equal(photoEdit.modified, false);
  assert.equal(photoEdit.flagged_regions[0].reason, 'complex_background_unsafe');
  assert.equal(photoEdit.flagged_regions[0].background_type, 'photographic');
  assert.equal(photoEdit.recommend_docx, true);

  const illusBuf = await createBackgroundTestPdf('illustrated');
  const illusEdit = await applyPdfEdits(illusBuf, [{
    snippet: 'ilustrasi grafis bergaris',
    suggestion: 'grafis vektor',
  }]);
  assert.equal(illusEdit.modified, false);
  assert.equal(illusEdit.flagged_regions[0].reason, 'complex_background_unsafe');
  assert.equal(illusEdit.flagged_regions[0].background_type, 'illustrated_or_graphical');

  // Direct classifier check for scanned_document
  const render = await renderPdfPageToCanvas(photoBuf, 1, 0.5);
  const scannedClass = classifyRegionBackground(render, { x: 56, y: 740, width: 120, height: 14 }, 842, 0.5, { isScanned: true });
  assert.equal(scannedClass.type, 'scanned_document');
  assert.equal(scannedClass.safe_to_restore, false);
});
