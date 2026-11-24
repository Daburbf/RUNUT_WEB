import { isCategory, countWords, paragraphSpans, COMMON_WORDS } from './stats.js';

// Validasi keluaran AI sebelum dipakai:
// - struktur JSON dan tipe data
// - kategori hanya dari enam kategori resmi
// - 0 <= start < end <= panjang teks, indeks karakter JavaScript
// - `text` harus sama persis dengan substring teks asli pada rentang itu,
//   sehingga sorotan tidak pernah diletakkan sembarangan
// - saran yang berisiko mengubah makna ditandai perlu cek manual dan tidak
//   boleh diterapkan otomatis
const ALLOWED = new Set(['repetition', 'sentence_pattern', 'uniform_structure', 'transition', 'formality', 'style_consistency']);

const NUMBER_RE = /[\d.,/:%-]+/;
const PROPER_RE = /^[A-ZÀ-Þ][\p{L}]+/u;

function riskScore(original, suggestion) {
  let score = 0;
  const reasons = [];
  const num = original.match(NUMBER_RE);
  if (num && !suggestion.includes(num[0])) {
    score += 2;
    reasons.push('mengubah angka');
  }
  const origWords = original.split(/\s+/).filter(Boolean);
  const sugWords = new Set(suggestion.split(/\s+/).filter(Boolean));
  // Kata pertama kutipan diabaikan karena huruf kapitalnya hanya akibat posisi
  // awal kalimat, bukan penanda nama. Kata umum juga tidak dihitung sebagai
  // nama, supaya saran wajar tidak selalu berakhir "perlu cek manual".
  const droppedProper = origWords.filter((w, i) => i > 0 && PROPER_RE.test(w)
    && !COMMON_WORDS.has(w.toLowerCase()) && !sugWords.has(w));
  if (droppedProper.length) {
    score += 2;
    reasons.push('menghilangkan nama: ' + droppedProper.slice(0, 3).join(', '));
  }
  if (suggestion.length > original.length * 3) {
    score += 1;
    reasons.push('saran jauh lebih panjang dari kutipan');
  }
  if (original.length > 12 && suggestion.length < original.length / 4) {
    score += 1;
    reasons.push('saran jauh lebih pendek dari kutipan');
  }
  return { score, reasons };
}

export function validateAiIssues(parsed, originalText, { maxIssues = 30 } = {}) {
  const errors = [];
  const valid = [];
  if (!parsed || typeof parsed !== 'object' || !Array.isArray(parsed.issues)) {
    return { valid: [], errors: ['Respons AI tidak memuat array "issues".'], dropped: 1 };
  }
  const seen = new Set();
  for (const [idx, raw] of parsed.issues.slice(0, maxIssues).entries()) {
    const where = `issues[${idx}]`;
    if (!raw || typeof raw !== 'object') {
      errors.push(`${where}: bukan objek.`);
      continue;
    }
    const { type, start, end, text, explanation, suggestion } = raw;
    if (!ALLOWED.has(type) || !isCategory(type)) {
      errors.push(`${where}: kategori "${type}" tidak diizinkan.`);
      continue;
    }
    if (!Number.isInteger(start) || !Number.isInteger(end) || start < 0 || end <= start || end > originalText.length) {
      errors.push(`${where}: rentang [${start}, ${end}) di luar teks (panjang ${originalText.length}).`);
      continue;
    }
    if (typeof text !== 'string' || !text.length || originalText.slice(start, end) !== text) {
      errors.push(`${where}: kutipan "text" tidak cocok dengan teks pada rentang ${start}-${end}.`);
      continue;
    }
    if (typeof explanation !== 'string' || !explanation.trim()) {
      errors.push(`${where}: explanation kosong.`);
      continue;
    }
    if (typeof suggestion !== 'string' || !suggestion.trim()) {
      errors.push(`${where}: suggestion kosong.`);
      continue;
    }
    const key = `${type}:${start}:${end}`;
    if (seen.has(key)) {
      errors.push(`${where}: duplikat.`);
      continue;
    }
    seen.add(key);
    const { score, reasons } = riskScore(text, suggestion);
    const needsManual = Boolean(raw.needs_review) || score >= 2;
    valid.push({
      category: type,
      start_pos: start,
      end_pos: end,
      snippet: text,
      explanation: explanation.trim().slice(0, 1000),
      suggestion: suggestion.trim().slice(0, 2000),
      needs_manual_review: needsManual,
      review_reasons: needsManual ? reasons : [],
      section: typeof raw.section === 'string' ? raw.section.trim().slice(0, 160) : null,
      citation_status: typeof raw.citation_status === 'string' ? raw.citation_status.trim().slice(0, 40) : null,
      similarity_review: typeof raw.similarity_review === 'string' ? raw.similarity_review.trim().slice(0, 40) : null,
    });
  }
  return {
    valid,
    errors,
    dropped: errors.length,
    preservation_checks: parsed.preservation_checks && typeof parsed.preservation_checks === 'object'
      ? parsed.preservation_checks
      : null,
  };
}

