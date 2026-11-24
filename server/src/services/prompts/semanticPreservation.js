// Mandatory Semantic Preservation Engine rules.
// Ensures edits never alter research objectives, findings, numbers, names, equations, or citations.

export function buildSemanticPreservationRules(language = 'id') {
  if (language === 'en') {
    return [
      'MANDATORY SEMANTIC PRESERVATION RULES:',
      '- Before suggesting any edit, identify the paragraph\'s main argument, supporting evidence, technical terms, numbers, and citations.',
      '- Preserve verbatim: research objectives, research questions, findings, conclusions, numerical values, names, dates, measurements, equations, statistical results, technical/legal/scientific terminology, citations, and references.',
      '- NEVER invent information, findings, or citations. NEVER alter numerical results or conclusions.',
      '- If a passage is ambiguous or factually unclear, set "needs_review": true and flag it rather than guessing.',
    ].join('\n');
  }

  return [
    'ATURAN WAJIB PRESERVASI SEMANTIK:',
    '- Sebelum menyarankan perbaikan, pahami argumen utama, bukti pendukung, istilah teknis, angka, dan sitasi pada paragraf.',
    '- Pertahankan secara persis: tujuan penelitian, rumusan masalah, temuan, kesimpulan, nilai numerik, nama orang/lembaga, tanggal, satuan ukuran, persamaan, hasil statistik, istilah teknis/hukum/ilmiah, dan sitasi.',
    '- DILARANG mengarang informasi, temuan, atau sitasi, serta dilarang mengubah hasil numerik atau kesimpulan.',
    '- Jika maksud kalimat tidak jelas atau berisiko berubah maknanya, tandai "needs_review": true untuk ditinjau pengguna; jangan menebak.',
  ].join('\n');
}
