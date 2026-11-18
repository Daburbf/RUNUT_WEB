import { documents, analyses, issues as issuesRepo, tokenTransactions } from '../repositories/index.js';
import { HttpError, asyncHandler } from '../middleware/errors.js';
import { countWords } from '../services/stats.js';
import { calculateTokenCost, DOWNLOAD_TOKEN_COST } from '../services/tokens.js';

const DECISIONS = new Set(['active', 'applied', 'rejected']);

async function ownDocument(userId, id) {
  const doc = await documents.findById(id);
  if (!doc) throw new HttpError(404, 'Dokumen tidak ditemukan.');
  if (doc.user_id !== userId) throw new HttpError(403, 'Anda tidak berhak mengakses dokumen ini.');
  return doc;
}

const latestAnalysis = (documentId) => analyses.findLatestByDocument(documentId);

function assertStillValid(text, issue) {
  const slice = text.slice(issue.start_pos, issue.end_pos);
  if (slice !== issue.snippet) {
    throw new HttpError(409, `Saran "${issue.snippet}" tidak lagi cocok dengan teks pada posisinya. Jalankan analisis ulang sebelum menerapkan saran.`, { code: 'STALE_POSITION', issue_id: issue.id });
  }
}

function buildRevised(original, issues) {
  const applied = issues
    .filter((i) => i.decision === 'applied')
    .sort((a, b) => a.start_pos - b.start_pos);
  let out = '';
  let pos = 0;
  for (const it of applied) {
    if (it.start_pos < pos) continue;
    out += original.slice(pos, it.start_pos) + it.suggestion;
    pos = it.end_pos;
  }
  return out + original.slice(pos);
}

export const listDocuments = asyncHandler(async (req, res) => {
  const q = String(req.query.q || '');
  const status = String(req.query.status || '');
  const list = await documents.listByUser(req.user.id, { q, status, limit: 100 });
  const withCounts = await Promise.all(list.map(async (d) => ({
    id: d.id,
    title: d.title,
    status: d.status,
    word_count: d.word_count,
    token_cost: d.token_cost || calculateTokenCost(d.word_count || 0),
    created_at: d.created_at,
    updated_at: d.updated_at,
    expires_at: d.expires_at,
    pending_count: await issuesRepo.countPendingByDocument(d.id),
  })));
  res.json({ documents: withCounts });
});

export const getDocument = asyncHandler(async (req, res) => {
  const doc = await ownDocument(req.user.id, req.params.id);
  const analysis = await latestAnalysis(doc.id);
  const issues = analysis ? await issuesRepo.listByAnalysis(analysis.id) : [];
  const tokenCost = doc.token_cost || analysis?.token_cost || calculateTokenCost(doc.word_count || 0);
  res.json({
    document: {
      id: doc.id,
      title: doc.title,
      original_text: doc.original_text,
      revised_text: buildRevised(doc.original_text, issues),
      status: doc.status,
      word_count: doc.word_count,
      token_cost: tokenCost,
      created_at: doc.created_at,
      updated_at: doc.updated_at,
      expires_at: doc.expires_at,
    },
    analysis: analysis ? {
      id: analysis.id,
      stats: analysis.stats,
      locked: false,
      token_cost: tokenCost,
      ai: {
        provider: analysis.ai_provider,
        model: analysis.ai_model,
        latencyMs: analysis.ai_latency_ms,
        status: analysis.ai_status,
      },
    } : null,
    issues,
    meta: {
      token_cost: tokenCost,
      total_found: issues.length,
      shown: issues.length,
      locked_note: null,
    },
  });
});

// PATCH /api/documents/:id/issues
export const decideIssues = asyncHandler(async (req, res) => {
  const doc = await ownDocument(req.user.id, req.params.id);
  const analysis = await latestAnalysis(doc.id);
  if (!analysis) throw new HttpError(404, 'Dokumen ini belum memiliki hasil analisis.');

  const issues = await issuesRepo.listByAnalysis(analysis.id);
  const byId = new Map(issues.map((i) => [i.id, i]));

  let targets;
  if (req.body?.accept_all) {
    targets = issues
      .filter((i) => i.decision === 'active' && !i.needs_manual_review)
      .map((i) => ({ id: i.id, decision: 'applied', suggestion: i.suggestion }));
    for (const t of targets) assertStillValid(doc.original_text, byId.get(t.id));
  } else if (Array.isArray(req.body?.decisions)) {
    targets = [];
    for (const d of req.body.decisions) {
      const issue = byId.get(d.id);
      if (!issue) throw new HttpError(404, `Saran ${d.id} tidak ditemukan pada dokumen ini.`);
      if (!DECISIONS.has(d.decision)) throw new HttpError(400, 'decision harus "active", "applied", atau "rejected".');
      if (d.decision === 'applied') {
        assertStillValid(doc.original_text, issue);
        if (issue.needs_manual_review && !d.confirm_manual) {
          throw new HttpError(409, 'Saran ini ditandai perlu cek manual. Tinjau maknanya dulu, lalu kirim ulang dengan confirm_manual: true.', { code: 'NEEDS_MANUAL', issue_id: issue.id });
        }
      }
      targets.push({
        id: issue.id,
        decision: d.decision,
        suggestion: typeof d.suggestion === 'string' && d.suggestion.trim() ? d.suggestion.trim().slice(0, 2000) : issue.suggestion,
      });
    }
  } else {
    throw new HttpError(400, 'Kirim "decisions" atau "accept_all: true".');
  }

  for (const t of targets) await issuesRepo.updateDecision(t.id, { decision: t.decision, suggestion: t.suggestion });
  const fresh = await issuesRepo.listByAnalysis(analysis.id);
  const revised = buildRevised(doc.original_text, fresh);
  await documents.update(doc.id, { revised_text: revised, status: 'revising' });
  res.json({ ok: true, issues: fresh, revised_text: revised, document: { id: doc.id, status: 'revising' } });
});

