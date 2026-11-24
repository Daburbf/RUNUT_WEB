import test from 'node:test';
import assert from 'node:assert/strict';
import JSZip from 'jszip';
import { PDFDocument, StandardFonts } from 'pdf-lib';
import { buildAnalysisReport, HIGHLIGHT_LEGEND } from '../src/services/reports/analysisReportService.js';
import { generateAnalysisReportPdf } from '../src/services/reports/reportPdfService.js';
import { generateAnalysisReportDocx } from '../src/services/reports/reportDocxService.js';
import { annotateOriginalDocx, annotateOriginalPdf } from '../src/services/reports/annotatedDocumentService.js';
import { inspectPdf } from '../src/services/pdfEditor.js';
import { verifyDocxPreservation } from '../src/services/docxEditor.js';

function createSampleAnalyzedBundle() {
  const originalText = [
    'Dalam era perkembangan teknologi saat ini, analisis dokumen akademik menjadi kebutuhan penting bagi peneliti (Santoso, 2024).',
    'Pembelajaran mesin berbasis transformator meningkatkan akurasi klasifikasi dokumen ilmiah berbahasa Indonesia secara konsisten.',
    '"Metode analisis teks berbasis korpus terbuka meningkatkan transparansi verifikasi akademik" (Wijaya, 2023).',
    'Selain itu, hasil penelitian menunjukkan pengulangan kalimat yang perlu diperbaiki (Kusuma, 2022).',
    '',
    'Daftar Pustaka',
    'Santoso, B. (2024). Analisis Dokumen Akademik. Jurnal Teknologi. https://doi.org/10.1000/invalid-doi',
    'Wijaya, A. (2023). Korpus Terbuka. Jurnal Linguistik.',
  ].join('\n\n');

  const document = {
    id: 'doc-report-001',
    title: 'Laporan Penelitian Akademik',
    file_name: 'laporan-penelitian.docx',
    original_text: originalText,
    word_count: 85,
    updated_at: '2026-11-23T12:00:00.000Z',
  };

  const analysis = {
    id: 'ana-report-001',
    ai_status: 'ok',
    created_at: '2026-11-23T12:00:00.000Z',
    stats: {
      word_count: 85,
      paragraph_count: 6,
      document_language: 'id',
      document_type: 'academic_report',
      document_metadata: { format: 'docx', page_count: 2 },
      similarity_report: {
        corpus_compared: 'user_references_and_external_sources',
        corpus_similarity_percent: 33,
        calculation_method: 'Persentase kalimat dengan kecocokan leksikal (2/6 kalimat).',
        scope_note: 'Perbandingan terbatas pada sumber yang dapat diakses, bukan Turnitin/iThenticate.',
        corpus_coverage: {
          sources_checked: 2,
          full_text_accessible_sources: 2,
          metadata_only_sources: 0,
          user_provided_references: 1,
        },
        summary: { repeated_phrases: 1 },
        findings: [
          {
            original_passage: 'Pembelajaran mesin berbasis transformator meningkatkan akurasi klasifikasi dokumen ilmiah berbahasa Indonesia secara konsisten.',
            matching_passage: 'Pembelajaran mesin berbasis transformator meningkatkan akurasi klasifikasi dokumen ilmiah berbahasa Indonesia.',
            source_title: 'Open Access NLP Study',
            source_author: 'Dr. Researcher',
            source_year: 2024,
            source_url: 'https://openjournal.example.org/nlp',
            source_doi: '10.1000/oa.2024',
            source_accessibility_status: 'Open Access',
            similarity_method: 'exact_phrase_matching',
            classification: 'Exact Match',
            category: 'unattributed_overlap',
            citation_status: 'citation_not_detected',
            explanation: 'Kecocokan teks kuat tanpa sitasi.',
            recommended_correction: 'Parafrasakan dengan struktur kalimat sendiri dan tambahkan sitasi.',
          },
          {
            original_passage: '"Metode analisis teks berbasis korpus terbuka meningkatkan transparansi verifikasi akademik" (Wijaya, 2023).',
            matching_passage: 'Metode analisis teks berbasis korpus terbuka meningkatkan transparansi verifikasi akademik.',
            source_title: 'Korpus Terbuka',
            source_url: 'https://repo.example.org/korpus',
            source_accessibility_status: 'User-Provided Source',
            similarity_method: 'normalized_text_comparison',
            classification: 'Properly Cited Quotation',
            category: 'direct_quotation',
            citation_status: 'properly_cited',
            explanation: 'Kutipan langsung bersitasi benar.',
            recommended_correction: 'Pertahankan kutipan langsung.',
          },
          {
            original_passage: 'Selain itu, hasil penelitian menunjukkan pengulangan kalimat yang perlu diperbaiki (Kusuma, 2022).',
            matching_passage: 'Hasil penelitian menunjukkan pengulangan kalimat.',
            source_title: 'Unavailable URL Source',
            source_url: null,
            source_accessibility_status: 'Source Unavailable',
            similarity_method: 'ngram_similarity',
            classification: 'Close Textual Match',
            category: 'close_paraphrase',
            citation_status: 'properly_cited',
            explanation: 'Kemiripan umum pada frasa.',
            recommended_correction: 'Ringkas pengulangan frasa.',
          },
        ],
      },
      citation_report: {
        detected_style: 'APA 7th',
        bibliography_found: true,
        bibliography_start: originalText.indexOf('Daftar Pustaka'),
        in_text_count: 3,
        bibliography_count: 2,
        missing_references: [{ citation: '(Kusuma, 2022)', position: 320, reason: 'Tidak ditemukan di daftar pustaka.' }],
        unused_references: [],
        duplicate_references: [],
        metadata_mismatches: [],
        doi_checks: [{ doi: '10.1000/invalid-doi', status: 'invalid_doi', reason: 'DOI tidak ditemukan.' }],
      },
    },
  };

  const issues = [
    {
      id: 'iss-1',
      category: 'formality',
      start_pos: 0,
      end_pos: 41,
      snippet: 'Dalam era perkembangan teknologi saat ini',
      explanation: 'Ungkapan pembuka generik.',
      suggestion: 'Saat ini',
      needs_manual_review: false,
      decision: 'active',
    },
    {
      id: 'iss-2',
      category: 'transition',
      start_pos: originalText.indexOf('Selain itu'),
      end_pos: originalText.indexOf('Selain itu') + 10,
      snippet: 'Selain itu',
      explanation: 'Transisi berulang.',
      suggestion: 'Di sisi lain',
      needs_manual_review: false,
      decision: 'active',
    },
  ];

  return { document, analysis, issues };
}

