import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { computeStats, computeScores, countWords, splitSentences } from '../src/services/stats.js';
import { rankIssues, validateAiIssues } from '../src/services/aiValidate.js';
import { splitForAi, mapLimit } from '../src/services/chunk.js';
import {
  calculateTokenCost,
  estimateTextAnalysis,
  findTokenPackage,
  TOKEN_PACKAGES,
} from '../src/services/tokens.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, '../..');

test('calculateTokenCost dan estimateTextAnalysis mengikuti rumus progresif Math.ceil(wordCount / 1000)', () => {
  assert.equal(calculateTokenCost(0), 0);
  assert.equal(calculateTokenCost(-5), 0);
  assert.equal(calculateTokenCost(1), 1);
  assert.equal(calculateTokenCost(20), 1);
  assert.equal(calculateTokenCost(500), 1);
  assert.equal(calculateTokenCost(750), 1);
  assert.equal(calculateTokenCost(1000), 1);
  assert.equal(calculateTokenCost(1001), 2);
  assert.equal(calculateTokenCost(1500), 2);
  assert.equal(calculateTokenCost(2000), 2);
  assert.equal(calculateTokenCost(2001), 3);
  assert.equal(calculateTokenCost(2500), 3);
  assert.equal(calculateTokenCost(3001), 4);
  assert.equal(calculateTokenCost(7200), 8);

  const sample350 = Array.from({ length: 350 }, (_, i) => `kata${i}`).join(' ');
  const est = estimateTextAnalysis(sample350, 10);
  assert.equal(est.word_count, 350);
  assert.equal(est.token_cost, 1);
  assert.equal(est.balance, 10);
  assert.equal(est.balance_after, 9);
  assert.equal(est.sufficient_balance, true);
  assert.equal(est.can_analyze, true);

  assert.equal(TOKEN_PACKAGES.length, 3);
  assert.equal(findTokenPackage('hemat').tokens, 5);
  assert.equal(findTokenPackage('populer').tokens, 10);
  assert.equal(findTokenPackage('lebih_hemat').tokens, 20);
  assert.equal(findTokenPackage('tidak_ada'), null);
});

test('frontend: navbar guest vs login, router scrollBehavior, dan persistensi draf analisis', () => {
  const headerCode = fs.readFileSync(path.join(repoRoot, 'src/components/AppHeader.vue'), 'utf8');
  assert.ok(headerCode.includes('v-if="auth.user"'), 'AppHeader membedakan menu pengguna login dan guest');
  assert.ok(!headerCode.includes('is_premium'), 'AppHeader tidak lagi menampilkan badge Pro/Premium');
  assert.ok(headerCode.includes('/token'), 'AppHeader menampilkan menu Isi Token untuk pengguna login');

  const routerCode = fs.readFileSync(path.join(repoRoot, 'src/router/index.js'), 'utf8');
  assert.ok(routerCode.includes('savedPosition'), 'Vue Router menjaga savedPosition saat navigasi kembali');
  assert.ok(routerCode.includes('to.hash'), 'Vue Router mendukung anchor navigation');
  assert.ok(routerCode.includes('if (to.path === from.path) return false'), 'Perubahan di rute yang sama tidak memaksa scroll ke atas');

  const analysisStoreCode = fs.readFileSync(path.join(repoRoot, 'src/store/analysis.js'), 'utf8');
  assert.ok(analysisStoreCode.includes('sessionStorage'), 'Draf analisis disimpan agar tetap ada setelah berpindah ke halaman pembelian token');

  const resultViewCode = fs.readFileSync(path.join(repoRoot, 'src/views/ResultView.vue'), 'utf8');
  for (const anchor of ['ringkasan', 'tulisan-asli', 'temuan', 'perbaikan', 'unduh']) {
    assert.ok(resultViewCode.includes(`id="${anchor}"`), `ResultView menyediakan bagian navigasi #${anchor}`);
  }
});

