import test from 'node:test';
import assert from 'node:assert/strict';
import { PDFDocument, StandardFonts, rgb } from 'pdf-lib';
import {
  inspectPdf,
  applyPdfEdits,
  comparePdfVisually,
} from '../src/services/pdfEditor.js';
import {
  validatePublicUrl,
  extractDocumentUrls,
  fetchAndExtractSource,
} from '../src/services/sourceFetcher.js';
import {
  discoverMultiSources,
  analyzeSimilarity,
} from '../src/services/similarity.js';
import { buildPdf } from '../src/services/pdf.js';

function mockFetchRes(status, body, headers = {}) {
  const map = new Map(Object.entries(headers).map(([k, v]) => [k.toLowerCase(), String(v)]));
  const buf = Buffer.isBuffer(body) ? body : Buffer.from(typeof body === 'string' ? body : JSON.stringify(body));
  return {
    ok: status >= 200 && status < 300,
    status,
    headers: { get: (k) => map.get(String(k).toLowerCase()) ?? null },
    async arrayBuffer() { return buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength); },
    async json() { return JSON.parse(buf.toString('utf8')); },
    async text() { return buf.toString('utf8'); },
  };
}

// ---- Dense-Page Cross-Page Reflow Tests ----

async function createDenseDestinationPdf(scenario) {
  const doc = await PDFDocument.create();
  const font = await doc.embedFont(StandardFonts.Helvetica);
  const bold = await doc.embedFont(StandardFonts.HelveticaBold);

  // Page 1: paragraph near bottom (y=85 and y=70)
  const p1 = doc.addPage([595, 842]);
  p1.drawText('Paragraf terakhir halaman satu membahas hasil evaluasi', { x: 56, y: 85, size: 11, font });
  p1.drawText('metode pengukuran kinerja sistem secara ringkas.', { x: 56, y: 70, size: 11, font });

  // Page 2 depending on scenario
  const p2 = doc.addPage([595, 842]);
  if (scenario === 'starts_with_heading_or_table') {
    p2.drawText('BAB II TABEL RINGKASAN HASIL PENGUJIAN', { x: 56, y: 765, size: 14, font: bold });
    p2.drawRectangle({ x: 56, y: 700, width: 320, height: 50, borderColor: rgb(0, 0, 0), borderWidth: 1 });
    p2.drawText('Metrik | Akurasi | 96.2%', { x: 64, y: 720, size: 10, font });
    // Free space exists below y=700!
  } else if (scenario === 'dense_page2_free_page3') {
    // Fill page 2 densely from y=770 down to y=65 every 25pt so NO band >= 45pt exists on page 2
    for (let y = 770; y >= 65; y -= 22) {
      p2.drawText(`Baris padat halaman dua pada koordinat vertikal ${y} pt.`, { x: 56, y, size: 11, font });
    }
    // Page 3 has open space
    const p3 = doc.addPage([595, 842]);
    p3.drawText('Bagian bawah halaman tiga berisi penutup.', { x: 56, y: 200, size: 11, font });
  } else if (scenario === 'all_pages_dense') {
    for (let y = 770; y >= 65; y -= 22) {
      p2.drawText(`Baris sangat padat halaman dua pada posisi ${y} pt.`, { x: 56, y, size: 11, font });
    }
  }

  return Buffer.from(await doc.save({ useObjectStreams: false }));
}

test('Dense-Page Reflow: destination page starting with heading & table places continuation cleanly below without overwriting', async () => {
  const buf = await createDenseDestinationPdf('starts_with_heading_or_table');
  const longer = 'Paragraf terakhir halaman satu membahas hasil evaluasi metode pengukuran kinerja sistem secara menyeluruh berdasarkan pengujian empiris berulang terhadap dokumen akademik berbahasa Indonesia.';

  const approved = await applyPdfEdits(buf, [{
    snippet: 'Paragraf terakhir halaman satu membahas hasil evaluasi metode pengukuran kinerja sistem secara ringkas.',
    suggestion: longer,
  }], { allowCrossPageReflow: true });

  assert.equal(approved.modified, true);
  assert.equal(approved.applied[0].mode, 'cross_page_reflow');
  assert.deepEqual(approved.applied[0].affected_pages, [1, 2]);

  const after = await inspectPdf(approved.buffer);
  assert.equal(after.page_count, 2);
  // Heading & table text on page 2 MUST remain intact!
  assert.ok(after.pages[1].text.includes('BAB II TABEL RINGKASAN'));
  assert.ok(after.pages[1].text.includes('96.2%'));
  // Overflow text placed below on page 2
  assert.ok(after.pages[1].text.includes('Indonesia'));

  const visual = await comparePdfVisually(buf, approved.buffer, { scale: 0.5 });
  assert.equal(visual.page_count_match, true);
  assert.equal(visual.layout_preserved, true);
});

