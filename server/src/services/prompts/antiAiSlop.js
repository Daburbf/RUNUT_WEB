// Adapted from dharmawan-id/anti-ai-slop (MIT License, Copyright (c) 2026 Dharmawan).
// Provides runtime Anti-AI-Slop rules and deterministic pattern detection for Indonesian and English.

export const INDONESIAN_OVERUSED_PHRASES = [
  'dalam era perkembangan teknologi saat ini',
  'seiring dengan perkembangan zaman',
  'tidak dapat dipungkiri bahwa',
  'perlu diketahui bahwa',
  'penting untuk dipahami bahwa',
  'pada dasarnya',
  'selain itu',
  'lebih lanjut',
  'dengan demikian',
  'secara keseluruhan',
  'pada akhirnya',
  'perlu digarisbawahi',
  'sangat penting untuk diperhatikan',
  'terlepas dari hal tersebut',
  'kendati demikian',
  'sehubungan dengan hal tersebut',
];

export const ENGLISH_OVERUSED_PHRASES = [
  'in today\'s rapidly evolving',
  'in an increasingly complex world',
  'it is important to note that',
  'it is worth noting that',
  'plays a pivotal role',
  'plays a crucial role',
  'plays a vital role',
  'underscores the importance of',
  'paving the way for',
  'delve into',
  'rich tapestry',
  'paradigm shift',
  'in conclusion',
];

export function buildAntiAiSlopRules(language = 'id') {
  if (language === 'en') {
    return [
      'ANTI-AI-SLOP RULES (English, adapted from dharmawan-id/anti-ai-slop, MIT):',
      '- Cut generic AI vocabulary when plain words are clearer: delve, leverage, harness, tapestry, realm, landscape (figurative), robust (filler), seamless, pivotal, multifaceted, intricate, underscore, foster.',
      '- Avoid formulaic transitions stacked across paragraphs (Moreover, Furthermore, Additionally, In conclusion) and filler openers ("In today\'s rapidly evolving...", "It is important to note that...").',
      '- Avoid contrast framing ("It is not just X, but Y") and binary false dichotomies ("The question isn\'t X, it\'s Y"). State the claim directly with concrete detail.',
      '- Avoid false agency on inanimate nouns ("the data tells us", "the report highlights"); state the finding or name the actor.',
      '- Avoid trailing "-ing" padding clauses ("..., highlighting the importance of...", "..., paving the way for...").',
      '- Never use em dashes (—) or double hyphens (--) as AI-style parenthetical separators; use commas, parentheses, or periods.',
      '- Vary sentence length and paragraph depth naturally; avoid metronomic 18-24 word sentences.',
      '- Keep terminology consistent; do not rotate synonyms for the same technical entity.',
    ].join('\n');
  }

  return [
    'ATURAN ANTI-AI-SLOP (Bahasa Indonesia, diadaptasi dari dharmawan-id/anti-ai-slop, MIT):',
    '- Hindari pemakaian berlebihan ungkapan generik AI bila tidak benar-benar dibutuhkan konteks: "Dalam era perkembangan teknologi saat ini", "Seiring dengan perkembangan zaman", "Tidak dapat dipungkiri bahwa", "Perlu diketahui bahwa", "Penting untuk dipahami bahwa", "Pada dasarnya", "Selain itu", "Lebih lanjut", "Dengan demikian", "Secara keseluruhan", "Pada akhirnya".',
    '- Hindari klaster penghubung birokratis yang menumpuk ("terlepas dari hal tersebut", "kendati demikian", "sehubungan dengan itu", "berkenaan dengan", "guna mewujudkan") dan kata kerja inflasi ("menyoroti", "menggarisbawahi", "memfasilitasi", "mengoptimalkan", "mengakselerasi") bila kata biasa lebih tepat.',
    '- Hindari "yang mana" atau "di mana" sebagai kata hubung relatif (gunakan "yang"); hindari pembuka definisi kaku dan "menjadi" sebagai peningkat gaya palsu.',
    '- Hindari contrast framing ("bukan sekadar X, melainkan Y", "bukan X tetapi Y") dan dikotomi palsu; nyatakan klaim langsung dengan bukti konkret.',
    '- Hindari agen palsu pada benda mati ("data menunjukkan kepada kita", "kerangka ini memahami"); nyatakan temuan atau pelaku risetnya.',
    '- Jangan gunakan em-dash (—) atau tanda hubung ganda (--); gunakan koma, tanda kurung, atau titik.',
    '- Variasikan panjang kalimat dan kedalaman paragraf; hindari paragraf seragam dan pembuka kalimat yang berulang.',
    '- Jangan mengganti istilah teknis berulang-ulang dengan sinonim buatan; pertahankan konsistensi istilah.',
    '- DILARANG menyengaja salah eja, bahasa gaul, atau ketidaksempurnaan palsu untuk meniru tulisan manusia.',
  ].join('\n');
}

export function detectSlopPatterns(text, language = 'id') {
  const source = String(text || '');
  const lower = source.toLowerCase();
  const list = language === 'en' ? ENGLISH_OVERUSED_PHRASES : INDONESIAN_OVERUSED_PHRASES;
  const hits = [];
  for (const phrase of list) {
    let idx = lower.indexOf(phrase);
    let count = 0;
    const positions = [];
    while (idx !== -1) {
      count += 1;
      positions.push(idx);
      idx = lower.indexOf(phrase, idx + phrase.length);
    }
    if (count > 0) {
      hits.push({ phrase, count, positions });
    }
  }
  const emDashCount = (source.match(/\u2014/g) || []).length;
  if (emDashCount > 0) {
    hits.push({ phrase: '— (em-dash)', count: emDashCount, positions: [] });
  }
  return hits;
}
