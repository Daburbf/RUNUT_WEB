// Automatic Multi-Domain Writing Context Detector (Internal AI Architecture)
// Infers document profile, purpose, audience, tone, formality, and confidence
// directly from pasted text or extracted document content without requiring manual user selection.

export const WRITING_PROFILES = [
  { id: 'academic', label: 'Dokumen Akademik', shortLabel: 'Akademik' },
  { id: 'professional', label: 'Komunikasi & Laporan Profesional', shortLabel: 'Profesional' },
  { id: 'business', label: 'Dokumen Bisnis', shortLabel: 'Bisnis' },
  { id: 'technical', label: 'Dokumentasi Teknis / SOP', shortLabel: 'Teknis' },
  { id: 'marketing', label: 'Konten Marketing', shortLabel: 'Marketing' },
  { id: 'corporate', label: 'Komunikasi Korporat', shortLabel: 'Korporat' },
  { id: 'general', label: 'Tulisan Umum', shortLabel: 'Umum' },
];

export const VALID_PROFILE_IDS = new Set(['auto', ...WRITING_PROFILES.map((p) => p.id)]);

const PROFILE_META = {
  academic: {
    label: 'Dokumen Akademik',
    purpose: 'Menyampaikan argumen ilmiah, metode, atau hasil penelitian berbasis bukti',
    audience: 'Dosen, peneliti, atau pembaca akademik',
    tone: 'Formal, objektif, dan berbasis bukti',
    formality: 'formal',
    reportFocus: ['Konsistensi bahasa akademik', 'Integritas sitasi & daftar pustaka', 'Kualitas klaim & bukti', 'Preservasi istilah ilmiah'],
  },
  professional: {
    label: 'Laporan Profesional',
    purpose: 'Menyampaikan pembaruan kerja, koordinasi, atau rekomendasi operasional secara ringkas',
    audience: 'Rekan kerja, atasan, atau tim internal',
    tone: 'Profesional, lugas, dan langsung pada inti',
    formality: 'semi_formal',
    reportFocus: ['Kejelasan pesan', 'Nada kerja profesional', 'Efektivitas komunikasi', 'Kejelasan tindak lanjut'],
  },
  business: {
    label: 'Dokumen Bisnis',
    purpose: 'Mengajukan proposal, rencana usaha, atau ringkasan keputusan bisnis dan keuangan',
    audience: 'Klien, investor, atau manajemen eksekutif',
    tone: 'Profesional, persuasif, dan berbasis data',
    formality: 'formal',
    reportFocus: ['Kejelasan argumen bisnis', 'Konsistensi proposal', 'Integritas data keuangan', 'Terminologi bisnis'],
  },
  technical: {
    label: 'Dokumentasi Teknis / SOP',
    purpose: 'Menjelaskan prosedur operasional, spesifikasi teknis, atau panduan sistem secara presisi',
    audience: 'Insinyur, operator, atau pengguna teknis',
    tone: 'Presisi teknis, netral, dan instruksional',
    formality: 'neutral_technical',
    reportFocus: ['Kejelasan instruksi langkah demi langkah', 'Konsistensi terminologi teknis', 'Akurasi spesifikasi & angka', 'Urutan prosedur'],
  },
  marketing: {
    label: 'Konten Marketing',
    purpose: 'Memperkenalkan nilai produk/layanan dan mendorong keterlibatan audiens secara alami',
    audience: 'Calon pelanggan atau pembaca publik',
    tone: 'Komunikatif, menarik, dan sesuai suara merek',
    formality: 'conversational',
    reportFocus: ['Konsistensi suara merek', 'Kejelasan pesan nilai', 'Pengurangan frasa promosi berulang', 'Kesesuaian audiens'],
  },
  corporate: {
    label: 'Komunikasi Korporat',
    purpose: 'Menyampaikan kebijakan, pengumuman resmi, surat kelembagaan, atau notulensi rapat',
    audience: 'Karyawan, pimpinan, atau mitra resmi organisasi',
    tone: 'Resmi kelembagaan, terstruktur, dan jelas akuntabilitasnya',
    formality: 'formal',
    reportFocus: ['Kejelasan pesan resmi', 'Ketepatan tanggal & penanggung jawab', 'Konsistensi keputusan & action items', 'Nada kelembagaan'],
  },
  general: {
    label: 'Tulisan Umum',
    purpose: 'Menyampaikan gagasan, cerita, atau informasi umum secara jelas dan alami',
    audience: 'Pembaca umum',
    tone: 'Alami, jernih, dan mempertahankan suara asli penulis',
    formality: 'natural',
    reportFocus: ['Tata bahasa & ejaan', 'Keterbacaan & alur alami', 'Kejelasan makna', 'Pengurangan pengulangan'],
  },
};