test('Dense-Page Reflow: skips completely dense page 2 and flows cleanly onto available space on page 3 while preserving page count', async () => {
  const buf = await createDenseDestinationPdf('dense_page2_free_page3');
  const longer = 'Paragraf terakhir halaman satu membahas hasil evaluasi metode pengukuran kinerja sistem secara menyeluruh berdasarkan pengujian empiris berulang terhadap dokumen akademik berbahasa Indonesia.';

  const approved = await applyPdfEdits(buf, [{
    snippet: 'Paragraf terakhir halaman satu membahas hasil evaluasi metode pengukuran kinerja sistem secara ringkas.',
    suggestion: longer,
  }], { allowCrossPageReflow: true });

  assert.equal(approved.modified, true);
  assert.deepEqual(approved.applied[0].affected_pages, [1, 3]);

  const after = await inspectPdf(approved.buffer);
  assert.equal(after.page_count, 3);
  assert.ok(after.pages[2].text.includes('Indonesia'));
});

test('Dense-Page Reflow: safely rejects reflow when all subsequent pages are dense and preserves original PDF', async () => {
  const buf = await createDenseDestinationPdf('all_pages_dense');
  const longer = 'Paragraf terakhir halaman satu membahas hasil evaluasi metode pengukuran kinerja sistem secara menyeluruh berdasarkan pengujian empiris berulang terhadap dokumen akademik berbahasa Indonesia.';

  const res = await applyPdfEdits(buf, [{
    snippet: 'Paragraf terakhir halaman satu membahas hasil evaluasi metode pengukuran kinerja sistem secara ringkas.',
    suggestion: longer,
  }], { allowCrossPageReflow: true });

  assert.equal(res.modified, false);
  assert.equal(res.flagged_regions[0].reason, 'paragraph_vertical_overflow');
  assert.equal(res.recommend_docx, true);
});

// ---- Security (SSRF, Protocol, Redirect, Size, Content-Type, Timeout, Malformed PDF) Tests ----

test('Security: blocks localhost, private IPs, cloud metadata, unsafe protocols, redirect to internal IP, oversized responses, invalid content-type, timeout, and malformed PDF', async () => {
  assert.equal(validatePublicUrl('http://localhost:3000/api/health').code, 'SSRF_BLOCKED');
  assert.equal(validatePublicUrl('http://127.0.0.1/secret').code, 'SSRF_BLOCKED');
  assert.equal(validatePublicUrl('http://192.168.1.1/admin').code, 'SSRF_BLOCKED');
  assert.equal(validatePublicUrl('http://10.0.0.12/internal').code, 'SSRF_BLOCKED');
  assert.equal(validatePublicUrl('http://169.254.169.254/latest/meta-data/').code, 'SSRF_BLOCKED');
  assert.equal(validatePublicUrl('file:///etc/passwd').code, 'UNSUPPORTED_PROTOCOL');
  assert.equal(validatePublicUrl('ftp://example.com/file.txt').code, 'UNSUPPORTED_PROTOCOL');

  // Redirect to internal IP MUST be blocked
  const redirRes = await fetchAndExtractSource('https://public.example.org/article', {
    fetchImpl: async () => mockFetchRes(302, '', { location: 'http://127.0.0.1:8080/internal' }),
  });
  assert.equal(redirRes.ok, false);
  assert.equal(redirRes.code, 'SSRF_BLOCKED');

  // Oversized response
  const bigRes = await fetchAndExtractSource('https://public.example.org/huge.txt', {
    maxBytes: 100,
    fetchImpl: async () => mockFetchRes(200, 'A'.repeat(500), { 'content-type': 'text/plain' }),
  });
  assert.equal(bigRes.ok, false);
  assert.equal(bigRes.code, 'RESPONSE_TOO_LARGE');

  // Invalid content type
  const binRes = await fetchAndExtractSource('https://public.example.org/app.exe', {
    fetchImpl: async () => mockFetchRes(200, 'binary', { 'content-type': 'application/octet-stream' }),
  });
  assert.equal(binRes.ok, false);
  assert.equal(binRes.code, 'INVALID_CONTENT_TYPE');

  // Timeout
  const timeoutRes = await fetchAndExtractSource('https://public.example.org/slow', {
    fetchImpl: async () => { const e = new Error('aborted'); e.name = 'AbortError'; throw e; },
  });
  assert.equal(timeoutRes.ok, false);
  assert.equal(timeoutRes.code, 'FETCH_TIMEOUT');

  // Malformed PDF
  const badPdfRes = await fetchAndExtractSource('https://public.example.org/broken.pdf', {
    fetchImpl: async () => mockFetchRes(200, 'NOT A REAL PDF FILE', { 'content-type': 'application/pdf' }),
  });
  assert.equal(badPdfRes.ok, false);
  assert.equal(badPdfRes.code, 'MALFORMED_PDF');
});

