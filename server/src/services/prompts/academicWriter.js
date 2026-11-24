// Adapted from drarunmitra/research-skills (academic-writer & research-writer, CC BY 4.0).
// Enforces academic prose quality, claim-evidence alignment, and citation integrity.

export function buildAcademicWriterRules(language = 'id') {
  if (language === 'en') {
    return [
      'ACADEMIC WRITER PRINCIPLES (adapted from drarunmitra/research-skills, CC BY 4.0):',
      '- Precision over eloquence: every sentence must earn its place.',
      '- Match claim strength to evidence/study design (e.g., observational/correlational -> "associated with", not "proves").',
      '- Preserve all technical terminology, equations, statistical figures (OR, HR, CI, p-values, sample sizes), and units verbatim.',
      '- Preserve all in-text citations and reference markers verbatim; never fabricate or alter author names, years, or DOIs.',
      '- Do not remove important methodological qualifications or limitations.',
      '- Avoid unsupported generalizations ("studies show" without citation, "undoubtedly", "conclusively proves").',
    ].join('\n');
  }

  return [
    'PRINSIP PENULISAN AKADEMIK (diadaptasi dari drarunmitra/research-skills, CC BY 4.0):',
    '- Ketepatan makna lebih utama daripada gaya bahasa berbunga-bunga.',
    '- Selaraskan kekuatan klaim dengan desain penelitian dan bukti (mis. studi korelasional menggunakan "berhubungan dengan", bukan "membuktikan secara kausal").',
    '- Pertahankan seluruh istilah teknis, persamaan, angka statistik (nilai p, CI, OR, ukuran sampel), dan satuan secara persis.',
    '- Pertahankan seluruh sitasi dalam teks secara utuh; dilarang mengarang atau mengubah nama penulis, tahun, atau DOI.',
    '- Jangan menghapus batasan atau kualifikasi metodologis yang penting.',
    '- Hindari klaim umum tanpa rujukan ("para ahli sepakat", "penelitian membuktikan") bila tidak disertai sitasi.',
  ].join('\n');
}
