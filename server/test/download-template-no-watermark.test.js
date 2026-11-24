import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import request from 'supertest';
import JSZip from 'jszip';
import { PDFDocument, StandardFonts, rgb } from 'pdf-lib';
import { createCanvas } from '@napi-rs/canvas';
import { inspectPdf, comparePdfVisually } from '../src/services/pdfEditor.js';
import { buildPdf } from '../src/services/pdf.js';
import { convertDocxBufferToPdf } from '../src/services/docxToPdf.js';
import { getOriginalUpload } from '../src/services/fileStore.js';

process.env.NODE_ENV = 'test';
process.env.RATE_LIMIT_AUTH_MAX = '1000';
process.env.RATE_LIMIT_ANALYSIS_MAX = '1000';
process.env.JWT_ACCESS_SECRET = 'test-secret-yang-cukup-panjang-32-karakter';

const { createApp } = await import('../src/app.js');
const { tokenTransactions, users } = await import('../src/repositories/index.js');

// Mock local OpenAI-compatible AI server for end-to-end download tests
let aiResponseFactory = () => ({ issues: [] });
const mockAiServer = http.createServer((req, res) => {
  let raw = '';
  req.on('data', (c) => { raw += c; });
  req.on('end', () => {
    const body = JSON.parse(raw || '{}');
    const userPrompt = body.messages?.[1]?.content || '';
    const m = userPrompt.match(/<<<\n([\s\S]*?)\n>>>/);
    const text = m ? m[1] : '';
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({
      choices: [{ message: { content: JSON.stringify(aiResponseFactory(text)) } }],
    }));
  });
});
await new Promise((resolve) => mockAiServer.listen(0, '127.0.0.1', resolve));
const mockPort = mockAiServer.address().port;

process.env.AI_PROVIDER = '9router';
process.env.AI_BASE_URL = `http://127.0.0.1:${mockPort}/v1`;
process.env.AI_API_KEY = 'test-key';
process.env.AI_MODEL = 'test/model';

test.after(() => mockAiServer.close());

const app = createApp();

async function createAuthedUserWithTokens(tokens = 20) {
  const email = `dltest_${Date.now()}_${Math.random().toString(16).slice(2, 6)}@runut.test`;
  const reg = await request(app).post('/api/auth/register').send({
    name: 'Penguji Unduhan',
    email,
    password: 'Password123!',
  });
  assert.equal(reg.status, 201);
  const user = await users.findByEmail(email);
  await tokenTransactions.credit({
    user_id: user.id,
    amount: tokens,
    type: 'purchase',
    description: 'Test credit',
  });
  return { token: reg.body.accessToken, user };
}

async function createInstitutionalReportPdf() {
  const doc = await PDFDocument.create();
  doc.setTitle('Laporan Resmi Universitas Nusantara');
  doc.setAuthor('Tim Peneliti Nusantara');
  const font = await doc.embedFont(StandardFonts.Helvetica);
  const bold = await doc.embedFont(StandardFonts.HelveticaBold);

  const page = doc.addPage([595, 842]);
  // Institutional header banner + original user watermark that MUST be preserved!
  page.drawRectangle({ x: 40, y: 775, width: 515, height: 40, color: rgb(0.9, 0.94, 0.98) });
  page.drawText('CONFIDENTIAL - UNIVERSITAS NUSANTARA', { x: 56, y: 790, size: 12, font: bold, color: rgb(0.1, 0.2, 0.4) });

  // Institutional logo image
  const canvas = createCanvas(60, 30);
  const ctx = canvas.getContext('2d');
  ctx.fillStyle = '#0B3D91';
  ctx.fillRect(0, 0, 60, 30);
  const logo = await doc.embedPng(canvas.toBuffer('image/png'));
  page.drawImage(logo, { x: 480, y: 780, width: 60, height: 30 });

  // Editable body paragraph (>= 20 words)
  page.drawText('Dalam era modern, sistem informasi akademik membantu pengelolaan data', { x: 56, y: 720, size: 11, font });
  page.drawText('penelitian mahasiswa dan dosen secara terstruktur pada setiap semester', { x: 56, y: 702, size: 11, font });
  page.drawText('dengan standar dokumentasi nasional yang berlaku saat ini.', { x: 56, y: 684, size: 11, font });

  // Table grid
  page.drawRectangle({ x: 56, y: 610, width: 260, height: 42, borderColor: rgb(0, 0, 0), borderWidth: 1 });
  page.drawText('Akurasi Sistem: 97.5%', { x: 64, y: 626, size: 10, font: bold });

  return Buffer.from(await doc.save({ useObjectStreams: false }));
}

