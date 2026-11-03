import test from 'node:test';
import assert from 'node:assert/strict';
import { computeScores, computeStats, countWords, splitSentences } from '../src/services/stats.js';
import { rankIssues, validateAiIssues } from '../src/services/aiValidate.js';

const issue = (text, needle, extra = {}) => {
  const start = text.indexOf(needle);
  return { start, end: start + needle.length, text: needle, type: 'repetition', explanation: 'Penjelasan valid.', suggestion: 'Gunakan variasi.', ...extra };
};

test('countWords handles Indonesian punctuation and apostrophes', () => {
  assert.equal(countWords("Kata-kata penulisnya, 'baik'—benar."), 5);
});

test('countWords handles Unicode letters and numbers', () => {
  assert.equal(countWords('Versi 2.0 memakai naïve café 2026.'), 7);
});

test('countWords returns zero for whitespace and symbols', () => {
  assert.equal(countWords(' \n— … !!!'), 0);
});

test('splitSentences supports question, exclamation, and ellipsis', () => {
  assert.deepEqual(splitSentences('Apa? Ya! Tunggu… Selesai.'), [
    { text: 'Apa?', start: 0, end: 4 },
    { text: 'Ya!', start: 5, end: 8 },
    { text: 'Tunggu…', start: 9, end: 16 },
    { text: 'Selesai.', start: 17, end: 25 },
  ]);
});

test('splitSentences keeps offsets after leading whitespace', () => {
  const [sentence] = splitSentences('  Halo dunia.');
  assert.deepEqual(sentence, { text: 'Halo dunia.', start: 2, end: 13 });
});

test('computeStats handles newlines and empty paragraphs', () => {
  const stats = computeStats('Satu kalimat.\n\n\nDua kalimat!');
  assert.equal(stats.paragraph_count, 2);
  assert.equal(stats.sentence_count, 2);
  assert.equal(stats.longest_sentence_words, 2);
  assert.equal(stats.shortest_sentence_words, 2);
});

test('computeStats returns bounded empty values', () => {
  const stats = computeStats('');
  assert.deepEqual({ words: stats.word_count, chars: stats.char_count, paragraphs: stats.paragraph_count }, { words: 0, chars: 0, paragraphs: 0 });
  assert.equal(stats.longest_sentence_words, 0);
  assert.equal(stats.shortest_sentence_words, 0);
});

test('computeStats is deterministic for case differences', () => {
  const text = 'Runut menulis. runut membaca.';
  assert.deepEqual(computeStats(text), computeStats(text));
  assert.equal(computeStats(text).unique_word_count, 3);
});

test('computeScores stays in range for hostile punctuation input', () => {
  const scores = computeScores('!!! ??? ... --- ———');
  for (const value of [scores.similarity.percent, scores.ai_usage.percent]) assert.ok(value >= 0 && value <= 100);
});

test('computeScores changes with repeated content', () => {
  const repeated = Array.from({ length: 12 }, () => 'Data laporan penting berubah sedikit.').join(' ');
  const varied = 'Hujan turun. Buku terbuka. Jalan ramai. Esok cerah.';
  assert.ok(computeScores(repeated).similarity.percent > computeScores(varied).similarity.percent);
});

test('validateAiIssues rejects null payload', () => {
  const result = validateAiIssues(null, 'teks');
  assert.deepEqual(result.valid, []);
  assert.equal(result.dropped, 1);
});

test('validateAiIssues rejects non-array issues', () => {
  const result = validateAiIssues({ issues: {} }, 'teks');
  assert.equal(result.errors.length, 1);
});

test('validateAiIssues rejects null issue entries', () => {
  const result = validateAiIssues({ issues: [null] }, 'teks');
  assert.equal(result.valid.length, 0);
  assert.match(result.errors[0], /bukan objek/);
});

test('validateAiIssues rejects non-integer coordinates', () => {
  const result = validateAiIssues({ issues: [issue('teks', 'teks', { start: 0.5 })] }, 'teks');
  assert.equal(result.valid.length, 0);
  assert.match(result.errors[0], /rentang/);
});

test('validateAiIssues rejects negative coordinates', () => {
  const result = validateAiIssues({ issues: [issue('teks', 'teks', { start: -1, end: 3 })] }, 'teks');
  assert.equal(result.valid.length, 0);
});

