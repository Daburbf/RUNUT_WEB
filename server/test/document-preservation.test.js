import test from 'node:test';
import assert from 'node:assert/strict';
import JSZip from 'jszip';
import { PDFDocument } from 'pdf-lib';
import { inspectDocx, applyDocxEdits, verifyDocxPreservation } from '../src/services/docxEditor.js';
import { inspectPdf, evaluatePdfTextOverflow } from '../src/services/pdfEditor.js';
import { buildPdf } from '../src/services/pdf.js';

// Build a rich realistic DOCX fixture with cover page, TOC (w:sdt), multi-run formatted paragraph,
// table, image (word/media/logo.png), header, footer, footnotes, styles, sectPr margins, and bibliography.
async function createRichDocxFixture() {
  const zip = new JSZip();
  zip.file('[Content_Types].xml', `<?xml version="1.0" encoding="UTF-8"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">
  <Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>
  <Default Extension="xml" ContentType="application/xml"/>
  <Default Extension="png" ContentType="image/png"/>
  <Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/>
</Types>`);

  zip.file('_rels/.rels', `<?xml version="1.0" encoding="UTF-8"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
  <Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/>
</Relationships>`);

  zip.file('word/styles.xml', `<?xml version="1.0" encoding="UTF-8"?>
<w:styles xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">
  <w:style w:type="paragraph" w:styleId="Heading1"><w:name w:val="heading 1"/></w:style>
</w:styles>`);

  zip.file('word/header1.xml', `<?xml version="1.0" encoding="UTF-8"?>
<w:hdr xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">
  <w:p><w:r><w:t>UNIVERSITAS TEKNOLOGI - LAPORAN AKHIR</w:t></w:r></w:p>
</w:hdr>`);

  zip.file('word/footer1.xml', `<?xml version="1.0" encoding="UTF-8"?>
<w:ftr xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">
  <w:p><w:r><w:t>Halaman 1</w:t></w:r></w:p>
</w:ftr>`);

  zip.file('word/footnotes.xml', `<?xml version="1.0" encoding="UTF-8"?>
<w:footnotes xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">
  <w:footnote w:id="1"><w:p><w:r><w:t>Catatan kaki metodologi penelitian.</w:t></w:r></w:p></w:footnote>
</w:footnotes>`);

  // Fake PNG binary for institutional logo
  zip.file('word/media/logo.png', Buffer.from([0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A, 0x00, 0x01, 0x02]));

  zip.file('word/document.xml', `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"
            xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">
  <w:body>
    <w:p>
      <w:pPr><w:jc w:val="center"/></w:pPr>
      <w:r><w:rPr><w:b/><w:sz w:val="32"/></w:rPr><w:t>LAPORAN PENELITIAN AKADEMIK</w:t></w:r>
    </w:p>
    <w:sdt>
      <w:sdtContent>
        <w:p><w:r><w:t>DAFTAR ISI - BAB I PENDAHULUAN .... 1</w:t></w:r></w:p>
      </w:sdtContent>
    </w:sdt>
    <w:p>
      <w:pPr><w:pStyle w:val="Heading1"/></w:pPr>
      <w:r><w:t>BAB I PENDAHULUAN</w:t></w:r>
    </w:p>
    <w:p>
      <w:pPr><w:spacing w:line="360" w:lineRule="auto"/></w:pPr>
      <w:r><w:rPr><w:rFonts w:ascii="Times New Roman"/><w:sz w:val="24"/></w:rPr><w:t xml:space="preserve">Dalam era perkembangan teknologi saat ini, </w:t></w:r>
      <w:r><w:rPr><w:i/><w:rFonts w:ascii="Times New Roman"/><w:sz w:val="24"/></w:rPr><w:t>sistem informasi</w:t></w:r>
      <w:r><w:rPr><w:rFonts w:ascii="Times New Roman"/><w:sz w:val="24"/></w:rPr><w:t xml:space="preserve"> membantu pengelolaan data akademik secara cepat.</w:t></w:r>
    </w:p>
    <w:tbl>
      <w:tblPr><w:tblW w:w="8000" w:type="dxa"/></w:tblPr>
      <w:tr>
        <w:tc><w:p><w:r><w:t>Metrik</w:t></w:r></w:p></w:tc>
        <w:tc><w:p><w:r><w:t>95,4%</w:t></w:r></w:p></w:tc>
      </w:tr>
    </w:tbl>
    <w:p>
      <w:pPr><w:pStyle w:val="Heading1"/></w:pPr>
      <w:r><w:t>Daftar Pustaka</w:t></w:r>
    </w:p>
    <w:p>
      <w:r><w:t>Santoso, B. (2021). Sistem Informasi Akademik. Jurnal Teknologi, 12(1), 10-20.</w:t></w:r>
    </w:p>
    <w:sectPr>
      <w:pgSz w:w="11906" w:h="16838"/>
      <w:pgMar w:top="1701" w:right="1701" w:bottom="1701" w:left="2268"/>
    </w:sectPr>
  </w:body>
</w:document>`);

  return zip.generateAsync({ type: 'nodebuffer' });
}

