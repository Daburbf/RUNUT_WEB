// Real-World Multi-Domain QA, Original Template Acceptance, Persistent Storage,
// Multi-User Concurrency, and Production Smoke Tests.
import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { createHash } from 'node:crypto';
import JSZip from 'jszip';
import { PDFDocument, StandardFonts, rgb } from 'pdf-lib';
import request from 'supertest';
import { createApp } from '../src/app.js';
import { initStorage, tokenTransactions } from '../src/repositories/index.js';
import { clearMemoryFileCache } from '../src/services/fileStore.js';
import {
  detectDocumentLanguage,
  resolveWritingProfile,
} from '../src/services/prompts/writingEngine.js';
import { validateAiIssues } from '../src/services/aiValidate.js';
import { analyzeSimilarity } from '../src/services/similarity.js';
import { inspectDocx, verifyDocxPreservation } from '../src/services/docxEditor.js';
import { inspectPdf, comparePdfVisually } from '../src/services/pdfEditor.js';

function sha256(buf) {
  return createHash('sha256').update(buf).digest('hex');
}

async function buildComplexDocxWithTableImageHeaderBib() {
  const zip = new JSZip();
  const tinyPng = Buffer.from(
    'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==',
    'base64',
  );
  zip.file('[Content_Types].xml', `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">
  <Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>
  <Default Extension="xml" ContentType="application/xml"/>
  <Default Extension="png" ContentType="image/png"/>
  <Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/>
  <Override PartName="/word/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.styles+xml"/>
  <Override PartName="/word/header1.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.header+xml"/>
  <Override PartName="/word/footer1.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.footer+xml"/>
</Types>`);
  zip.file('_rels/.rels', `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
  <Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/>
</Relationships>`);
  zip.file('word/_rels/document.xml.rels', `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
  <Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/>
  <Relationship Id="rId2" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/header" Target="header1.xml"/>
  <Relationship Id="rId3" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/footer" Target="footer1.xml"/>
  <Relationship Id="rId4" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/image" Target="media/image1.png"/>
</Relationships>`);
  zip.file('word/styles.xml', `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<w:styles xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">
  <w:style w:type="paragraph" w:styleId="Heading1"><w:name w:val="heading 1"/></w:style>
</w:styles>`);
  zip.file('word/header1.xml', `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<w:hdr xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:p><w:r><w:t>UNIVERSITAS CONTOH - LAPORAN RESMI</w:t></w:r></w:p></w:hdr>`);
  zip.file('word/footer1.xml', `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<w:ftr xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:p><w:r><w:t>Halaman 1</w:t></w:r></w:p></w:ftr>`);
  zip.file('word/media/image1.png', tinyPng);
  zip.file('word/document.xml', `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">
  <w:body>
    <w:p><w:pPr><w:pStyle w:val="Heading1"/></w:pPr><w:r><w:t>BAB I PENDAHULUAN</w:t></w:r></w:p>
    <w:p><w:r><w:t xml:space="preserve">Penelitian ini mengevaluasi kinerja sistem pengolahan dokumen akademik pada 120 responden mahasiswa tahun 2026. Metode pengujian ini sangat tidak jelas pada bagian awal laporan sehingga perlu diperjelas secara ringkas dan objektif agar pembaca memahami alur evaluasi secara menyeluruh.</w:t></w:r></w:p>
    <w:tbl><w:tblPr><w:tblW w:w="8000" w:type="dxa"/></w:tblPr><w:tr><w:tc><w:p><w:r><w:t>Metrik</w:t></w:r></w:p></w:tc><w:tc><w:p><w:r><w:t>98.5%</w:t></w:r></w:p></w:tc></w:tr></w:tbl>
    <w:p><w:r><w:t>Daftar Pustaka</w:t></w:r></w:p>
    <w:p><w:r><w:t>Santoso, B. (2025). Sistem Pengolahan Dokumen Digital. Jurnal Informatika Nusantara.</w:t></w:r></w:p>
    <w:sectPr><w:pgSz w:w="11906" w:h="16838"/></w:sectPr>
  </w:body>
</w:document>`);
  return zip.generateAsync({ type: 'nodebuffer' });
}

