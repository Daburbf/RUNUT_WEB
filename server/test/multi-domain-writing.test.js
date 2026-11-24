import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import http from 'node:http';
import request from 'supertest';
import { Document, Packer, Paragraph, TextRun } from 'docx';

process.env.NODE_ENV = 'test';
process.env.RATE_LIMIT_AUTH_MAX = '1000';
process.env.RATE_LIMIT_ANALYSIS_MAX = '1000';
process.env.JWT_ACCESS_SECRET = 'multi-domain-writing-test-secret-32-chars';

const { createApp } = await import('../src/app.js');
const { tokenTransactions } = await import('../src/repositories/index.js');
const {
  detectWritingProfile,
  buildWritingSystemPrompt,
} = await import('../src/services/prompts/writingEngine.js');

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const app = createApp();

let aiServer;
let lastSystemPrompt = '';

test.before(async () => {
  aiServer = http.createServer((req, res) => {
    let body = '';
    req.on('data', (c) => { body += c; });
    req.on('end', () => {
      const parsed = JSON.parse(body || '{}');
      lastSystemPrompt = parsed?.messages?.find((m) => m.role === 'system')?.content || '';
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ model: 'mock/particle-1', choices: [{ message: { content: '{"issues":[]}' } }] }));
    });
  });
  await new Promise((resolve) => aiServer.listen(0, '127.0.0.1', resolve));
  process.env.AI_PROVIDER = '9router';
  process.env.AI_BASE_URL = `http://127.0.0.1:${aiServer.address().port}`;
  process.env.AI_API_KEY = 'test-key';
  process.env.AI_MODEL = 'mock/particle-1';
});

test.after(async () => {
  await new Promise((resolve) => aiServer.close(resolve));
});

test('Auto-Detection: mendeteksi seluruh 7 profil + inferensi nada, audiens, dan tujuan secara otomatis', () => {
  const cases = [
    {
      expected: 'academic',
      text: 'Abstrak: Penelitian ini menguji pengaruh variabel dependen menggunakan metodologi penelitian kuantitatif pada 120 responden (Santoso, 2024). Tinjauan pustaka dan Daftar Pustaka terlampir.',
    },
    {
      expected: 'professional',
      text: 'Subjek: Laporan Harian Operasional. Yth. Bapak Direktur, berikut status pekerjaan dan progress kerja minggu ini serta kendala operasional. Mohon arahan dan tindak lanjut.',
      expectedAudienceMatch: /Direktur|eksekutif/i,
    },
    {
      expected: 'professional',
      text: 'Subjek: Update Mingguan. Halo tim, berikut progress kerja dan status pekerjaan minggu ini beserta deliverable yang sudah selesai. Terima kasih atas kerja samanya.',
      expectedAudienceMatch: /tim/i,
    },
    {
      expected: 'business',
      text: 'Proposal Bisnis dan Rencana Bisnis Ekspansi 2026 untuk investor. Proyeksi keuangan menunjukkan pendapatan Rp2.500.000.000 dengan ROI 24% pada Q4 2026 dan strategi target pasar komersial.',
      expectedAudienceMatch: /Investor/i,
    },
    {
      expected: 'technical',
      text: 'Standard Operating Procedure (SOP) Instalasi Server. Prasyarat: Docker dan PostgreSQL. Langkah 1: jalankan `npm ci` lalu periksa konfigurasi endpoint `/api/health` dan spesifikasi teknis database.',
    },
    {
      expected: 'marketing',
      text: 'Tingkatkan konversi bisnis Anda dengan fitur unggulan produk kami! Nikmati promo diskon penawaran terbatas hari ini. Coba gratis sekarang dan daftar sekarang untuk pelanggan setia! #RunutID',
    },
    {
      expected: 'corporate',
      text: 'Notulensi Rapat Koordinasi dan Surat Edaran Internal. Perihal: Kebijakan Perusahaan HRD. Keputusan rapat menetapkan penanggung jawab (PIC) dan action items sesuai deadline yang disepakati.',
    },
    {
      expected: 'general',
      text: 'Hari ini saya berjalan santai di taman kota sambil menikmati udara pagi yang sejuk. Banyak warga berolahraga bersama keluarga dan anak-anak bermain sepeda dengan riang.',
    },
  ];

  for (const c of cases) {
    const det = detectWritingProfile(c.text);
    assert.equal(det.profile, c.expected, `Seharusnya "${c.expected}", mendapat "${det.profile}"`);
    assert.ok(det.tone && det.audience && det.purpose, 'tone, audience, dan purpose wajib terinferensi otomatis');
    if (c.expectedAudienceMatch) {
      assert.match(det.audience, c.expectedAudienceMatch);
    }
  }
});

