import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import request from 'supertest';
import JSZip from 'jszip';
import { PDFDocument, StandardFonts, rgb } from 'pdf-lib';

process.env.NODE_ENV = 'test';
process.env.RATE_LIMIT_AUTH_MAX = '1000';
process.env.RATE_LIMIT_ANALYSIS_MAX = '1000';
process.env.RATE_LIMIT_EXPORT_MAX = '1000';
process.env.JWT_ACCESS_SECRET = 'template-preservation-complete-secret-32c';

const { createApp } = await import('../src/app.js');
const { tokenTransactions } = await import('../src/repositories/index.js');
const { deleteOriginalUpload } = await import('../src/services/fileStore.js');
const { applyDocxEdits } = await import('../src/services/docxEditor.js');
const {
  hasOleDocMagic,
  convertDocBufferToDocx,
  validateGeneratedPdf,
} = await import('../src/services/docxToPdf.js');

const app = createApp();

let aiServer;
test.before(async () => {
  aiServer = http.createServer((req, res) => {
    let body = '';
    req.on('data', (c) => { body += c; });
    req.on('end', () => {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ model: 'mock/test:free', choices: [{ message: { content: '{"issues":[]}' } }] }));
    });
  });
  await new Promise((resolve) => aiServer.listen(0, '127.0.0.1', resolve));
  process.env.AI_PROVIDER = 'openrouter';
  process.env.AI_BASE_URL = `http://127.0.0.1:${aiServer.address().port}`;
  process.env.AI_API_KEY = 'test-key';
  process.env.AI_MODEL = 'mock/test:free';
});

test.after(async () => {
  await new Promise((resolve) => aiServer.close(resolve));
});