test('countWords dan statistik dasar', () => {
  const text = 'Runut memeriksa pola tulisan. Runut menandai pola yang berulang.';
  assert.equal(countWords(text), 9);
  const stats = computeStats(text);
  assert.equal(stats.word_count, 9);
  assert.equal(stats.sentence_count, 2);
  assert.equal(stats.unique_word_count, 7);
  assert.equal(stats.avg_sentence_length, 4.5);
  assert.equal(stats.sentence_length_variation, 0.5);
});

test('kata berulang dihitung, kata umum ditandai', () => {
  const stats = computeStats('dan rumah dan rumah dan pohon dan pohon dan');
  const top = stats.top_words.find((w) => w.word === 'dan');
  assert.ok(top.count >= 5);
  assert.equal(top.common, true, 'kata hubung ditandai sebagai kata umum');
  assert.equal(computeStats('dan rumah dan rumah').top_words.find((w) => w.word === 'rumah').common, false);
});

test('frasa berulang dan pembukaan kalimat berulang terdeteksi', () => {
  const text = 'Selain itu penulis menambah data. Selain itu penulis menyimpulkan. Selain itu penulis menutup.';
  const stats = computeStats(text);
  assert.ok(stats.top_phrases.some((p) => p.phrase === 'selain itu' && p.count === 3));
  assert.ok(stats.repeated_openings.some((o) => o.opening === 'selain itu penulis' && o.count === 3));
});

test('teks kosong dan sangat pendek tidak menghasilkan temuan', () => {
  assert.equal(countWords(''), 0);
  assert.deepEqual(splitSentences(''), []);
  const stats = computeStats('');
  assert.equal(stats.word_count, 0);
  assert.equal(stats.avg_sentence_length, 0);
});

test('validateAiIssues menolak koordinat dan tipe yang tidak sah', () => {
  const text = 'Selain itu penulis menambah data pada laporan tersebut.';
  const parsed = {
    issues: [
      { type: 'repetition', start: 0, end: 10, text: 'Selain itu', explanation: 'Muncul tiga kali.', suggestion: 'Gunakan penghubung lain.' },
      { type: 'pengulangan', start: 0, end: 5, text: 'Selai', explanation: 'x', suggestion: 'y' },
      { type: 'transition', start: 0, end: 999, text: 'Selain itu', explanation: 'x', suggestion: 'y' },
      { type: 'transition', start: 0, end: 10, text: 'selain itu', explanation: 'x', suggestion: 'y' },
      { type: 'transition', start: 0, end: 10, text: 'Selain itu', explanation: '', suggestion: 'y' },
    ],
  };
  const { valid, errors } = validateAiIssues(parsed, text);
  assert.equal(valid.length, 1);
  assert.equal(valid[0].snippet, 'Selain itu');
  assert.equal(errors.length, 4);
});

test('saran yang mengubah angka atau menghapus nama ditandai perlu cek manual', () => {
  const text = 'Pada 2024, laporan Bank Indonesia mencatat kenaikan itu.';
  const at = (needle) => ({ start: text.indexOf(needle), end: text.indexOf(needle) + needle.length, text: needle });
  const { valid } = validateAiIssues({
    issues: [
      { ...at('Pada 2024'), type: 'repetition', explanation: 'Berulang pada paragraf lain di dokumen ini.', suggestion: 'Tahun lalu' },
      { ...at('laporan Bank Indonesia'), type: 'uniform_structure', explanation: 'Pola seragam dengan kalimat sebelumnya.', suggestion: 'laporan itu' },
    ],
  }, text);
  assert.equal(valid.length, 2);
  assert.equal(valid[0].needs_manual_review, true, 'angka hilang pada saran');
  assert.match(valid[0].review_reasons.join(' '), /mengubah angka/);
  assert.equal(valid[1].needs_manual_review, true, 'nama proper hilang pada saran');
});