test('Analysis Report Model: builds all 6 color highlight categories, multiple findings per paragraph, and non-authorship AI disclaimer', () => {
  const bundle = createSampleAnalyzedBundle();
  const report = buildAnalysisReport(bundle);

  assert.equal(HIGHLIGHT_LEGEND.length, 6);
  assert.ok(report.findings.some((f) => f.highlight_color === 'blue' && f.category === 'AI_STYLE_INDICATOR'));
  assert.ok(report.findings.some((f) => f.highlight_color === 'red' && f.category === 'TEXT_SIMILARITY'));
  assert.ok(report.findings.some((f) => f.highlight_color === 'yellow' && f.category === 'TEXT_SIMILARITY'));
  assert.ok(report.findings.some((f) => f.highlight_color === 'orange' && f.category === 'CITATION_ISSUE'));
  assert.ok(report.findings.some((f) => f.highlight_color === 'green' && f.category === 'PROPERLY_CITED_MATCH'));
  assert.ok(report.findings.some((f) => f.highlight_color === 'gray' && f.category === 'EXCLUDED_CONTENT'));

  // Multiple independent findings allowed in one paragraph (paragraph_004 has blue transition + yellow similarity + orange missing citation!)
  const p4Findings = report.findings.filter((f) => f.paragraph_id === 'paragraph_004');
  assert.ok(p4Findings.length >= 2);

  // Uncertain AI-style indicator disclaimer is explicit — never claims proof of AI authorship
  assert.match(report.ai_indicator_overview.disclaimer, /NOT proof of AI authorship/i);
  assert.equal(report.similarity_overview.overall_similarity_percent, 33);
});

