// Multi-Domain Writing Profile Modules (7 profiles)
// Each profile loads ONLY the editorial rules appropriate for its actual document purpose.
import { buildAcademicWriterRules } from '../academicWriter.js';

export function buildProfileRules(profile, language = 'id') {
  const isEn = language === 'en';
  switch (profile) {
    case 'academic':
      return buildAcademicWriterRules(language);

    case 'professional':
      return isEn
        ? [
            'PROFESSIONAL WRITING RULES (Work Emails, Internal Reports, Executive Summaries):',
            '- Prioritize clear, direct, concise workplace communication with logical flow.',
            '- Avoid unnecessarily academic or scholarly jargon; never turn a workplace message into a research paper.',
            '- Make requests, ownership, and next steps explicit without inventing tasks or deadlines.',
            '- Keep workplace terminology and colleague/department names exact.',
          ].join('\n')
        : [
            'ATURAN PENULISAN PROFESIONAL (Email Kerja, Laporan Internal, Ringkasan Eksekutif):',
            '- Utamakan komunikasi kerja yang jelas, langsung, ringkas, dan runtut.',
            '- Hindari bahasa akademik yang berbelit; jangan ubah pesan kerja biasa menjadi seperti jurnal ilmiah.',
            '- Perjelas permintaan, tanggung jawab, dan tindak lanjut tanpa mengarang tugas atau tenggat waktu.',
            '- Pertahankan istilah kantor, nama staf/divisi, dan tanggal secara persis.',
          ].join('\n');

    case 'business':
      return isEn
        ? [
            'BUSINESS WRITING RULES (Proposals, Business Plans, Financial & Management Reports):',
            '- Clarify business objectives, value propositions, risks, and actionable recommendations.',
            '- NEVER invent financial figures, revenue, growth rates, ROI, market statistics, or company achievements.',
            '- Preserve all business assumptions, budgets, KPIs, and numerical data verbatim.',
            '- Maintain consistent commercial terminology and executive clarity.',
          ].join('\n')
        : [
            'ATURAN PENULISAN BISNIS (Proposal, Rencana Bisnis, Laporan Manajemen & Keuangan):',
            '- Perjelas tujuan bisnis, argumen nilai, risiko, dan rekomendasi yang dapat ditindaklanjuti.',
            '- JANGAN PERNAH mengarang angka keuangan, pendapatan, tingkat pertumbuhan, statistik pasar, atau pencapaian bisnis.',
            '- Pertahankan seluruh asumsi bisnis, anggaran, KPI, dan angka secara persis.',
            '- Gunakan terminologi bisnis yang konsisten dan profesional.',
          ].join('\n');

    case 'technical':
      return isEn
        ? [
            'TECHNICAL WRITING RULES (SOPs, Software Docs, Specs, Manuals, Engineering Reports):',
            '- Prioritize technical precision, unambiguous wording, and clear step-by-step sequence.',
            '- Intentional repetition of exact technical terms is GOOD for precision — do NOT replace standardized terms with vague synonyms.',
            '- Preserve all code blocks, CLI commands, formulas, measurements, version numbers, config keys, and identifiers verbatim.',
            '- Never oversimplify a technical statement if doing so alters its technical accuracy.',
          ].join('\n')
        : [
            'ATURAN PENULISAN TEKNIS (SOP, Dokumentasi Software, Spesifikasi Sistem, Manual):',
            '- Utamakan ketepatan teknis, kalimat tidak ambigu, dan urutan langkah yang jelas.',
            '- Pengulangan istilah teknis baku adalah hal yang TEPAT demi presisi — jangan menggantinya dengan sinonim longgar.',
            '- Pertahankan kode, perintah CLI, rumus, satuan ukuran, nomor versi, kunci konfigurasi, dan identifier secara persis.',
            '- Jangan menyederhanakan pernyataan teknis bila dapat mengubah maknanya.',
          ].join('\n');

    case 'marketing':
      return isEn
        ? [
            'MARKETING & CONTENT WRITING RULES (Blogs, Web Copy, Product Descriptions, Campaigns):',
            '- Match the intended audience and preserve the original brand voice.',
            '- Eliminate generic hype/cliches and repetitive filler while respecting intentional persuasive rhythm and clear calls to action.',
            '- NEVER invent product features, testimonials, customer counts, guarantees, discounts, or promotional claims.',
            '- Keep brand names, product SKUs, prices, and factual specifications intact.',
          ].join('\n')
        : [
            'ATURAN PENULISAN MARKETING & KONTEN (Blog, Copy Website, Deskripsi Produk, Kampanye):',
            '- Sesuaikan dengan audiens sasaran dan pertahankan suara merek (brand voice) asli.',
            '- Kurangi kalimat promosi generik/klise tanpa merusak ritme persuasif yang disengaja maupun ajakan bertindak (CTA).',
            '- JANGAN PERNAH mengarang fitur produk, testimoni, jumlah pelanggan, jaminan, atau klaim promosi baru.',
            '- Pertahankan nama merek, harga, dan spesifikasi produk secara akurat.',
          ].join('\n');

    case 'corporate':
      return isEn
        ? [
            'CORPORATE COMMUNICATION RULES (Official Letters, Announcements, Meeting Minutes, HR Policies):',
            '- Maintain appropriate institutional tone, clear accountability, and unambiguous action items.',
            '- Preserve all dates, names, titles, policy clauses, decisions, and meeting outcomes verbatim.',
            '- NEVER invent meeting decisions, commitments, deadlines, or employee responsibilities.',
            '- Respect standardized legal/corporate phrasing where required.',
          ].join('\n')
        : [
            'ATURAN KOMUNIKASI KORPORAT (Surat Resmi, Pengumuman Internal, Notulensi Rapat, Kebijakan HR):',
            '- Jaga nada komunikasi kelembagaan yang tepat, pembagian tanggung jawab jelas, dan butir tindak lanjut tegas.',
            '- Pertahankan seluruh tanggal, nama, jabatan, klausul kebijakan, keputusan, dan hasil rapat secara persis.',
            '- JANGAN PERNAH mengarang keputusan rapat, komitmen, tenggat waktu, atau tanggung jawab karyawan.',
            '- Hormati redaksi baku hukum/perusahaan bila memang disengaja.',
          ].join('\n');

    case 'general':
    default:
      return isEn
        ? [
            'GENERAL WRITING RULES (Everyday Writing, Personal Essays, General Articles):',
            '- Keep language natural, clear, and faithful to the author\'s original voice and tone.',
            '- Do NOT force academic or corporate formality onto casual or personal writing.',
            '- Focus on clarity, grammar, readability, and removing unintended repetition.',
          ].join('\n')
        : [
            'ATURAN PENULISAN UMUM (Tulisan Sehari-hari, Artikel Umum, Esai Non-Akademik):',
            '- Jaga bahasa tetap alami, jernih, dan setia pada gaya serta nada asli penulis.',
            '- JANGAN memaksakan formalitas akademik atau korporat pada tulisan santai/personal.',
            '- Fokus pada kejelasan, tata bahasa, keterbacaan, dan pengurangan pengulangan yang tidak disengaja.',
          ].join('\n');
  }
}