const SIGNAL_RULES = {
  academic: [
    { re: /\b(abstrak|abstract|tinjauan pustaka|literature review|metodologi penelitian|methodology|daftar pustaka|references|bibliography|hipotesis|hypothesis|variabel dependen|signifikansi statistik|p-value|skripsi|tesis|disertasi|jurnal ilmiah)\b/gi, weight: 3 },
    { re: /\b(bab\s+[ivx1-9]|pendahuluan|kesimpulan dan saran|responden|kuesioner|sampel penelitian|doi:\s*10\.)\b/gi, weight: 2 },
    { re: /\([A-Z][A-Za-zÀ-ÿ\s.&-]+,\s*(19|20)\d{2}[a-z]?\)/g, weight: 2 },
  ],
  technical: [
    { re: /\b(standard operating procedure|sop\b|prosedur operasional standar|spesifikasi teknis|system specification|instalasi|installation guide|troubleshooting|konfigurasi|configuration|endpoint|api\b|sdk\b|cli\b|server|database|arsitektur sistem|prasyarat|prerequisites|langkah\s+\d+|step\s+\d+)\b/gi, weight: 3 },
    { re: /(`[^`]+`|https?:\/\/|\/api\/|--[a-z0-9-]+|\b(json|yaml|http|tcp|ssl|docker|npm|sql)\b)/gi, weight: 2 },
  ],
  business: [
    { re: /\b(proposal bisnis|business proposal|business plan|rencana bisnis|proyeksi keuangan|financial summary|revenue|pendapatan|laba bersih|profit|roi\b|return on investment|cash flow|arus kas|anggaran|budget|target pasar|market share|kpi\b|stakeholder|nilai investasi|penawaran harga|komersial|strategi bisnis)\b/gi, weight: 3 },
    { re: /\b(rp\s?[\d.,]+|usd\s?[\d.,]+|\$[\d.,]+|kuartal\s+[1-4]|q[1-4]\s*20\d{2}|yoy|mom)\b/gi, weight: 2 },
  ],
  corporate: [
    { re: /\b(notulensi|notulen|minutes of meeting|rapat koordinasi|keputusan rapat|action items?|tindak lanjut|pengumuman internal|surat edaran|kebijakan perusahaan|company policy|hrd|human resources|perihal:|nomor surat|hormat kami|dengan hormat|memo internal|pemberitahuan resmi|deadline|pic\b|penanggung jawab)\b/gi, weight: 3 },
  ],
  marketing: [
    { re: /\b(promo|diskon|penawaran terbatas|beli sekarang|daftar sekarang|coba gratis|free trial|cta\b|call to action|keunggulan produk|fitur unggulan|solusi terbaik|tingkatkan konversi|brand|kampanye|campaign|caption|followers|pelanggan setia|dapatkan segera|klik tautan|produk kami)\b/gi, weight: 3 },
    { re: /#[a-zA-Z0-9_]{2,}/g, weight: 2 },
  ],
  professional: [
    { re: /\b(laporan harian|laporan mingguan|laporan kinerja|progress kerja|status pekerjaan|halo tim|dear team|selamat pagi|selamat siang|terima kasih atas kerja samanya|mohon arahan|mohon tinjauan|executive summary|ringkasan eksekutif|kendala operasional|rencana kerja|deliverable|milestone)\b/gi, weight: 3 },
    { re: /\b(subjek:|subject:|kepada:|cc:|lampiran:|best regards|regards,|salam hangat)\b/gi, weight: 2 },
  ],
};

function refineContextFromText(profile, text, baseMeta) {
  let audience = baseMeta.audience;
  let tone = baseMeta.tone;
  let formality = baseMeta.formality;

  if (profile === 'professional') {
    if (/\b(yth\.|bapak direktur|ibu direktur|dewan direksi|pimpinan|ceo|vp|dear director|dear executive)\b/i.test(text)) {
      audience = 'Direktur / pimpinan eksekutif';
      tone = 'Formal santun, ringkas, dan berorientasi keputusan';
      formality = 'formal';
    } else if (/\b(halo tim|hai teman|rekan-rekan|hi team|hey team)\b/i.test(text)) {
      audience = 'Rekan satu tim';
      tone = 'Profesional hangat, kolaboratif, dan langsung pada inti';
      formality = 'semi_formal';
    }
  } else if (profile === 'business') {
    if (/\b(investor|pendanaan|funding|seri [a-c]|valuasi|roi\b)\b/i.test(text)) {
      audience = 'Investor / pemangku kepentingan pendanaan';
      tone = 'Eksekutif, terukur, dan berbasis data keuangan';
    } else if (/\b(penawaran|klien|client|mitra|vendor)\b/i.test(text)) {
      audience = 'Klien / calon mitra bisnis';
      tone = 'Profesional, persuasif, dan fokus pada nilai solusi';
    }
  }

  return { audience, tone, formality };
}

export function detectWritingProfile(text) {
  const sample = String(text || '');
  const scores = {
    academic: 0,
    professional: 0,
    business: 0,
    technical: 0,
    marketing: 0,
    corporate: 0,
    general: 1,
  };
  const matchedSignals = {};

  for (const [profile, rules] of Object.entries(SIGNAL_RULES)) {
    const hits = [];
    for (const rule of rules) {
      const m = sample.match(rule.re);
      if (m && m.length) {
        scores[profile] += Math.min(m.length, 4) * rule.weight;
        hits.push(...m.slice(0, 3));
      }
    }
    if (hits.length) matchedSignals[profile] = Array.from(new Set(hits.map((h) => h.trim()))).slice(0, 5);
  }

  const ranked = Object.entries(scores).sort((a, b) => b[1] - a[1]);
  const [topProfile, topScore] = ranked[0];
  const [, secondScore] = ranked[1] || ['general', 0];

  const chosen = topScore >= 3 ? topProfile : 'general';
  const confidence = topScore >= 9
    ? 'high'
    : (topScore >= 4 && topScore - secondScore >= 2 ? 'medium' : 'low');
  const conservativeMode = confidence === 'low';
  const meta = PROFILE_META[chosen] || PROFILE_META.general;
  const refined = refineContextFromText(chosen, sample, meta);

  return {
    profile: chosen,
    confidence,
    conservative_mode: conservativeMode,
    uncertain: conservativeMode && chosen !== 'general',
    label: meta.label,
    purpose: meta.purpose,
    audience: refined.audience,
    tone: refined.tone,
    formality: refined.formality,
    report_focus: meta.reportFocus,
    signals: matchedSignals[chosen] || [],
    scores,
  };
}

export function getProfileMeta(profileId) {
  return PROFILE_META[profileId] || PROFILE_META.general;
}
