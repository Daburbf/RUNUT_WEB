// Adapted from rijans/agent-skills (skills/humanize-text, MIT License, Copyright (c) 2026 Jaber Al Nahian).
// Focuses on preserving author voice, minimal effective edits, and avoiding unnecessary rewrites.

export function buildHumanizeRules(language = 'id') {
  if (language === 'en') {
    return [
      'HUMANIZE-TEXT PRINCIPLES (adapted from rijans/agent-skills, MIT):',
      '- Make the minimum effective changes needed to improve clarity, flow, and naturalness.',
      '- Preserve the author\'s voice, intent, nuance, uncertainty, and disciplinary register.',
      '- Do NOT rewrite sentences that are already clear, accurate, and natural.',
      '- Prefer concrete nouns, direct verbs, active voice when clearer, and natural sentence-length variation.',
      '- Cut throat-clearing, empty qualifiers, and repeated explanations.',
      '- Never invent facts, benchmarks, personal anecdotes, quotes, or sources.',
      '- Never insert intentional typos, slang, or artificial imperfections.',
    ].join('\n');
  }

  return [
    'PRINSIP HUMANIZE-TEXT (diadaptasi dari rijans/agent-skills, MIT):',
    '- Lakukan perubahan seminimal dan seefektif mungkin; tujuan utama adalah penyuntingan profesional, bukan penulisan ulang total.',
    '- Pertahankan suara penulis, maksud, nuansa, dan ragam keilmuannya.',
    '- JANGAN menulis ulang kalimat yang sudah jelas, akurat, dan alami.',
    '- Utamakan kata benda konkret, kata kerja langsung, kalimat aktif bila lebih jelas, serta variasi panjang kalimat yang wajar.',
    '- Pangkas basa-basi pembuka, penguat kosong, dan pengulangan penjelasan yang tidak menambah informasi.',
    '- Jangan pernah mengarang fakta, tolok ukur, kutipan, atau sumber baru.',
    '- Jangan menyisipkan salah ketik atau bahasa gaul buatan.',
  ].join('\n');
}