async function buildMultiPageAcademicPdf() {
  const doc = await PDFDocument.create();
  const font = await doc.embedFont(StandardFonts.Helvetica);
  const bold = await doc.embedFont(StandardFonts.HelveticaBold);

  const p1 = doc.addPage([595.28, 841.89]);
  p1.drawText('JURNAL PENELITIAN SISTEM INFORMASI', { x: 60, y: 790, size: 11, font: bold });
  p1.drawText('Abstrak: Penelitian ini menguji preservasi tata letak dokumen PDF.', { x: 60, y: 740, size: 11, font });
  p1.drawText('Metode lama digunakan untuk mengevaluasi 45 sampel dokumen akademik.', { x: 60, y: 715, size: 11, font });
  p1.drawText('Hasil pengujian menunjukkan tingkat keutuhan tata letak mencapai 99 persen.', { x: 60, y: 690, size: 11, font });
  p1.drawText('Halaman 1', { x: 270, y: 36, size: 9, font });

  const p2 = doc.addPage([595.28, 841.89]);
  p2.drawText('BAB II METODOLOGI PENELITIAN', { x: 60, y: 790, size: 11, font: bold });
  p2.drawText('Setiap dokumen diuji menggunakan perbandingan piksel dan koordinat teks.', { x: 60, y: 740, size: 11, font });
  p2.drawText('Halaman 2', { x: 270, y: 36, size: 9, font });

  return Buffer.from(await doc.save({ useObjectStreams: false }));
}

function startMockAiServer(handler) {
  return new Promise((resolve) => {
    const server = http.createServer((req, res) => {
      let raw = '';
      req.on('data', (c) => { raw += c; });
      req.on('end', () => {
        const body = JSON.parse(raw || '{}');
        const reply = handler(body);
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({
          choices: [{ message: { content: JSON.stringify(reply) } }],
        }));
      });
    });
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address();
      resolve({ server, baseUrl: `http://127.0.0.1:${port}/v1` });
    });
  });
}

test('Part 4: Multi-domain automatic writing-context detection (Indonesian & English) without manual mode selection', () => {
  const fixtures = [
    {
      name: 'Academic thesis (ID)',
      expectedLang: 'id',
      expectedProfile: 'academic',
      text: 'ABSTRAK. Skripsi ini meneliti efektivitas metode pembelajaran adaptif. BAB I PENDAHULUAN. Rumusan masalah dan metodologi penelitian kuantitatif (Santoso, 2024). Daftar Pustaka.',
    },
    {
      name: 'Academic paper (EN)',
      expectedLang: 'en',
      expectedProfile: 'academic',
      text: 'Abstract: This empirical study investigates methodology and literature review findings in neural retrieval systems (Smith, 2024). References and statistical hypothesis evaluation are presented.',
    },
    {
      name: 'Professional email (EN)',
      expectedLang: 'en',
      notProfile: 'academic',
      text: 'Subject: Q3 Project Delivery Update. Dear Sarah, Please find attached the weekly status update for our client deliverable. Action items for Friday meeting are listed below. Best regards, Alex.',
    },
    {
      name: 'Employee report / Business proposal (ID)',
      expectedLang: 'id',
      notProfile: 'academic',
      text: 'Laporan Kinerja Karyawan Kuartal III. Ringkasan eksekutif pencapaian target penjualan tim operasional, tindak lanjut proyek klien, anggaran kuartal depan, dan rekomendasi rapat direksi.',
    },
    {
      name: 'Technical SOP (EN)',
      expectedLang: 'en',
      notProfile: 'academic',
      text: 'Standard Operating Procedure: API Deployment Runbook. Step 1: Configure environment variables and TLS certificates. Step 2: Run database migrations via CLI endpoint and verify HTTP 200 health check.',
    },
    {
      name: 'Marketing content (EN)',
      expectedLang: 'en',
      notProfile: 'academic',
      text: 'Boost your team productivity today! Discover our all-in-one campaign launch platform designed for modern brands. Sign up free now and convert more customers with effortless workflows.',
    },
  ];

  for (const fx of fixtures) {
    const lang = detectDocumentLanguage(fx.text);
    const resolved = resolveWritingProfile('auto', fx.text);
    assert.equal(lang, fx.expectedLang, `${fx.name}: expected lang=${fx.expectedLang}, got ${lang}`);
    if (fx.expectedProfile) {
      assert.equal(resolved.profile, fx.expectedProfile, `${fx.name}: expected profile=${fx.expectedProfile}, got ${resolved.profile}`);
    }
    if (fx.notProfile) {
      assert.notEqual(resolved.profile, fx.notProfile, `${fx.name}: should NOT force ${fx.notProfile} style`);
    }
    assert.ok(resolved.tone && resolved.audience && resolved.purpose, `${fx.name}: must infer tone, audience, and purpose`);
  }
});