test('Simplified Frontend UI: AnalyzeView.vue tidak menampilkan pemilih mode manual, input nada/audiens, atau input referensi manual', () => {
  const analyzeVue = readFileSync(path.resolve(__dirname, '../../src/views/AnalyzeView.vue'), 'utf8');
  assert.doesNotMatch(analyzeVue, /writing-mode-select|WRITING_MODES|Mode Penulisan/i);
  assert.doesNotMatch(analyzeVue, /Atur Nada & Audiens|showAdvancedTone/i);
  assert.doesNotMatch(analyzeVue, /\+ Referensi|showReferenceBox|referenceText/i);
});

test('Auto-Detection Runtime E2E: teks tempel & unggahan DOCX otomatis dideteksi profil, nada, dan audiensnya tanpa parameter manual', async () => {
  const email = `auto-${Date.now()}@runut.test`;
  const reg = await request(app).post('/api/auth/register').send({ name: 'Auto Context', email, password: 'Password123!' });
  assert.equal(reg.status, 201);
  await tokenTransactions.credit({ user_id: reg.body.user.id, amount: 5, type: 'purchase', description: 'Saldo uji otomatis' });
  const auth = { Authorization: `Bearer ${reg.body.accessToken}` };

  // 1. Teks tempel (Proposal Bisnis) — tanpa writing_mode/tone/audience
  const text = 'Proposal Bisnis Ekspansi Q3 2026 untuk investor. Proyeksi keuangan menargetkan pendapatan Rp1.200.000.000 dengan arus kas sehat dan ROI terukur bagi seluruh stakeholder perusahaan dalam rencana bisnis tahunan.';
  const resText = await request(app)
    .post('/api/analysis')
    .set(auth)
    .send({ text, title: 'Proposal Ekspansi', ai_consent: true });

  assert.equal(resText.status, 201);
  assert.equal(resText.body.analysis.stats.writing_profile, 'business');
  assert.equal(resText.body.analysis.stats.writing_profile_auto_detected, true);
  assert.ok(resText.body.analysis.stats.inferred_tone);
  assert.ok(resText.body.analysis.stats.inferred_audience);
  assert.ok(resText.body.analysis.stats.detected_purpose);
  assert.match(lastSystemPrompt, /ATURAN PENULISAN BISNIS/);
  assert.doesNotMatch(lastSystemPrompt, /ATURAN PENULISAN AKADEMIK/);

  // 2. Unggahan DOCX (SOP Teknis) — tanpa parameter manual
  const doc = new Document({
    sections: [{
      children: [
        new Paragraph({
          children: [new TextRun('Standard Operating Procedure (SOP) Instalasi Server Produksi. Prasyarat sistem meliputi Docker dan database PostgreSQL. Langkah 1 jalankan konfigurasi endpoint API dan periksa spesifikasi teknis server sebelum rilis.')],
        }),
      ],
    }],
  });
  const docxBuf = await Packer.toBuffer(doc);
  const resDocx = await request(app)
    .post('/api/analysis')
    .set(auth)
    .field('ai_consent', 'true')
    .attach('file', docxBuf, { filename: 'sop-instalasi.docx', contentType: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document' });

  assert.equal(resDocx.status, 201);
  assert.equal(resDocx.body.analysis.stats.writing_profile, 'technical');
  assert.equal(resDocx.body.analysis.stats.writing_profile_auto_detected, true);
  assert.match(lastSystemPrompt, /ATURAN PENULISAN TEKNIS/);
  assert.doesNotMatch(lastSystemPrompt, /ATURAN PENULISAN AKADEMIK/);
});