test('End-to-End PDF Download: preserves original uploaded PDF template, logo, table, user watermark, and has ZERO RUNUT watermark/branding', async () => {
  const { token } = await createAuthedUserWithTokens(20);
  const origPdf = await createInstitutionalReportPdf();

  aiResponseFactory = (text) => {
    const snippet = 'Dalam era modern';
    const start = text.indexOf(snippet);
    return {
      issues: start >= 0 ? [{
        type: 'formality',
        start,
        end: start + snippet.length,
        text: snippet,
        explanation: 'Pembuka generik dapat diringkas.',
        suggestion: 'Saat ini',
        needs_review: false,
      }] : [],
    };
  };

  // 1. Upload original PDF & run analysis
  const analyzeRes = await request(app)
    .post('/api/analysis')
    .set('Authorization', `Bearer ${token}`)
    .field('ai_consent', 'true')
    .field('title', 'Laporan Resmi Universitas')
    .attach('file', origPdf, { filename: 'laporan-resmi.pdf', contentType: 'application/pdf' });

  assert.equal(analyzeRes.status, 201);
  const docId = analyzeRes.body.document.id;
  const issueId = analyzeRes.body.issues[0].id;

  // 2. Approve the text edit
  const patchRes = await request(app)
    .patch(`/api/documents/${docId}/issues`)
    .set('Authorization', `Bearer ${token}`)
    .send({ decisions: [{ id: issueId, decision: 'applied' }] });
  assert.equal(patchRes.status, 200);

  // 3. Download edited PDF
  const dlRes = await request(app)
    .get(`/api/documents/${docId}/download?format=pdf`)
    .set('Authorization', `Bearer ${token}`)
    .buffer(true)
    .parse((res, cb) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => cb(null, Buffer.concat(chunks)));
    });

  assert.equal(dlRes.status, 200);
  assert.equal(dlRes.headers['x-preservation-mode'], 'pdf-inplace-preserved');
  assert.equal(dlRes.headers['x-preservation-verified'], 'true');

  const downloadedPdf = dlRes.body;
  const inspected = await inspectPdf(downloadedPdf);

  // Revised text applied, original user watermark & table & image & dimensions preserved!
  assert.ok(inspected.text.includes('Saat ini, sistem informasi akademik'));
  assert.ok(inspected.text.includes('CONFIDENTIAL - UNIVERSITAS NUSANTARA'));
  assert.ok(inspected.text.includes('Akurasi Sistem: 97.5%'));
  assert.equal(inspected.pages[0].image_count, 1);
  assert.equal(inspected.page_dimensions[0].width, 595);
  assert.equal(inspected.page_dimensions[0].height, 842);

  // ZERO RUNUT watermark, footer, or creator metadata!
  assert.ok(!/runut/i.test(inspected.text), 'Downloaded PDF text must not contain RUNUT watermark or footer');
  const loadedMod = await PDFDocument.load(downloadedPdf);
  assert.ok(!/runut/i.test(String(loadedMod.getCreator() || '')), 'PDF Creator metadata must not be Runut');
  assert.equal(loadedMod.getAuthor(), 'Tim Peneliti Nusantara');

  // Visual comparison confirms layout preservation
  const visual = await comparePdfVisually(origPdf, downloadedPdf, { scale: 0.5 });
  assert.equal(visual.layout_preserved, true);
  assert.ok(visual.average_visual_similarity_percent > 95);

  // Original uploaded PDF in fileStore remains byte-for-byte immutable!
  const storedOrig = getOriginalUpload(docId);
  assert.ok(Buffer.compare(storedOrig.buffer, origPdf) === 0);

  // Separate analysis report endpoint never mixes with document download
  const reportRes = await request(app)
    .get(`/api/documents/${docId}/analysis-report`)
    .set('Authorization', `Bearer ${token}`);
  assert.equal(reportRes.status, 200);
  assert.equal(reportRes.body.report_type, 'runut_analysis_report');
});