test('DOCX Preservation: inspects cover page, TOC, headings, multi-run paragraphs, tables, images, headers, footers, footnotes, and bibliography', async () => {
  const docxBuf = await createRichDocxFixture();
  const inspected = await inspectDocx(docxBuf);

  assert.equal(inspected.metadata.format, 'docx');
  assert.equal(inspected.metadata.tables_count, 1);
  assert.equal(inspected.metadata.images_count, 1);
  assert.equal(inspected.metadata.headers_count, 1);
  assert.equal(inspected.metadata.footers_count, 1);
  assert.equal(inspected.metadata.has_footnotes, true);
  assert.equal(inspected.metadata.has_styles, true);
  assert.equal(inspected.metadata.bibliography_detected, true);

  // TOC (w:sdt) and bibliography entries must be marked protected
  const tocBlock = inspected.blocks.find((b) => b.text.includes('DAFTAR ISI'));
  assert.equal(tocBlock.protected, true);
  assert.equal(tocBlock.protection_reason, 'structured_document_tag');

  const bibBlock = inspected.blocks.find((b) => b.text.includes('Santoso, B.'));
  assert.equal(bibBlock.protected, true);
  assert.equal(bibBlock.protection_reason, 'bibliography');
});

test('DOCX Preservation: edits ONLY approved text in-place while preserving fonts, runs, tables, images, headers, footers, margins, and bibliography', async () => {
  const originalBuf = await createRichDocxFixture();

  const edited = await applyDocxEdits(originalBuf, {
    issueEdits: [
      {
        snippet: 'Dalam era perkembangan teknologi saat ini',
        suggestion: 'Saat ini',
      },
      // Attempt to edit bibliography — MUST be skipped/protected!
      {
        snippet: 'Santoso, B. (2021)',
        suggestion: 'HACKED AUTHOR',
      },
    ],
  });

  assert.equal(edited.applied_count, 1);
  assert.equal(edited.skipped_count, 1);
  assert.equal(edited.verification.verified, true);
  assert.equal(edited.verification.checks.original_formatting_preserved, true);
  assert.equal(edited.verification.checks.tables_preserved, true);
  assert.equal(edited.verification.checks.images_preserved, true);
  assert.equal(edited.verification.checks.headers_footers_preserved, true);
  assert.equal(edited.verification.checks.bibliography_preserved, true);
  assert.equal(edited.verification.checks.page_configuration_preserved, true);
  assert.equal(edited.verification.checks.footnotes_preserved, true);

  // Verify edited text is present, italic run 'sistem informasi' still intact, and bibliography untouched
  const after = await inspectDocx(edited.buffer);
  assert.ok(after.text.includes('Saat ini, sistem informasi membantu pengelolaan data akademik secara cepat.'));
  assert.ok(after.text.includes('Santoso, B. (2021). Sistem Informasi Akademik.'));
  assert.ok(!after.text.includes('HACKED AUTHOR'));

  // Verify <w:i/> run formatting inside the edited paragraph is still preserved
  const modZip = await JSZip.loadAsync(edited.buffer);
  const modXml = await modZip.file('word/document.xml').async('string');
  assert.ok(modXml.includes('<w:i/>'));
  assert.ok(modXml.includes('Times New Roman'));
  assert.ok(modXml.includes('w:left="2268"'));
});

test('DOCX Preservation: verifyDocxPreservation detects tampered margins', async () => {
  const originalBuf = await createRichDocxFixture();
  const zip = await JSZip.loadAsync(originalBuf);
  const xml = await zip.file('word/document.xml').async('string');
  zip.file('word/document.xml', xml.replace('w:left="2268"', 'w:left="1440"'));
  const tamperedBuf = await zip.generateAsync({ type: 'nodebuffer' });

  const verification = await verifyDocxPreservation(originalBuf, tamperedBuf);
  assert.equal(verification.verified, false);
  assert.equal(verification.checks.page_configuration_preserved, false);
});

test('PDF Preservation: distinguishes editable PDF from scanned image-only PDF and flags text overflow', async () => {
  // 1. Editable PDF
  const editablePdfBuf = await buildPdf({
    title: 'Laporan Penelitian',
    meta: '2026',
    body: 'Penelitian ini membahas efektivitas metode pembelajaran aktif pada mahasiswa tingkat sarjana di berbagai perguruan tinggi.',
  });
  const editableInfo = await inspectPdf(editablePdfBuf);
  assert.equal(editableInfo.format, 'pdf');
  assert.equal(editableInfo.page_count, 1);
  assert.equal(editableInfo.is_scanned, false);
  assert.equal(editableInfo.editable_status, 'editable_fixed_layout');

  // 2. Scanned / image-only PDF (page with no text layer)
  const scannedDoc = await PDFDocument.create();
  scannedDoc.addPage([595, 842]);
  const scannedBuf = Buffer.from(await scannedDoc.save());
  const scannedInfo = await inspectPdf(scannedBuf);
  assert.equal(scannedInfo.page_count, 1);
  assert.equal(scannedInfo.is_scanned, true);
  assert.equal(scannedInfo.editable_status, 'scanned_image_only');
  assert.match(scannedInfo.recommendation, /DOCX/i);

  // 3. Overflow evaluation
  const overflow = evaluatePdfTextOverflow([
    {
      snippet: 'Singkat saja.',
      suggestion: 'Kalimat revisi yang dibuat jauh lebih panjang daripada teks asli sehingga berisiko meluap dari kotak teks PDF.',
    },
  ]);
  assert.equal(overflow.has_overflow_risk, true);
  assert.equal(overflow.overflow_flags.length, 1);
});