// POST /api/documents/:id/restore - kembali ke teks asli.
export const restoreOriginal = asyncHandler(async (req, res) => {
  const doc = await ownDocument(req.user.id, req.params.id);
  const analysis = await latestAnalysis(doc.id);
  if (analysis) await issuesRepo.resetDecisions(analysis.id);
  await documents.update(doc.id, { revised_text: null, status: 'analyzed' });
  res.json({ ok: true, revised_text: doc.original_text, issues: analysis ? await issuesRepo.listByAnalysis(analysis.id) : [] });
});

export const renameDocument = asyncHandler(async (req, res) => {
  const doc = await ownDocument(req.user.id, req.params.id);
  const title = String(req.body?.title || '').trim().slice(0, 255);
  if (!title) throw new HttpError(400, 'Judul tidak boleh kosong.');
  await documents.update(doc.id, { title });
  res.json({ ok: true, title });
});

// DELETE /api/documents
export const deleteDocuments = asyncHandler(async (req, res) => {
  const ids = req.body?.ids;
  if (!Array.isArray(ids) || ids.length === 0 || ids.length > 50) {
    throw new HttpError(400, 'Kirim "ids" berisi 1-50 id dokumen.');
  }
  const deleted = await documents.deleteMany(req.user.id, ids);
  if (deleted.length === 0) throw new HttpError(404, 'Tidak ada dokumen milik Anda pada daftar itu.');
  res.json({ ok: true, deleted });
});

// GET /api/documents/:id/download?format=txt|docx|pdf (Biaya: 1 token per unduhan)
export const downloadDocument = asyncHandler(async (req, res) => {
  const doc = await ownDocument(req.user.id, req.params.id);
  const format = String(req.query.format || 'txt').toLowerCase();
  if (!['txt', 'docx', 'pdf'].includes(format)) {
    throw new HttpError(400, 'Format unduhan hanya "pdf", "docx", atau "txt".');
  }

  const deduction = await tokenTransactions.deduct({
    user_id: req.user.id,
    amount: DOWNLOAD_TOKEN_COST,
    description: `Unduh dokumen "${doc.title}" (.${format.toUpperCase()})`,
    reference_type: 'download',
    reference_id: doc.id,
    meta: { document_id: doc.id, format, title: doc.title, token_cost: DOWNLOAD_TOKEN_COST },
  });
  if (!deduction.ok) {
    throw new HttpError(
      402,
      `Saldo token tidak mencukupi untuk mengunduh dokumen. Unduhan membutuhkan ${DOWNLOAD_TOKEN_COST} token, sedangkan saldo Anda ${deduction.balance} token. Silakan isi token terlebih dahulu.`,
      {
        code: 'INSUFFICIENT_TOKENS',
        required: DOWNLOAD_TOKEN_COST,
        balance: deduction.balance,
        shortfall: Math.max(0, DOWNLOAD_TOKEN_COST - deduction.balance),
      },
    );
  }

  try {
    const analysis = await latestAnalysis(doc.id);
    const issues = analysis ? await issuesRepo.listByAnalysis(analysis.id) : [];
    const text = doc.revised_text ?? buildRevised(doc.original_text, issues) ?? doc.original_text;
    const safe = (doc.title || 'runut').replace(/[^\p{L}\p{N}\- ]+/gu, '').trim().slice(0, 80) || 'runut';
    res.setHeader('X-Token-Balance', String(deduction.balance));

    if (format === 'docx') {
      const { Document, Packer, Paragraph, TextRun, HeadingLevel } = await import('docx');
      const file = new Document({
        creator: 'Runut',
        title: doc.title,
        sections: [{
          children: [
            new Paragraph({ text: doc.title || 'Hasil revisi Runut', heading: HeadingLevel.HEADING_1 }),
            new Paragraph({ children: [new TextRun({ text: `Direvisi dengan Runut · ${countWords(text)} kata`, color: '666666', size: 20 })] }),
            ...String(text).split('\n').map((line) => new Paragraph({ children: [new TextRun(line || ' ')] })),
          ],
        }],
      });
      const buf = await Packer.toBuffer(file).catch(() => null);
      if (!buf) throw new HttpError(500, 'Konversi DOCX gagal. Coba unduh dalam format TXT.');
      res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.wordprocessingml.document');
      res.setHeader('Content-Disposition', `attachment; filename="${safe}-revisi.docx"`);
      return res.send(buf);
    }
    if (format === 'pdf') {
      const { buildPdf } = await import('../services/pdf.js');
      const pdf = await buildPdf({
        title: doc.title || 'Hasil revisi Runut',
        meta: `Direvisi dengan Runut - ${countWords(text)} kata - ${new Date().toLocaleDateString('id-ID', { dateStyle: 'long' })}`,
        body: text,
      });
      res.setHeader('Content-Type', 'application/pdf');
      res.setHeader('Content-Disposition', `attachment; filename="${safe}-revisi.pdf"`);
      return res.send(pdf);
    }
    res.setHeader('Content-Type', 'text/plain; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename="${safe}-revisi.txt"`);
    return res.send(text);
  } catch (err) {
    await tokenTransactions.refund({
      user_id: req.user.id,
      amount: DOWNLOAD_TOKEN_COST,
      description: `Pengembalian token: gagal mengunduh "${doc.title}" (.${format.toUpperCase()})`,
      reference_type: 'download_refund',
      reference_id: deduction.transaction?.id || doc.id,
      idempotency_key: deduction.transaction?.id ? `refund:${deduction.transaction.id}` : null,
    }).catch(() => {});
    throw err;
  }
});
