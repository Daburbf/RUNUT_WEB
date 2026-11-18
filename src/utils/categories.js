// Kategori kanonis - cerminan CATEGORIES di backend (sumber kebenaran).
export const CATEGORIES = {
  repetition: { label: 'Pengulangan Kata', icon: 'fa-repeat', color: '#B58900', num: '01', drives: ['similarity'] },
  sentence_pattern: { label: 'Pola Kalimat', icon: 'fa-align-left', color: '#0B57D0', num: '02', drives: ['similarity', 'ai'] },
  uniform_structure: { label: 'Struktur Seragam', icon: 'fa-clone', color: '#C2410C', num: '03', drives: ['ai'] },
  transition: { label: 'Transisi', icon: 'fa-link', color: '#15803D', num: '04', drives: [] },
  formality: { label: 'Tingkat Formalitas', icon: 'fa-user-tie', color: '#7E22CE', num: '05', drives: [] },
  style_consistency: { label: 'Konsistensi Gaya', icon: 'fa-wand-magic-sparkles', color: '#4B5563', num: '06', drives: [] },
};

export const DECISIONS = ['active', 'applied', 'rejected'];

export const canon = (t) => (CATEGORIES[t] ? t : 'transition');

export const MIN_ANALYSIS_WORDS = 20;
export const WORDS_PER_TOKEN = 1000;
export const AI_MAX_CHARS = 200000;
export const MAX_UPLOAD_BYTES = 5 * 1024 * 1024;

export const TOKEN_PACKAGES = [
  {
    id: 'hemat',
    name: 'Hemat',
    tokens: 5,
    price_idr: 5000,
    price_per_token: 1000,
    popular: false,
    description: 'Cocok untuk memeriksa beberapa esai atau tugas singkat.',
  },
  {
    id: 'populer',
    name: 'Populer',
    tokens: 10,
    price_idr: 9000,
    price_per_token: 900,
    popular: true,
    description: 'Pilihan paling pas untuk mahasiswa dan penulis aktif.',
  },
  {
    id: 'lebih_hemat',
    name: 'Lebih Hemat',
    tokens: 20,
    price_idr: 16000,
    price_per_token: 800,
    popular: false,
    description: 'Pilihan paling hemat untuk naskah panjang atau banyak dokumen.',
  },
];

const WORD_RE = /[\p{L}\p{N}]+(?:['’][\p{L}]+)*/gu;

export function countWords(text) {
  if (!text) return 0;
  const m = String(text).match(WORD_RE);
  return m ? m.length : 0;
}

export function calculateTokenCost(wordCount) {
  const n = Number(wordCount);
  if (!Number.isFinite(n) || n <= 0) return 0;
  return Math.ceil(n / WORDS_PER_TOKEN);
}
