import test from 'node:test';
import assert from 'node:assert/strict';
import { PDFDocument, StandardFonts, rgb } from 'pdf-lib';
import { createCanvas } from '@napi-rs/canvas';
import {
  inspectPdf,
  applyPdfEdits,
  comparePdfVisually,
} from '../src/services/pdfEditor.js';
import {
  resolveAcademicSourceByDoi,
  verifyAlternativeVersionMatches,
  SOURCE_STATUS,
} from '../src/services/academicSources.js';

function jsonRes(status, data) {
  return {
    ok: status >= 200 && status < 300,
    status,
    async json() { return data; },
  };
}

async function createTwoPageReflowPdf({ blockPage2Top = false } = {}) {
  const doc = await PDFDocument.create();
  const font = await doc.embedFont(StandardFonts.Helvetica);

  // Page 1: Paragraph near the bottom margin (y=85 and y=70, available_height ~45pt)
  const p1 = doc.addPage([595, 842]);
  p1.drawText('Paragraf pembuka di bagian atas halaman pertama dokumen penelitian.', { x: 56, y: 760, size: 11, font });
  p1.drawText('Paragraf terakhir halaman satu membahas hasil evaluasi', { x: 56, y: 85, size: 11, font });
  p1.drawText('metode pengukuran kinerja sistem secara ringkas.', { x: 56, y: 70, size: 11, font });

  // Page 2: Either free top space (content starts low at y=450) OR completely dense page (no free band)
  const p2 = doc.addPage([595, 842]);
  if (blockPage2Top) {
    for (let y = 770; y >= 65; y -= 22) {
      p2.drawText(`Konten padat halaman kedua pada posisi ${y} pt yang tidak boleh ditabrak.`, { x: 56, y, size: 11, font });
    }
  } else {
    p2.drawText('Bagian bawah halaman kedua memuat tabel ringkasan terpisah.', { x: 56, y: 450, size: 11, font });
  }

  return Buffer.from(await doc.save({ useObjectStreams: false }));
}

test('Cross-Page Reflow: requires explicit user approval by default, and safely flows overflow lines onto page 2 when approved', async () => {
  const pdfBuf = await createTwoPageReflowPdf({ blockPage2Top: false });
  const longerRevision = 'metode pengukuran kinerja sistem secara menyeluruh berdasarkan pengujian empiris berulang terhadap seluruh skenario dokumen akademik berbahasa Indonesia maupun Inggris secara terstruktur dan terukur.';

  // 1. Default (allowCrossPageReflow: false) MUST NOT reflow silently!
  const preview = await applyPdfEdits(pdfBuf, [{
    snippet: 'Paragraf terakhir halaman satu membahas hasil evaluasi metode pengukuran kinerja sistem secara ringkas.',
    suggestion: `Paragraf terakhir halaman satu membahas hasil evaluasi ${longerRevision}`,
  }]);

  assert.equal(preview.modified, false);
  assert.equal(preview.flagged_regions[0].reason, 'cross_page_reflow_requires_approval');
  assert.equal(preview.pending_reflow_plans.length, 1);
  assert.deepEqual(preview.pending_reflow_plans[0].affected_pages, [1, 2]);
  assert.equal(preview.pending_reflow_plans[0].requires_user_approval, true);
  assert.ok(preview.pending_reflow_plans[0].overflow_lines.length >= 1);

  // 2. Explicitly approved (allowCrossPageReflow: true) -> applies controlled reflow onto page 2!
  const approved = await applyPdfEdits(pdfBuf, [{
    snippet: 'Paragraf terakhir halaman satu membahas hasil evaluasi metode pengukuran kinerja sistem secara ringkas.',
    suggestion: `Paragraf terakhir halaman satu membahas hasil evaluasi ${longerRevision}`,
  }], { allowCrossPageReflow: true });

  assert.equal(approved.modified, true);
  assert.equal(approved.applied[0].mode, 'cross_page_reflow');
  assert.deepEqual(approved.applied[0].affected_pages, [1, 2]);
  assert.ok(approved.applied[0].lines_on_next_page >= 1);

  const afterInfo = await inspectPdf(approved.buffer);
  assert.equal(afterInfo.page_count, 2);
  assert.ok(afterInfo.pages[1].text.includes('terukur') || afterInfo.pages[1].text.includes('Inggris'));

  const visual = await comparePdfVisually(pdfBuf, approved.buffer, { scale: 0.5 });
  assert.equal(visual.page_count_match, true);
  assert.equal(visual.layout_preserved, true);
});

test('Cross-Page Reflow: safely rejects reflow when next page top is occupied and retains original PDF', async () => {
  const blockedBuf = await createTwoPageReflowPdf({ blockPage2Top: true });
  const longerRevision = 'metode pengukuran kinerja sistem secara menyeluruh berdasarkan pengujian empiris berulang terhadap seluruh skenario dokumen akademik.';

  const res = await applyPdfEdits(blockedBuf, [{
    snippet: 'Paragraf terakhir halaman satu membahas hasil evaluasi metode pengukuran kinerja sistem secara ringkas.',
    suggestion: `Paragraf terakhir halaman satu membahas hasil evaluasi ${longerRevision}`,
  }], { allowCrossPageReflow: true });

  assert.equal(res.modified, false);
  assert.equal(res.flagged_regions[0].reason, 'paragraph_vertical_overflow');
  assert.equal(res.recommend_docx, true);
  assert.ok(res.flagged_regions[0].revised_text_separate.includes('empiris'));
});

