import { countWords } from './stats.js';

export const MIN_ANALYSIS_WORDS = 20;
export const WORDS_PER_TOKEN = 1000;
export const DOWNLOAD_TOKEN_COST = 1;
export const DEFAULT_SIGNUP_BONUS_TOKENS = 10;
export const AI_MAX_CHARS = 200000;
export const MAX_UPLOAD_BYTES = 5 * 1024 * 1024;

export function getSignupBonusTokens() {
  const raw = process.env.SIGNUP_FREE_TOKENS;
  if (raw === undefined || String(raw).trim() === '') return DEFAULT_SIGNUP_BONUS_TOKENS;
  const parsed = Math.trunc(Number(raw));
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : DEFAULT_SIGNUP_BONUS_TOKENS;
}

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

export function findTokenPackage(packageId) {
  const needle = String(packageId || '').trim().toLowerCase();
  return TOKEN_PACKAGES.find((p) => p.id === needle) || null;
}

/**
 * Menghitung biaya token secara progresif berdasarkan jumlah kata.
 * Rumus: cost = Math.ceil(wordCount / 1000)
 * - 1 s.d. 1.000 kata = 1 token
 * - 1.001 s.d. 2.000 kata = 2 token
 * - 2.001 s.d. 3.000 kata = 3 token
 * - setiap tambahan maksimal 1.000 kata menambah 1 token
 */
export function calculateTokenCost(wordCount) {
  const n = Number(wordCount);
  if (!Number.isFinite(n) || n <= 0) return 0;
  return Math.ceil(n / WORDS_PER_TOKEN);
}

export function estimateTextAnalysis(rawText, currentBalance = 0) {
  const text = String(rawText || '').replace(/\r\n/g, '\n');
  const wordCount = countWords(text);
  const charCount = text.length;
  const tokenCost = wordCount > 0 ? calculateTokenCost(wordCount) : 0;
  const balance = Math.max(0, Number(currentBalance) || 0);
  const tooShort = wordCount < MIN_ANALYSIS_WORDS;
  const tooLarge = charCount > AI_MAX_CHARS;
  const sufficientBalance = balance >= tokenCost;

  return {
    word_count: wordCount,
    char_count: charCount,
    token_cost: tokenCost,
    balance,
    balance_after: balance - tokenCost,
    sufficient_balance: sufficientBalance,
    too_short: tooShort,
    too_large: tooLarge,
    can_analyze: !tooShort && !tooLarge && sufficientBalance && tokenCost > 0,
    min_words: MIN_ANALYSIS_WORDS,
    words_per_token: WORDS_PER_TOKEN,
    max_chars: AI_MAX_CHARS,
  };
}

export function getTokenPricingInfo() {
  return {
    min_words: MIN_ANALYSIS_WORDS,
    words_per_token: WORDS_PER_TOKEN,
    download_cost: DOWNLOAD_TOKEN_COST,
    signup_bonus_tokens: getSignupBonusTokens(),
    max_chars: AI_MAX_CHARS,
    max_upload_bytes: MAX_UPLOAD_BYTES,
    packages: TOKEN_PACKAGES,
  };
}