export function validateStructuredEdits(parsed, blocksById) {
  const errors = [];
  const valid = [];
  if (!parsed || typeof parsed !== 'object' || !Array.isArray(parsed.edits)) {
    return { valid: [], errors: ['Respons AI tidak memuat array "edits".'] };
  }
  const seen = new Set();
  for (const [idx, raw] of parsed.edits.entries()) {
    const where = `edits[${idx}]`;
    if (!raw || typeof raw !== 'object') {
      errors.push(`${where}: bukan objek.`);
      continue;
    }
    const { block_id, original_text, revised_text, reason } = raw;
    if (typeof block_id !== 'string' || !blocksById.has(block_id)) {
      errors.push(`${where}: block_id "${block_id}" tidak valid.`);
      continue;
    }
    if (seen.has(block_id)) {
      errors.push(`${where}: block_id "${block_id}" duplikat.`);
      continue;
    }
    const block = blocksById.get(block_id);
    if (block.protected) {
      errors.push(`${where}: block_id "${block_id}" dilindungi dan tidak boleh diubah.`);
      continue;
    }
    if (typeof original_text !== 'string' || original_text !== block.text) {
      errors.push(`${where}: original_text tidak cocok dengan teks blok asli.`);
      continue;
    }
    if (typeof revised_text !== 'string' || !revised_text.trim()) {
      errors.push(`${where}: revised_text kosong.`);
      continue;
    }
    seen.add(block_id);
    const { score, reasons } = riskScore(original_text, revised_text);
    valid.push({
      block_id,
      section: typeof raw.section === 'string' ? raw.section : (block.section || ''),
      original_text,
      revised_text: revised_text.trim(),
      reason: typeof reason === 'string' ? reason.trim().slice(0, 500) : '',
      citation_status: typeof raw.citation_status === 'string' ? raw.citation_status : 'preserved',
      similarity_review: typeof raw.similarity_review === 'string' ? raw.similarity_review : 'ok',
      needs_manual_review: score >= 2,
      review_reasons: score >= 2 ? reasons : [],
    });
  }
  return { valid, errors };
}

// Pemeringkatan bukti (docs/KEPUTUSAN_TEKNIS.md, D4). Bukan skor keyakinan
// model dan bukan persentase kualitas tulisan - hanya bukti yang bisa
// diperiksa ulang pada teks:
//   kemunculan kutipan di seluruh dokumen  -> bobot 3 per kemunculan tambahan
//   penyebaran pada paragraf berbeda       -> bobot 2 per paragraf tambahan
//   kutipan berupa frasa (>= 4 kata)       -> bobot 1
// Seri diputus secara deterministik: bukan cek manual lebih dulu, lalu kutipan
// lebih panjang, lalu posisi lebih awal.
export function rankIssues(issues, text = '') {
  const spans = paragraphSpans(text);
  const paragraphsOf = (snippet) => {
    const needle = String(snippet || '').toLowerCase();
    if (!needle) return 1;
    let at = text.toLowerCase().indexOf(needle);
    const hit = new Set();
    while (at !== -1) {
      const idx = spans.findIndex(([s, e]) => at >= s && at < e);
      if (idx >= 0) hit.add(idx);
      at = text.toLowerCase().indexOf(needle, at + 1);
    }
    return Math.max(hit.size, 1);
  };
  const scored = issues.map((issue) => {
    const needle = String(issue.snippet || '').toLowerCase();
    let occurrences = 0;
    let at = needle ? text.toLowerCase().indexOf(needle) : -1;
    while (at !== -1) {
      occurrences++;
      at = text.toLowerCase().indexOf(needle, at + 1);
    }
    const paragraphs = paragraphsOf(issue.snippet);
    const spanWords = countWords(String(issue.snippet || ''));
    const score = 3 * Math.max(occurrences - 1, 0) + 2 * (paragraphs - 1) + (spanWords >= 4 ? 1 : 0);
    return { ...issue, evidence: { occurrences, paragraphs, span_words: spanWords, rank_score: score } };
  });
  return scored.sort((a, b) =>
    b.evidence.rank_score - a.evidence.rank_score ||
    Number(a.needs_manual_review) - Number(b.needs_manual_review) ||
    b.end_pos - b.start_pos - (a.end_pos - a.start_pos) ||
    a.start_pos - b.start_pos,
  );
}