test('Complex Background Optional Preview: rejects photographic background even when preview opted-in and returns separate revised text', async () => {
  const doc = await PDFDocument.create();
  const font = await doc.embedFont(StandardFonts.Helvetica);
  const page = doc.addPage([595, 842]);
  const c = createCanvas(515, 90);
  const ctx = c.getContext('2d');
  const imgData = ctx.createImageData(515, 90);
  for (let i = 0; i < imgData.data.length; i += 4) {
    const p = i / 4;
    imgData.data[i] = (p * 41) % 256;
    imgData.data[i + 1] = (p * 83 + 40) % 256;
    imgData.data[i + 2] = (p * 127 + 90) % 256;
    imgData.data[i + 3] = 255;
  }
  ctx.putImageData(imgData, 0, 0);
  const png = await doc.embedPng(c.toBuffer('image/png'));
  page.drawImage(png, { x: 40, y: 700, width: 515, height: 90 });
  page.drawText('Teks di atas foto kompleks yang harus tetap aman tanpa artefak.', { x: 56, y: 740, size: 12, font });
  const photoBuf = Buffer.from(await doc.save({ useObjectStreams: false }));

  const res = await applyPdfEdits(photoBuf, [{
    snippet: 'foto kompleks',
    suggestion: 'latar foto',
  }], { allowOptionalRestorationPreview: true });

  assert.equal(res.modified, false);
  assert.equal(res.flagged_regions[0].reason, 'complex_background_unsafe');
  assert.equal(res.flagged_regions[0].affected_page, 1);
  assert.equal(res.flagged_regions[0].revised_text_separate, 'latar foto');
  assert.match(res.flagged_regions[0].recommendation, /DOCX|PPTX/i);
});

test('Legal Alternative Discovery: detects Institutional Repository Copy, Author Manuscript, PubMed Central, and verifies publication identity', async () => {
  // 1. Institutional Repository Copy via Unpaywall
  const repoRes = await resolveAcademicSourceByDoi('10.1000/repo-copy', {
    fetchImpl: async (url) => {
      if (url.includes('crossref.org')) return jsonRes(200, { message: { title: ['Repo Paper'], author: [{ family: 'Smith' }], published: { 'date-parts': [[2023]] } } });
      if (url.includes('unpaywall.org')) {
        return jsonRes(200, {
          title: 'Repo Paper',
          is_oa: true,
          best_oa_location: {
            host_type: 'repository',
            version: 'publishedVersion',
            repository_institution: 'University Digital Repository',
            url_for_pdf: 'https://repo.univ.edu/paper.pdf',
          },
        });
      }
      return jsonRes(404, {});
    },
  });
  assert.equal(repoRes.accessibility_status, SOURCE_STATUS.INSTITUTIONAL_REPOSITORY);
  assert.equal(repoRes.repository_institution, 'University Digital Repository');
  assert.equal(repoRes.full_text_verified, false);

  // 2. Author Manuscript via Unpaywall
  const msRes = await resolveAcademicSourceByDoi('10.1000/author-ms', {
    fetchImpl: async (url) => {
      if (url.includes('crossref.org')) return jsonRes(200, { message: { title: ['Manuscript Paper'], author: [{ family: 'Lee' }], published: { 'date-parts': [[2022]] } } });
      if (url.includes('unpaywall.org')) {
        return jsonRes(200, {
          title: 'Manuscript Paper',
          is_oa: true,
          best_oa_location: {
            host_type: 'repository',
            version: 'acceptedVersion',
            url: 'https://arxiv.org/abs/2201.00001',
          },
        });
      }
      return jsonRes(404, {});
    },
  });
  assert.equal(msRes.accessibility_status, SOURCE_STATUS.AUTHOR_MANUSCRIPT);

  // 3. PubMed Central fallback
  const pmcRes = await resolveAcademicSourceByDoi('10.1000/pmc-bio', {
    fetchImpl: async (url) => {
      if (url.includes('crossref.org')) return jsonRes(200, { message: { title: ['Clinical Trial'], author: [{ family: 'Kim' }], published: { 'date-parts': [[2024]] } } });
      if (url.includes('ncbi.nlm.nih.gov/pmc')) return jsonRes(200, { records: [{ doi: '10.1000/pmc-bio', pmcid: 'PMC1234567' }] });
      return jsonRes(404, {});
    },
  });
  assert.equal(pmcRes.accessibility_status, SOURCE_STATUS.INSTITUTIONAL_REPOSITORY);
  assert.equal(pmcRes.repository_institution, 'PubMed Central');
  assert.match(pmcRes.oa_url, /PMC1234567/);

  // 4. Publication identity verification prevents confusing different articles with similar titles
  const samePub = verifyAlternativeVersionMatches(
    { doi: '10.1000/a', title: 'Neural Document Editing for Academic Reports', year: 2024 },
    { doi: '10.1000/a', title: 'Neural Document Editing for Academic Reports', year: 2024 },
  );
  assert.equal(samePub.matches, true);

  const diffPub = verifyAlternativeVersionMatches(
    { title: 'Neural Document Editing for Academic Reports', year: 2024 },
    { title: 'Neural Image Editing for Medical Scans', year: 2024 },
  );
  assert.equal(diffPub.matches, false);
});