test('Analysis Report Exports: generates clean multi-page PDF & DOCX reports with ZERO RUNUT watermarks or creator metadata', async () => {
  const report = buildAnalysisReport(createSampleAnalyzedBundle());

  // 1. PDF Analysis Report
  const pdfBuf = await generateAnalysisReportPdf(report);
  assert.ok(pdfBuf.slice(0, 5).toString('latin1').startsWith('%PDF-'));
  const pdfInfo = await inspectPdf(pdfBuf);
  assert.ok(pdfInfo.page_count >= 2);
  assert.ok(pdfInfo.text.includes('DOCUMENT ANALYSIS REPORT'));
  assert.ok(pdfInfo.text.includes('F-001'));
  assert.ok(pdfInfo.text.includes('Open Access NLP Study'));
  assert.ok(!/\brut?nut\b/i.test(pdfInfo.text), 'PDF report must not contain RUNUT watermark');
  const loadedPdf = await PDFDocument.load(pdfBuf);
  assert.ok(!/runut/i.test(String(loadedPdf.getCreator() || '')));

  // 2. DOCX Analysis Report
  const docxBuf = await generateAnalysisReportDocx(report);
  const zip = await JSZip.loadAsync(docxBuf);
  const docXml = await zip.file('word/document.xml').async('string');
  assert.ok(docXml.includes('Document Analysis Report'));
  assert.ok(docXml.includes('DBEAFE')); // Blue shading
  assert.ok(docXml.includes('FEE2E2')); // Red shading
  assert.ok(!/runut/i.test(docXml));
});

test('Annotated Original Exports: adds color highlights to DOCX & PDF copies while preserving original structure and keeping originals immutable', async () => {
  const report = buildAnalysisReport(createSampleAnalyzedBundle());

  // 1. Annotated DOCX copy
  const origZip = new JSZip();
  origZip.file('[Content_Types].xml', '<?xml version="1.0"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="xml" ContentType="application/xml"/></Types>');
  origZip.file('word/styles.xml', '<w:styles xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"/>');
  origZip.file('word/document.xml', `<?xml version="1.0"?><w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body><w:p><w:r><w:t>Dalam era perkembangan teknologi saat ini, analisis dokumen akademik menjadi kebutuhan penting.</w:t></w:r></w:p><w:sectPr><w:pgSz w:w="11906" w:h="16838"/></w:sectPr></w:body></w:document>`);
  const origDocxBuf = await origZip.generateAsync({ type: 'nodebuffer' });

  const annDocx = await annotateOriginalDocx(origDocxBuf, report.findings);
  assert.equal(annDocx.ok, true);
  assert.equal(annDocx.annotated_count, 1);
  const annZip = await JSZip.loadAsync(annDocx.buffer);
  const annXml = await annZip.file('word/document.xml').async('string');
  assert.ok(annXml.includes('w:highlight'));
  const verification = await verifyDocxPreservation(origDocxBuf, annDocx.buffer);
  assert.equal(verification.checks.page_configuration_preserved, true);

  // 2. Annotated PDF copy
  const pdfDoc = await PDFDocument.create();
  const font = await pdfDoc.embedFont(StandardFonts.Helvetica);
  const p = pdfDoc.addPage([595, 842]);
  p.drawText('Dalam era perkembangan teknologi saat ini, analisis dokumen akademik.', { x: 56, y: 740, size: 11, font });
  const origPdfBuf = Buffer.from(await pdfDoc.save({ useObjectStreams: false }));

  const annPdf = await annotateOriginalPdf(origPdfBuf, report.findings);
  assert.equal(annPdf.ok, true);
  assert.ok(annPdf.annotated_count >= 1);
  const annPdfInfo = await inspectPdf(annPdf.buffer);
  assert.equal(annPdfInfo.page_dimensions[0].width, 595);
  assert.equal(annPdfInfo.page_dimensions[0].height, 842);
  assert.ok(annPdfInfo.text.includes('Dalam era perkembangan teknologi'));
});
