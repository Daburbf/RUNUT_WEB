import test from 'node:test';
import assert from 'node:assert/strict';
import {
  detectDocumentLanguage,
  detectDocumentType,
  buildWritingSystemPrompt,
} from '../src/services/prompts/writingEngine.js';
import { detectSlopPatterns } from '../src/services/prompts/antiAiSlop.js';
import { validateStructuredEdits } from '../src/services/aiValidate.js';
import { analyzeSimilarity } from '../src/services/similarity.js';
import { validateCitations } from '../src/services/citations.js';

// ---- Writing Quality & Prompt Engine Tests ----

test('Writing engine: detects Indonesian & English academic documents and builds skill-integrated prompts', () => {
  const idText = 'BAB I PENDAHULUAN. Penelitian ini bertujuan untuk menganalisis pengaruh metode pembelajaran terhadap hasil belajar mahasiswa. Daftar Pustaka.';
  const enText = 'Abstract. This research study investigates the impact of methodology on empirical results and conclusions in higher education. References.';

  assert.equal(detectDocumentLanguage(idText), 'id');
  assert.equal(detectDocumentType(idText), 'academic_report');
  assert.equal(detectDocumentLanguage(enText), 'en');
  assert.equal(detectDocumentType(enText), 'academic_report');

  const idPrompt = buildWritingSystemPrompt({ language: 'id', documentType: 'academic_report' });
  assert.match(idPrompt, /ANTI-AI-SLOP/i);
  assert.match(idPrompt, /HUMANIZE-TEXT/i);
  assert.match(idPrompt, /PRESERVASI SEMANTIK/i);
  assert.match(idPrompt, /Dalam era perkembangan teknologi saat ini/i);

  const enPrompt = buildWritingSystemPrompt({ language: 'en', documentType: 'academic_report' });
  assert.match(enPrompt, /ANTI-AI-SLOP/i);
  assert.match(enPrompt, /ACADEMIC WRITER/i);
  assert.match(enPrompt, /SEMANTIC PRESERVATION/i);
});

test('Anti-AI-Slop detector catches generic Indonesian & English AI-slop expressions', () => {
  const idSlop = 'Dalam era perkembangan teknologi saat ini, tidak dapat dipungkiri bahwa AI sangat penting. Selain itu, pada dasarnya hal ini perlu diketahui bahwa sistem terus berkembang — secara keseluruhan.';
  const idHits = detectSlopPatterns(idSlop, 'id');
  assert.ok(idHits.some((h) => h.phrase.includes('dalam era perkembangan teknologi saat ini')));
  assert.ok(idHits.some((h) => h.phrase.includes('tidak dapat dipungkiri bahwa')));
  assert.ok(idHits.some((h) => h.phrase.includes('em-dash')));

  const enSlop = "In today's rapidly evolving landscape, it is important to note that this framework plays a pivotal role.";
  const enHits = detectSlopPatterns(enSlop, 'en');
  assert.ok(enHits.some((h) => h.phrase.includes("in today's rapidly evolving")));
  assert.ok(enHits.some((h) => h.phrase.includes('plays a pivotal role')));
});

test('Structured edit validator rejects invalid block_ids, protected blocks, and original_text mismatches', () => {
  const blocks = new Map([
    ['paragraph_0001', { block_id: 'paragraph_0001', text: 'Hasil pengujian mencapai 95,4% akurasi.', protected: false }],
    ['paragraph_0002', { block_id: 'paragraph_0002', text: 'Smith, J. (2020). Academic Writing.', protected: true }],
  ]);

  const { valid, errors } = validateStructuredEdits({
    edits: [
      { block_id: 'paragraph_9999', original_text: 'x', revised_text: 'y' },
      { block_id: 'paragraph_0002', original_text: 'Smith, J. (2020). Academic Writing.', revised_text: 'Changed' },
      { block_id: 'paragraph_0001', original_text: 'Wrong original', revised_text: 'y' },
      { block_id: 'paragraph_0001', original_text: 'Hasil pengujian mencapai 95,4% akurasi.', revised_text: 'Pengujian mencapai akurasi tinggi.' },
    ],
  }, blocks);

  assert.equal(errors.length, 3);
  assert.equal(valid.length, 1);
  // Changed number (95,4% dropped) must trigger needs_manual_review
  assert.equal(valid[0].needs_manual_review, true);
});

// ---- Originality & Similarity Engine Tests ----