test('Part 4D & 4E: Meaning preservation flags numerical/name mutations & separates internal repetition from external similarity', () => {
  const sourceText = 'Pada tahun 2026, Dr. Ahmad Fauzi menemukan bahwa efisiensi meningkat sebesar 42% pada 150 sampel uji.';
  const snippet = 'efisiensi meningkat sebesar 42% pada';
  const start = sourceText.indexOf(snippet);
  const aiRaw = {
    issues: [
      {
        type: 'formality',
        start,
        end: start + snippet.length,
        text: snippet,
        explanation: 'Mengubah angka untuk contoh uji.',
        suggestion: 'efisiensi meningkat sebesar 90% pada',
      },
    ],
  };
  const validated = validateAiIssues(aiRaw, sourceText);
  assert.equal(validated.valid.length, 1);
  assert.equal(validated.valid[0].needs_manual_review, true, 'Numerical mutation must be flagged for manual review');

  const repeatedText = 'Sistem pengolahan dokumen harus menjaga tata letak asli setiap halaman. Sistem pengolahan dokumen harus menjaga tata letak asli setiap halaman. Pengujian dilakukan secara objektif.';
  const sim = analyzeSimilarity(repeatedText, { referenceTexts: [], externalSources: [] });
  assert.equal(sim.corpus_compared, 'internal_only');
  assert.equal(sim.corpus_similarity_percent, null, 'Without external corpus, corpus_similarity_percent must be null (never confused with internal repetition)');
  assert.ok(sim.findings.some((f) => f.citation_status === 'internal_repetition'), 'Must detect repeated sentence as internal_repetition');
});