async function buildRichDocxBuffer() {
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
  <Relationship Id="rIdStyle" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/>
  <Relationship Id="rIdLink1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/hyperlink" Target="https://example.org/referensi" TargetMode="External"/>
</Relationships>`);
  zip.file('word/styles.xml', `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<w:styles xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">
  <w:style w:type="paragraph" w:styleId="Normal"><w:name w:val="Normal"/></w:style>
</w:styles>`);
  zip.file('word/header1.xml', `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<w:hdr xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">
  <w:p><w:r><w:t>HEADER RESMI TEMPLATE</w:t></w:r></w:p>
</w:hdr>`);
  zip.file('word/document.xml', `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">
  <w:body>
    <w:p>
      <w:pPr><w:pStyle w:val="Normal"/></w:pPr>
      <w:r><w:rPr><w:b/></w:rPr><w:t xml:space="preserve">Penelitian ini </w:t></w:r>
      <w:r><w:t xml:space="preserve">membahas evaluasi sistem manajemen pembelajaran di perguruan tinggi menggunakan pendekatan terstruktur agar kualitas layanan akademik tetap terjaga dengan baik dan menyeluruh.</w:t></w:r>
    </w:p>
    <w:p>
      <w:hyperlink r:id="rIdLink1">
        <w:r><w:t>Tautan Referensi Resmi</w:t></w:r>
      </w:hyperlink>
    </w:p>
    <w:tbl>
      <w:tr><w:tc><w:p><w:r><w:t>Sel Tabel Template</w:t></w:r></w:p></w:tc></w:tr>
    </w:tbl>
    <w:sectPr><w:pgSz w:w="11906" w:h="16838"/></w:sectPr>
  </w:body>
</w:document>`);
  return zip.generateAsync({ type: 'nodebuffer' });
}

async function buildSamplePdfBuffer() {
  const pdfDoc = await PDFDocument.create();
  const page = pdfDoc.addPage([595.28, 841.89]);
  const font = await pdfDoc.embedFont(StandardFonts.Helvetica);
  page.drawText(
    'Laporan analisis kualitas layanan sistem informasi akademik kampus ini disusun berdasarkan hasil observasi lapangan serta wawancara langsung bersama pengelola dan mahasiswa aktif selama semester berjalan.',
    { x: 50, y: 760, size: 11, font, color: rgb(0, 0, 0), maxWidth: 495 },
  );
  return Buffer.from(await pdfDoc.save());
}

async function createAuthedUser(tokens = 10) {
  const email = `tpl-${Date.now()}-${Math.random().toString(16).slice(2, 7)}@runut.test`;
  const reg = await request(app).post('/api/auth/register').send({
    name: 'Uji Preservasi',
    email,
    password: 'Password123!',
  });
  assert.equal(reg.status, 201);
  await tokenTransactions.credit({
    user_id: reg.body.user.id,
    amount: tokens,
    type: 'purchase',
    description: 'Saldo uji preservasi template',
  });
  return { token: reg.body.accessToken, userId: reg.body.user.id };
}

function binaryParser(res, callback) {
  const chunks = [];
  res.on('data', (c) => chunks.push(c));
  res.on('end', () => callback(null, Buffer.concat(chunks)));
}

test('Legacy .DOC: hasOleDocMagic dan convertDocBufferToDocx memvalidasi signature, konversi hook, dan ketiadaan LibreOffice', async () => {
  const invalidBuf = Buffer.from('Bukan file DOC OLE', 'utf8');
  assert.equal(hasOleDocMagic(invalidBuf), false);
  const badRes = await convertDocBufferToDocx(invalidBuf);
  assert.equal(badRes.ok, false);
  assert.equal(badRes.code, 'INVALID_DOC_SIGNATURE');

  const fakeOleDoc = Buffer.concat([
    Buffer.from([0xD0, 0xCF, 0x11, 0xE0, 0xA1, 0xB1, 0x1A, 0xE1]),
    Buffer.alloc(64, 0),
  ]);
  assert.equal(hasOleDocMagic(fakeOleDoc), true);

  const validDocx = await buildRichDocxBuffer();
  const okRes = await convertDocBufferToDocx(fakeOleDoc, {
    converter: async () => validDocx,
  });
  assert.equal(okRes.ok, true);
  assert.equal(okRes.engine, 'custom');
  assert.ok(Buffer.isBuffer(okRes.buffer));

  const unavailableRes = await convertDocBufferToDocx(fakeOleDoc, {
    env: { LIBREOFFICE_PATH: '' },
    fileExists: () => false,
    execRunner: async () => { throw new Error('ENOENT'); },
  });
  assert.equal(unavailableRes.ok, false);
  assert.equal(unavailableRes.code, 'DOC_CONVERTER_UNAVAILABLE');
});

test('DOCX Preservation: mempertahankan hyperlink, tabel, header, style, dan mengembalikan classification "preserved"', async () => {
  const origDocx = await buildRichDocxBuffer();
  const result = await applyDocxEdits(origDocx, {
    issueEdits: [
      { snippet: 'pendekatan terstruktur', suggestion: 'pendekatan sistematis' },
    ],
  });

  assert.equal(result.applied_count, 1);
  assert.equal(result.verification.verified, true);
  assert.equal(result.verification.classification, 'preserved');
  assert.equal(result.verification.checks.hyperlinks_preserved, true);
  assert.equal(result.verification.checks.tables_preserved, true);
  assert.equal(result.verification.checks.headers_footers_preserved, true);
  assert.equal(result.verification.checks.original_formatting_preserved, true);

  const outZip = await JSZip.loadAsync(result.buffer);
  const relsXml = await outZip.file('word/_rels/document.xml.rels').async('string');
  assert.ok(relsXml.includes('https://example.org/referensi'));
  const docXml = await outZip.file('word/document.xml').async('string');
  assert.ok(docXml.includes('pendekatan sistematis'));
});

test('PDF Validation: validateGeneratedPdf memverifikasi halaman dan dimensi halaman positif', async () => {
  const pdfBuf = await buildSamplePdfBuffer();
  const valid = await validateGeneratedPdf(pdfBuf);
  assert.equal(valid.valid, true);
  assert.equal(valid.page_count, 1);
  assert.equal(valid.page_dimensions.length, 1);
  assert.ok(valid.page_dimensions[0].width > 500);
  assert.ok(valid.page_dimensions[0].height > 800);

  const invalid = await validateGeneratedPdf(Buffer.from('not-a-pdf'));
  assert.equal(invalid.valid, false);
});

test('Route Guard: PDF unggahan tidak boleh diam-diam diekspor jadi DOCX teks polos (422 FORMAT_MISMATCH_USE_PDF)', async () => {
  const { token } = await createAuthedUser(10);
  const auth = { Authorization: `Bearer ${token}` };
  const pdfBuf = await buildSamplePdfBuffer();

  const an = await request(app)
    .post('/api/analysis')
    .set(auth)
    .field('ai_consent', 'true')
    .attach('file', pdfBuf, { filename: 'template-asli.pdf', contentType: 'application/pdf' });
  assert.equal(an.status, 201);
  const docId = an.body.document.id;

  // Unduh dalam format PDF asli -> harus preserved
  const pdfRes = await request(app)
    .get(`/api/documents/${docId}/download?format=pdf`)
    .set(auth)
    .buffer(true)
    .parse(binaryParser);
  assert.equal(pdfRes.status, 200);
  assert.equal(pdfRes.headers['x-preservation-mode'], 'original-unchanged');
  assert.equal(pdfRes.headers['x-preservation-classification'], 'preserved');

  // Unduh PDF unggahan sebagai DOCX -> wajib ditolak 422, bukan rekonstruksi DOCX polos!
  const docxRes = await request(app)
    .get(`/api/documents/${docId}/download?format=docx`)
    .set(auth);
  assert.equal(docxRes.status, 422);
  assert.equal(docxRes.body.code, 'FORMAT_MISMATCH_USE_PDF');
});

test('Route Guard: DOCX unggahan dengan file asli hilang ditolak 409 ORIGINAL_TEMPLATE_MISSING untuk DOCX & PDF (tidak fallback ke teks polos)', async () => {
  const { token } = await createAuthedUser(10);
  const auth = { Authorization: `Bearer ${token}` };
  const docxBuf = await buildRichDocxBuffer();

  const an = await request(app)
    .post('/api/analysis')
    .set(auth)
    .field('ai_consent', 'true')
    .attach('file', docxBuf, {
      filename: 'naskah-template.docx',
      contentType: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    });
  assert.equal(an.status, 201);
  const docId = an.body.document.id;

  // Selama file asli ada, ekspor DOCX mempertahankan template asli
  const okExport = await request(app)
    .get(`/api/documents/${docId}/download?format=docx`)
    .set(auth)
    .buffer(true)
    .parse(binaryParser);
  assert.equal(okExport.status, 200);
  assert.equal(okExport.headers['x-preservation-mode'], 'template-preserved');
  assert.equal(okExport.headers['x-preservation-classification'], 'preserved');

  // Simulasikan berkas template asli terhapus dari penyimpanan server
  deleteOriginalUpload(docId);

  const missingDocx = await request(app)
    .get(`/api/documents/${docId}/download?format=docx`)
    .set(auth);
  assert.equal(missingDocx.status, 409);
  assert.equal(missingDocx.body.code, 'ORIGINAL_TEMPLATE_MISSING');

  const missingPdf = await request(app)
    .get(`/api/documents/${docId}/download?format=pdf`)
    .set(auth);
  assert.equal(missingPdf.status, 409);
  assert.equal(missingPdf.body.code, 'ORIGINAL_TEMPLATE_MISSING');
});