test('Similarity engine: detects repeated sentences, repeated paragraphs, and honest scope note without external corpus', () => {
  const para = 'Sistem informasi manajemen rumah sakit membantu mempercepat proses pendaftaran pasien rawat jalan setiap hari.';
  const text = `${para}\n\nParagraf pembahasan yang berbeda tentang keamanan data medis di klinik daerah.\n\n${para}`;

  const report = analyzeSimilarity(text);
  assert.equal(report.corpus_compared, 'internal_only');
  assert.equal(report.corpus_similarity_percent, null);
  assert.match(report.scope_note, /Turnitin|iThenticate/i);
  assert.ok(report.findings.some((f) => f.similarity_method === 'repeated_sentence' || f.similarity_method === 'repeated_paragraph'));
});

test('Similarity engine: separates direct quotations, properly cited paraphrases, and unattributed source overlaps', () => {
  const ref = {
    title: 'Santoso (2022)',
    text: 'Pembelajaran mesin berbasis transformator mampu meningkatkan akurasi klasifikasi dokumen ilmiah berbahasa Indonesia hingga sembilan puluh persen pada korpus uji.',
  };

  const docText = [
    '"Pembelajaran mesin berbasis transformator mampu meningkatkan akurasi klasifikasi dokumen ilmiah berbahasa Indonesia hingga sembilan puluh persen pada korpus uji" (Santoso, 2022).',
    'Pembelajaran mesin berbasis transformator mampu meningkatkan akurasi klasifikasi dokumen ilmiah berbahasa Indonesia hingga sembilan puluh persen pada korpus uji.',
    'Dalam studi terbaru, arsitektur transformator mencatat akurasi klasifikasi dokumen ilmiah Indonesia mencapai sembilan puluh persen (Santoso, 2022).',
  ].join('\n\n');

  const report = analyzeSimilarity(docText, { referenceTexts: [ref] });
  assert.equal(report.corpus_compared, 'user_references');
  assert.ok(report.corpus_similarity_percent > 0);
  assert.ok(report.findings.some((f) => f.category === 'direct_quotation' && f.citation_status === 'properly_cited'));
  assert.ok(report.findings.some((f) => f.category === 'unattributed_overlap' && f.citation_status === 'missing_citation'));
});

// ---- Citation & Bibliography Validation Tests ----

test('Citation engine: detects APA 7th style, missing references, unused entries, and duplicate references', async () => {
  const doc = [
    'Pendahuluan ini merujuk pada temuan sebelumnya (Santoso & Wijaya, 2021) serta penelitian lanjutan oleh Rahman (2023).',
    '',
    'Daftar Pustaka',
    'Santoso, B., & Wijaya, A. (2021). Analisis Teks Akademik. Jurnal Linguistik, 10(2), 45-60. https://doi.org/10.1234/jl.2021.102',
    'Santoso, B., & Wijaya, A. (2021). Analisis Teks Akademik. Jurnal Linguistik, 10(2), 45-60. https://doi.org/10.1234/jl.2021.102',
    'Putri, D. (2019). Metode Penelitian Kualitatif. Penerbit Nusantara.',
  ].join('\n');

  const report = await validateCitations(doc, { verifyExternal: false });
  assert.equal(report.detected_style, 'APA 7th');
  assert.equal(report.bibliography_found, true);
  assert.equal(report.bibliography_protected, true);
  assert.equal(report.missing_references.length, 1);
  assert.match(report.missing_references[0].citation, /Rahman/);
  assert.equal(report.unused_references.length, 1);
  assert.match(report.unused_references[0].entry, /Putri/);
  assert.equal(report.duplicate_references.length, 1);
  assert.equal(report.doi_checks[0].status, 'unverified');
});

test('Citation engine: detects IEEE style and verifies DOIs via mocked Crossref', async () => {
  const doc = [
    'Arsitektur ini diusulkan pada penelitian sebelumnya [1] dan diperluas pada [2].',
    '',
    'References',
    '[1] A. Smith, "Neural Parsing," IEEE Access, 2022. doi:10.1109/valid.2022.001',
    '[2] B. Lee, "Broken Reference," IEEE Access, 2023. doi:10.1109/invalid.2023.999',
  ].join('\n');

  const mockFetch = async (url) => {
    if (url.includes('valid.2022.001')) {
      return { ok: true, status: 200, async json() { return { message: { title: ['Neural Parsing'] } }; } };
    }
    return { ok: false, status: 404, async json() { return {}; } };
  };

  const report = await validateCitations(doc, { verifyExternal: true, fetchImpl: mockFetch });
  assert.equal(report.detected_style, 'IEEE');
  assert.equal(report.missing_references.length, 0);
  assert.ok(['verified', 'partially_verified'].includes(report.doi_checks.find((d) => d.doi.includes('valid'))?.status));
  assert.equal(report.doi_checks.find((d) => d.doi.includes('invalid'))?.status, 'invalid_doi');
});