test('skor kemiripan dan penggunaan AI deterministik, skala 0-100', () => {
  const monoton = Array.from({ length: 8 }, (_, i) => `Selain itu penulis menambahkan data pendukung pada bagian ke ${i + 1}.`).join(' ');
  const bervariasi = 'Hujan turun. Sore itu saya membaca laporan keuangan yang panjang sekali sampai lupa waktu. Lalu tutup buku. Esoknya semuanya berubah tanpa pemberitahuan apa pun kepada kami.';
  const a = computeScores(monoton);
  const b = computeScores(bervariasi);
  for (const s of [a.similarity, a.ai_usage]) {
    assert.ok(s.percent >= 0 && s.percent <= 100, `persen di luar rentang: ${s.percent}`);
    assert.ok(s.signals.length >= 3 && s.label && s.note);
  }
  assert.equal(computeScores(monoton).ai_usage.percent, a.ai_usage.percent, 'hasil harus deterministik');
  assert.ok(a.similarity.percent > b.similarity.percent, 'teks monoton lebih mirip dengan dirinya sendiri');
  assert.ok(a.ai_usage.percent > b.ai_usage.percent, 'teks seragam lebih condong ke pola mesin');
  const kosong = computeScores('');
  assert.equal(kosong.similarity.percent, 0);
  assert.equal(kosong.ai_usage.percent, 0);
});

test('respons AI yang bukan objek issues ditolak', () => {
  const { valid, errors } = validateAiIssues({ hasil: [] }, 'teks apa saja');
  assert.equal(valid.length, 0);
  assert.equal(errors.length, 1);
});

test('rankIssues memakai bukti: kemunculan dan sebaran paragraf', () => {
  const text = 'Selain itu kita menulis.\n\nSelain itu kita merevisi.\n\nKalimat penutup yang berbeda sama sekali di sini.';
  const issues = [
    { snippet: 'Kalimat penutup', start_pos: 55, end_pos: 70, needs_manual_review: false, suggestion: 's', explanation: 'e', category: 'uniform_structure' },
    { snippet: 'Selain itu', start_pos: 0, end_pos: 10, needs_manual_review: false, suggestion: 's', explanation: 'e', category: 'transition' },
  ];
  const ranked = rankIssues(issues, text);
  assert.equal(ranked[0].snippet, 'Selain itu');
  assert.equal(ranked[0].evidence.occurrences, 2);
  assert.equal(ranked[0].evidence.paragraphs, 2);
  assert.ok(ranked[0].evidence.rank_score > ranked[1].evidence.rank_score);
});

test('splitForAi memotong teks panjang tanpa menghilangkan satu karakter pun', () => {
  const paragraph = 'Kalimat ini cukup panjang untuk menguji pemotongan teks oleh Runut. ';
  const text = Array.from({ length: 400 }, () => paragraph).join('\n\n');
  const chunks = splitForAi(text, 6000);
  assert.ok(chunks.length > 1, 'teks panjang menghasilkan lebih dari satu bagian');
  assert.equal(chunks[0].offset, 0);
  assert.equal(chunks.map((c) => c.text).join(''), text, 'tidak ada teks yang hilang');
  for (const c of chunks) {
    assert.ok(c.text.length <= 6000, 'setiap bagian di bawah batas');
    assert.equal(text.slice(c.offset, c.offset + c.text.length), c.text, 'offset menunjuk posisi yang benar');
  }
  assert.deepEqual(splitForAi('pendek'), [{ text: 'pendek', offset: 0 }]);
});

test('mapLimit menjaga urutan hasil sekaligus membatasi paralel', async () => {
  let active = 0;
  let peak = 0;
  const out = await mapLimit([1, 2, 3, 4, 5], 2, async (n) => {
    active += 1;
    peak = Math.max(peak, active);
    await new Promise((r) => setTimeout(r, 5));
    active -= 1;
    return n * 2;
  });
  assert.deepEqual(out, [2, 4, 6, 8, 10]);
  assert.ok(peak <= 2, 'permintaan paralel tidak melebihi batas');
});