test('Parts 5, 8 & 9: Complete E2E acceptance (Complex DOCX + Multi-Page PDF + Persistent Storage + Cross-User Isolation + Concurrency)', async () => {
  await initStorage('', { persistPath: null });
  const mockAi = await startMockAiServer((body) => {
    const userMsg = String(body?.messages?.[1]?.content || '');
    const m = userMsg.match(/<<<\n([\s\S]*?)\n>>>/);
    const docText = m ? m[1] : userMsg;
    if (docText.includes('sangat tidak jelas')) {
      const target = 'sangat tidak jelas';
      const start = docText.indexOf(target);
      return {
        issues: [{
          type: 'formality',
          start,
          end: start + target.length,
          text: target,
          explanation: 'Gunakan frasa yang lebih objektif.',
          suggestion: 'belum terperinci',
        }],
      };
    }
    if (docText.includes('Metode lama')) {
      const target = 'Metode lama';
      const start = docText.indexOf(target);
      return {
        issues: [{
          type: 'style_consistency',
          start,
          end: start + target.length,
          text: target,
          explanation: 'Perjelas istilah metode.',
          suggestion: 'Metode baru',
        }],
      };
    }
    return { issues: [] };
  });

  const prevProvider = process.env.AI_PROVIDER;
  const prevBase = process.env.AI_BASE_URL;
  const prevKey = process.env.AI_API_KEY;
  const prevModel = process.env.AI_MODEL;

  process.env.AI_PROVIDER = '9router';
  process.env.AI_BASE_URL = mockAi.baseUrl;
  process.env.AI_API_KEY = 'mock-key';
  process.env.AI_MODEL = 'mock/qa-model';

  try {
    const app = createApp();

    // Register two separate users to test isolation & concurrency
    const r1 = await request(app).post('/api/auth/register').send({
      name: 'User Satu',
      email: `qa1-${Date.now()}@runut.test`,
      password: 'Password123!',
    });
    const r2 = await request(app).post('/api/auth/register').send({
      name: 'User Dua',
      email: `qa2-${Date.now()}@runut.test`,
      password: 'Password123!',
    });
    assert.equal(r1.status, 201);
    assert.equal(r2.status, 201);

    const token1 = r1.body.accessToken;
    const token2 = r2.body.accessToken;
    const user1Id = r1.body.user.id;
    const user2Id = r2.body.user.id;

    await tokenTransactions.credit({ user_id: user1Id, amount: 20, type: 'purchase', description: 'Topup QA 1' });
    await tokenTransactions.credit({ user_id: user2Id, amount: 20, type: 'purchase', description: 'Topup QA 2' });

    // 1. Complex DOCX upload -> analyze -> revise -> clear memory cache (simulate restart) -> download & verify preservation
    const complexDocx = await buildComplexDocxWithTableImageHeaderBib();
    const origDocxHash = sha256(complexDocx);

    const upDocx = await request(app)
      .post('/api/analysis')
      .set('Authorization', `Bearer ${token1}`)
      .field('ai_consent', 'true')
      .attach('file', complexDocx, 'laporan-kompleks.docx');
    assert.equal(upDocx.status, 201, `DOCX upload failed: ${JSON.stringify(upDocx.body)}`);
    const docxDocId = upDocx.body.document.id;
    assert.ok(upDocx.body.issues.length >= 1);

    const applyDocxRes = await request(app)
      .patch(`/api/documents/${docxDocId}/issues`)
      .set('Authorization', `Bearer ${token1}`)
      .send({ accept_all: true });
    assert.equal(applyDocxRes.status, 200);

    // Simulate process memory cache wipe: persistent fileStore must still retrieve original DOCX!
    clearMemoryFileCache();

    const dlDocx = await request(app)
      .get(`/api/documents/${docxDocId}/download?format=docx`)
      .set('Authorization', `Bearer ${token1}`)
      .buffer(true)
      .parse((res, cb) => {
        const chunks = [];
        res.on('data', (c) => chunks.push(c));
        res.on('end', () => cb(null, Buffer.concat(chunks)));
      });
    assert.equal(dlDocx.status, 200);
    assert.equal(dlDocx.headers['x-preservation-mode'], 'template-preserved');
    assert.equal(dlDocx.headers['x-preservation-verified'], 'true');
    const verDocx = await verifyDocxPreservation(complexDocx, dlDocx.body);
    assert.equal(verDocx.verified, true);
    assert.equal(verDocx.checks.tables_preserved, true);
    assert.equal(verDocx.checks.images_preserved, true);
    assert.equal(verDocx.checks.headers_footers_preserved, true);
    assert.equal(verDocx.checks.bibliography_preserved, true);
    assert.equal(sha256(complexDocx), origDocxHash);
    const editedInsp = await inspectDocx(dlDocx.body);
    assert.match(editedInsp.text, /belum terperinci/);

    // 2. Multi-page Academic PDF upload -> analyze -> revise -> download -> visual comparison
    const academicPdf = await buildMultiPageAcademicPdf();
    const origPdfHash = sha256(academicPdf);
    const upPdf = await request(app)
      .post('/api/analysis')
      .set('Authorization', `Bearer ${token1}`)
      .field('ai_consent', 'true')
      .attach('file', academicPdf, 'jurnal-2-halaman.pdf');
    assert.equal(upPdf.status, 201, `PDF upload failed: ${JSON.stringify(upPdf.body)}`);
    const pdfDocId = upPdf.body.document.id;

    await request(app)
      .patch(`/api/documents/${pdfDocId}/issues`)
      .set('Authorization', `Bearer ${token1}`)
      .send({ accept_all: true })
      .expect(200);

    const dlPdf = await request(app)
      .get(`/api/documents/${pdfDocId}/download?format=pdf`)
      .set('Authorization', `Bearer ${token1}`)
      .buffer(true)
      .parse((res, cb) => {
        const chunks = [];
        res.on('data', (c) => chunks.push(c));
        res.on('end', () => cb(null, Buffer.concat(chunks)));
      });
    assert.equal(dlPdf.status, 200);
    assert.equal(dlPdf.headers['x-preservation-mode'], 'pdf-inplace-preserved');
    const postPdfInsp = await inspectPdf(dlPdf.body);
    assert.equal(postPdfInsp.page_count, 2);
    assert.match(postPdfInsp.text, /Metode baru/);
    const vis = await comparePdfVisually(academicPdf, dlPdf.body);
    assert.equal(vis.page_count_match, true);
    assert.equal(vis.layout_preserved, true);
    assert.equal(sha256(academicPdf), origPdfHash);

    // 3. Cross-user authorization & data isolation
    await request(app).get(`/api/documents/${docxDocId}`).set('Authorization', `Bearer ${token2}`).expect(403);
    await request(app).get(`/api/documents/${docxDocId}/download?format=docx`).set('Authorization', `Bearer ${token2}`).expect(403);
    await request(app).get(`/api/documents/${docxDocId}/analysis-report?format=pdf`).set('Authorization', `Bearer ${token2}`).expect(403);

    // 4. Multi-user concurrent download reservations
    const [resA, resB] = await Promise.all([
      request(app).post(`/api/documents/${docxDocId}/download/reserve`).set('Authorization', `Bearer ${token1}`).send({ format: 'docx' }),
      request(app).post(`/api/documents/${pdfDocId}/download/reserve`).set('Authorization', `Bearer ${token1}`).send({ format: 'pdf' }),
    ]);
    assert.equal(resA.status, 201);
    assert.equal(resB.status, 201);
    await request(app).post(`/api/documents/${docxDocId}/download/${resA.body.transaction.id}/cancel`).set('Authorization', `Bearer ${token1}`).send({ reason: 'qa_cancel' }).expect(200);
    await request(app).post(`/api/documents/${pdfDocId}/download/${resB.body.transaction.id}/cancel`).set('Authorization', `Bearer ${token1}`).send({ reason: 'qa_cancel' }).expect(200);

    // 5. Security headers on /api/health
    const health = await request(app).get('/api/health').expect(200);
    assert.equal(health.headers['x-content-type-options'], 'nosniff');
    assert.equal(health.headers['cache-control'], 'no-store');
    assert.ok(health.headers['permissions-policy']);
    assert.equal(health.body.document_processing.docker_required, false);
  } finally {
    process.env.AI_PROVIDER = prevProvider;
    process.env.AI_BASE_URL = prevBase;
    process.env.AI_API_KEY = prevKey;
    process.env.AI_MODEL = prevModel;
    await new Promise((r) => mockAi.server.close(r));
  }
});