// ---- Multi-Source URL Extraction, Independent Discovery & Lexical vs Semantic Similarity Tests ----

test('Multi-Source Similarity: extracts body & bibliography URLs, reads HTML & PDF links, discovers independent sources, and separates lexical vs semantic findings', async () => {
  const remotePdfBuf = await buildPdf({
    title: 'Remote Research Report',
    body: 'Evaluasi kualitas dokumen akademik berbasis kecerdasan buatan membutuhkan validasi sitasi serta preservasi struktur tata letak asli.',
  });

  const docText = [
    'Pembahasan ini merujuk laporan publik pada https://journal.example.org/article-1 dan dokumen PDF di https://repo.example.org/report.pdf untuk analisis mendalam.',
    'Evaluasi kualitas dokumen akademik berbasis kecerdasan buatan membutuhkan validasi sitasi serta preservasi struktur tata letak asli.',
    'Sistem arsitektur neural mampu meningkatkan akurasi klasifikasi dokumen ilmiah berbahasa Indonesia secara konsisten.',
    'Model jaringan saraf modern membantu klasifikasi otomatis teks penelitian ilmiah Indonesia dengan presisi tinggi.',
    '"Metode analisis teks berbasis korpus terbuka meningkatkan transparansi verifikasi akademik" (Santoso, 2024).',
    '',
    'Daftar Pustaka',
    'Santoso, B. (2024). Analisis Korpus Terbuka. https://paywall.example.org/closed-paper',
  ].join('\n\n');

  const urls = extractDocumentUrls(docText);
  assert.equal(urls.length, 3);
  assert.ok(urls.some((u) => u.url === 'https://journal.example.org/article-1'));
  assert.ok(urls.some((u) => u.url === 'https://repo.example.org/report.pdf'));
  assert.ok(urls.some((u) => u.url === 'https://paywall.example.org/closed-paper'));

  const mockFetch = async (url) => {
    if (url === 'https://journal.example.org/article-1') {
      return mockFetchRes(200, `<html><head><title>Korpus Terbuka Akademik</title><meta name="author" content="B. Santoso"><meta name="citation_publication_date" content="2024"></head><body><nav>Menu</nav><article><p>Metode analisis teks berbasis korpus terbuka meningkatkan transparansi verifikasi akademik pada berbagai institusi pendidikan tinggi di Indonesia.</p></article><script>alert(1)</script></body></html>`, { 'content-type': 'text/html; charset=utf-8' });
    }
    if (url === 'https://repo.example.org/report.pdf') {
      return mockFetchRes(200, remotePdfBuf, { 'content-type': 'application/pdf' });
    }
    if (url === 'https://paywall.example.org/closed-paper') {
      return mockFetchRes(403, 'Subscription required', { 'content-type': 'text/html' });
    }
    if (url.includes('api.openalex.org/works?search=')) {
      return mockFetchRes(200, {
        results: [{
          title: 'Independently Discovered Neural Classification Study',
          doi: 'https://doi.org/10.9999/independent.2024',
          publication_year: 2024,
          open_access: { is_oa: true, oa_url: 'https://oa.example.org/neural.pdf' },
          authorships: [{ author: { display_name: 'Dr. Independent Researcher' } }],
          abstract_inverted_index: {
            Sistem: [0], arsitektur: [1], neural: [2], mampu: [3], meningkatkan: [4],
            akurasi: [5], klasifikasi: [6], dokumen: [7], ilmiah: [8], berbahasa: [9],
            Indonesia: [10], secara: [11], konsisten: [12],
          },
        }],
      }, { 'content-type': 'application/json' });
    }
    return mockFetchRes(404, {});
  };

  const discovered = await discoverMultiSources(docText, { fetchImpl: mockFetch });
  assert.equal(discovered.document_url_count, 2);
  assert.equal(discovered.independent_count, 1);
  assert.equal(discovered.paywalled_count, 1);

  const report = analyzeSimilarity(docText, {
    externalSources: discovered.sources,
    bibliographyStart: docText.indexOf('Daftar Pustaka'),
  });

  // Transparent corpus coverage
  assert.equal(report.corpus_coverage.sources_checked, 3);
  assert.equal(report.corpus_coverage.document_url_sources, 2);
  assert.equal(report.corpus_coverage.independently_discovered_sources, 1);
  assert.ok(report.corpus_coverage.checked_at);

  // Exact match from remote PDF URL AND from independently discovered OpenAlex paper
  assert.ok(report.lexical_findings.some((f) => f.source_url === 'https://repo.example.org/report.pdf'));
  assert.ok(report.lexical_findings.some((f) => f.source_doi === '10.9999/independent.2024'));
  // Properly cited quotation from HTML URL
  assert.ok(report.findings.some((f) => f.classification === 'Properly Cited Quotation' && f.source_url === 'https://journal.example.org/article-1'));
});