test('validateAiIssues rejects reversed coordinates', () => {
  const result = validateAiIssues({ issues: [issue('teks', 'teks', { start: 3, end: 2 })] }, 'teks');
  assert.equal(result.valid.length, 0);
});

test('validateAiIssues rejects mismatched snippets', () => {
  const result = validateAiIssues({ issues: [issue('teks', 'salah', { start: 0, end: 4 })] }, 'teks');
  assert.equal(result.valid.length, 0);
  assert.match(result.errors[0], /tidak cocok/);
});

test('validateAiIssues trims accepted explanation and suggestion', () => {
  const text = 'Teks valid.';
  const result = validateAiIssues({ issues: [issue(text, 'Teks')] }, text);
  assert.equal(result.valid[0].explanation, 'Penjelasan valid.');
  assert.equal(result.valid[0].suggestion, 'Gunakan variasi.');
});

test('validateAiIssues removes duplicate coordinates', () => {
  const text = 'Teks valid.';
  const result = validateAiIssues({ issues: [issue(text, 'Teks'), issue(text, 'Teks')] }, text);
  assert.equal(result.valid.length, 1);
  assert.match(result.errors[0], /duplikat/);
});

test('validateAiIssues enforces maxIssues', () => {
  const text = 'Teks valid.';
  const result = validateAiIssues({ issues: [issue(text, 'Teks'), issue(text, 'Teks', { start: 4, end: 9, text: 'valid' })] }, text, { maxIssues: 1 });
  assert.equal(result.valid.length, 1);
});

test('validateAiIssues flags explicit manual review', () => {
  const text = 'Teks valid.';
  const result = validateAiIssues({ issues: [issue(text, 'Teks', { needs_review: true })] }, text);
  assert.equal(result.valid[0].needs_manual_review, true);
});

test('validateAiIssues flags removed numbers', () => {
  const text = 'Tahun 2026 berlaku.';
  const result = validateAiIssues({ issues: [issue(text, 'Tahun 2026', { suggestion: 'Tahun lalu' })] }, text);
  assert.equal(result.valid[0].needs_manual_review, true);
  assert.match(result.valid[0].review_reasons.join(' '), /angka/);
});

test('validateAiIssues flags removed proper names after first word', () => {
  const text = 'Menurut Bank Indonesia data meningkat.';
  const result = validateAiIssues({ issues: [issue(text, 'Menurut Bank Indonesia', { suggestion: 'Menurut laporan' })] }, text);
  assert.equal(result.valid[0].needs_manual_review, true);
  assert.match(result.valid[0].review_reasons.join(' '), /nama/);
});

test('validateAiIssues limits long explanations and suggestions', () => {
  const text = 'Teks valid.';
  const result = validateAiIssues({ issues: [issue(text, 'Teks', { explanation: 'x'.repeat(1200), suggestion: 'y'.repeat(2200) })] }, text);
  assert.equal(result.valid[0].explanation.length, 1000);
  assert.equal(result.valid[0].suggestion.length, 2000);
});

test('rankIssues handles empty issue list', () => {
  assert.deepEqual(rankIssues([], 'teks'), []);
});

test('rankIssues handles missing snippets without throwing', () => {
  const [result] = rankIssues([{ start_pos: 0, end_pos: 0 }], 'teks');
  assert.equal(result.evidence.occurrences, 0);
  assert.equal(result.evidence.paragraphs, 1);
});

test('rankIssues counts repeated snippets across paragraphs', () => {
  const text = 'Pola sama di sini.\n\nPola sama di sana.';
  const [result] = rankIssues([{ snippet: 'Pola sama', start_pos: 0, end_pos: 9 }], text);
  assert.equal(result.evidence.occurrences, 2);
  assert.equal(result.evidence.paragraphs, 2);
  assert.equal(result.evidence.rank_score, 5);
});

test('rankIssues prioritizes evidence before manual review', () => {
  const text = 'Sama berulang. Sama berulang. Berbeda sekali.';
  const results = rankIssues([
    { snippet: 'Berbeda sekali', start_pos: 31, end_pos: 46, needs_manual_review: true },
    { snippet: 'Sama berulang', start_pos: 0, end_pos: 13, needs_manual_review: false },
  ], text);
  assert.equal(results[0].snippet, 'Sama berulang');
});