test('Unsafe PDF edit NEVER falls back to generic plain-text PDF — retains untouched original PDF instead', async () => {
  const { token } = await createAuthedUserWithTokens(20);
  const origPdf = await createInstitutionalReportPdf();

  // Propose an edit that overflows line width severely
  aiResponseFactory = (text) => {
    const snippet = 'Dalam era modern';
    const start = text.indexOf(snippet);
    return {
      issues: start >= 0 ? [{
        type: 'formality',
        start,
        end: start + snippet.length,
        text: snippet,
        explanation: 'Revisi sangat panjang untuk uji overflow.',
        suggestion: 'Pada era transformasi digital yang sangat panjang sekali melebihi seluruh lebar halaman A4 laporan akademik universitas saat ini',
        needs_review: false,
      }] : [],
    };
  };

  const analyzeRes = await request(app)
    .post('/api/analysis')
    .set('Authorization', `Bearer ${token}`)
    .field('ai_consent', 'true')
    .attach('file', origPdf, { filename: 'laporan-overflow.pdf', contentType: 'application/pdf' });

  const docId = analyzeRes.body.document.id;
  await request(app)
    .patch(`/api/documents/${docId}/issues`)
    .set('Authorization', `Bearer ${token}`)
    .send({ decisions: [{ id: analyzeRes.body.issues[0].id, decision: 'applied' }] });

  const dlRes = await request(app)
    .get(`/api/documents/${docId}/download?format=pdf`)
    .set('Authorization', `Bearer ${token}`)
    .buffer(true)
    .parse((res, cb) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => cb(null, Buffer.concat(chunks)));
    });

  assert.equal(dlRes.status, 200);
  assert.equal(dlRes.headers['x-preservation-mode'], 'original-retained-unsafe-edit');
  assert.equal(dlRes.headers['x-recommend-docx'], 'true');
  // Returned PDF is byte-identical to original uploaded PDF — NOT a generic fallback PDF!
  assert.ok(Buffer.compare(dlRes.body, origPdf) === 0);
});

test('Plain-text PDF & DOCX exports contain ZERO RUNUT watermarks, footers, or creator branding', async () => {
  const pdfBuf = await buildPdf({
    title: '',
    meta: '',
    body: 'Ini adalah dokumen teks polos milik pengguna yang tidak boleh mengandung watermark aplikasi apapun.',
  });
  const pdfInfo = await inspectPdf(pdfBuf);
  assert.ok(!/runut/i.test(pdfInfo.text));
  const loaded = await PDFDocument.load(pdfBuf);
  assert.ok(!/runut/i.test(String(loaded.getCreator() || '')));

  // DOCX-to-PDF conversion helper works cleanly with custom converter
  const fakeDocx = await new JSZip().file('word/document.xml', '<w:document/>').generateAsync({ type: 'nodebuffer' });
  const conv = await convertDocxBufferToPdf(fakeDocx, { converter: async () => pdfBuf });
  assert.equal(conv.ok, true);
  assert.ok(Buffer.compare(conv.buffer, pdfBuf) === 0);
});
