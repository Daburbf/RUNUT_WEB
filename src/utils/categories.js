// Kategori kanonis - cerminan CATEGORIES di backend (sumber kebenaran).
// Warna mengikuti SRS §9: kuning, biru, hijau, ungu, oranye, abu-abu.
// SDD tidak menyelaraskan "keterbacaan" dengan "struktur seragam"; slot oranye
// dipakai untuk struktur seragam agar keenam kategori tetap terwakili
// (lihat docs/KEPUTUSAN_TEKNIS.md, keputusan D3).
// `drives` = skor mana yang dinaikkan kategori ini, mengikuti bobot di
// server/src/services/stats.js (computeScores): repetition -> repeat_content
// (Similarity), sentence_pattern -> repeat_opening (keduanya),
// uniform_structure -> sentence_uniformity + no_short_sentence (Penggunaan AI).
// Tiga kategori sisanya tidak masuk rumus skor, jadi tanpa tanda.
export const CATEGORIES = {
  repetition: { label: 'Pengulangan Kata', icon: 'fa-repeat', color: '#B58900', num: '01', drives: ['similarity'] },
  sentence_pattern: { label: 'Pola Kalimat', icon: 'fa-align-left', color: '#0B57D0', num: '02', drives: ['similarity', 'ai'] },
  uniform_structure: { label: 'Struktur Seragam', icon: 'fa-clone', color: '#C2410C', num: '03', drives: ['ai'] },
  transition: { label: 'Transisi', icon: 'fa-link', color: '#15803D', num: '04', drives: [] },
  formality: { label: 'Tingkat Formalitas', icon: 'fa-user-tie', color: '#7E22CE', num: '05', drives: [] },
  style_consistency: { label: 'Konsistensi Gaya', icon: 'fa-wand-magic-sparkles', color: '#4B5563', num: '06', drives: [] },
};

// Status keputusan saran dipakai konsisten di backend dan frontend.
export const DECISIONS = ['active', 'applied', 'rejected'];

export const canon = (t) => (CATEGORIES[t] ? t : 'transition');

export const FREE_WORD_LIMIT = 500;
// Premium tidak dibatasi jumlah kata; null = tanpa batas (sama dengan server).
export const PREMIUM_WORD_LIMIT = null;
