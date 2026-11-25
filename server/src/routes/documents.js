import { documents, analyses, issues as issuesRepo, tokenTransactions, downloadTransactions } from '../repositories/index.js';
import { HttpError, asyncHandler } from '../middleware/errors.js';
import { countWords } from '../services/stats.js';
import { calculateTokenCost, DOWNLOAD_TOKEN_COST } from '../services/tokens.js';
import { getOriginalUploadPersistent, deleteOriginalUploadPersistent } from '../services/fileStore.js';
import { applyDocxEdits } from '../services/docxEditor.js';
import { applyPdfEdits, comparePdfVisually, evaluatePdfTextOverflow } from '../services/pdfEditor.js';
import { convertDocxBufferToPdf } from '../services/docxToPdf.js';
import { buildAnalysisReport } from '../services/reports/analysisReportService.js';
import { generateAnalysisReportPdf } from '../services/reports/reportPdfService.js';
import { generateAnalysisReportDocx } from '../services/reports/reportDocxService.js';
import { annotateOriginalDocx, annotateOriginalPdf } from '../services/reports/annotatedDocumentService.js';

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
      file_name: doc.file_name || null,
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
        fallback_used: Boolean(analysis.stats?.ai_fallback_used),
        primary_error: analysis.stats?.ai_primary_error || null,
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
  for (const id of deleted) await deleteOriginalUploadPersistent(id);
  res.json({ ok: true, deleted });
});

// GET /api/documents/:id/preservation - verifikasi status preservasi dokumen asli secara nyata.
export const getDocumentPreservation = asyncHandler(async (req, res) => {
  const doc = await ownDocument(req.user.id, req.params.id);
  const analysis = await latestAnalysis(doc.id);
  const issues = analysis ? await issuesRepo.listByAnalysis(analysis.id) : [];
  const applied = issues.filter((i) => i.decision === 'applied');
  const orig = await getOriginalUploadPersistent(doc.id, { userId: doc.user_id });

  if (!orig) {
    return res.json({
      has_original_file: false,
      format: 'text',
      verified: false,
      note: 'Dokumen ini dibuat dari teks editor tanpa berkas unggahan DOCX/PDF asli. Ekspor akan membuat dokumen baru dari teks hasil revisi.',
      checks: null,
    });
  }

  if (orig.ext === 'docx') {
    const result = await applyDocxEdits(orig.buffer, { issueEdits: applied });
    return res.json({
      has_original_file: true,
      format: 'docx',
      verified: result.verification.verified,
      classification: result.verification.classification || (result.verification.verified ? 'preserved' : 'validation_failed'),
      applied_count: result.applied_count,
      skipped_count: result.skipped_count,
      checks: result.verification.checks,
      note: result.verification.verified
        ? 'Template DOCX asli terverifikasi utuh. Hanya teks yang disetujui yang diubah.'
        : 'Sebagian pemeriksaan struktur DOCX tidak terverifikasi identik. Periksa dokumen hasil unduhan.',
    });
  }

  const pdfMeta = analysis?.stats?.document_metadata || {};
  const pdfResult = await applyPdfEdits(orig.buffer, applied);
  const visualComparison = pdfResult.modified
    ? await comparePdfVisually(orig.buffer, pdfResult.buffer, { editedRegions: pdfResult.applied }).catch(() => null)
    : null;
  const overflow = evaluatePdfTextOverflow(applied);
  const allSafe = applied.length === 0 || (pdfResult.flagged_count === 0 && Boolean(visualComparison?.layout_preserved));
  const pdfClassification = pdfMeta.is_scanned
    ? 'unsafe_to_edit'
    : (applied.length === 0 || allSafe
      ? 'preserved'
      : (pdfResult.applied_count > 0 ? 'partially_preserved' : 'unsafe_to_edit'));

  return res.json({
    has_original_file: true,
    format: 'pdf',
    verified: allSafe,
    classification: pdfClassification,
    is_scanned: Boolean(pdfMeta.is_scanned),
    is_mixed: Boolean(pdfMeta.is_mixed),
    has_subset_fonts: Boolean(pdfMeta.has_subset_fonts),
    editable_status: pdfMeta.editable_status || 'editable_fixed_layout',
    editing_strategy: pdfResult.inspection?.editing_strategy || null,
    applied_in_place: pdfResult.applied_count,
    flagged_regions: pdfResult.flagged_regions,
    recommend_docx: pdfResult.recommend_docx || Boolean(pdfMeta.is_scanned),
    visual_comparison: visualComparison,
    overflow,
    checks: {
      original_formatting_preserved: allSafe,
      tables_preserved: allSafe,
      images_preserved: allSafe,
      headers_footers_preserved: allSafe,
      bibliography_preserved: true,
      page_configuration_preserved: visualComparison ? visualComparison.page_count_match : (applied.length === 0),
    },
    note: pdfMeta.is_scanned
      ? 'PDF hasil pindai (berbasis gambar). Teks hasil OCR dapat ditinjau terpisah, namun unggah berkas sumber DOCX untuk penyuntingan dengan preservasi tata letak penuh.'
      : (applied.length === 0
        ? 'Belum ada perubahan diterapkan; unduhan PDF akan mengembalikan berkas asli secara utuh.'
        : (allSafe
          ? `Perubahan diterapkan in-place pada ${pdfResult.applied_count} area aman (kemiripan visual ${visualComparison?.average_visual_similarity_percent ?? 100}%).`
          : `${pdfResult.flagged_count} area tidak dapat diubah in-place secara aman (overflow/subset font/multi-baris). Unggah berkas sumber DOCX untuk preservasi penuh.`)),
  });
});

const EXPORT_FORMATS = new Set(['txt', 'docx', 'pdf']);
const RESERVATION_TTL_SECONDS = Math.max(60, Number(process.env.DOWNLOAD_RESERVATION_TTL_SECONDS || 300));

function validateExportBuffer(format, data) {
  const buf = Buffer.isBuffer(data) ? data : Buffer.from(String(data ?? ''), 'utf8');
  if (format === 'docx') {
    if (buf.length < 4 || buf[0] !== 0x50 || buf[1] !== 0x4b) {
      throw new HttpError(500, 'File hasil ekspor gagal melewati pemeriksaan keamanan.', { code: 'EXPORT_VALIDATION_FAILED' });
    }
  } else if (format === 'pdf') {
    if (buf.length < 5 || buf.subarray(0, 5).toString('latin1') !== '%PDF-') {
      throw new HttpError(500, 'File hasil ekspor gagal melewati pemeriksaan keamanan.', { code: 'EXPORT_VALIDATION_FAILED' });
    }
  }
  return buf;
}

async function prepareExportArtifact(doc, format) {
  const analysis = await latestAnalysis(doc.id);
  const issues = analysis ? await issuesRepo.listByAnalysis(analysis.id) : [];
  const appliedIssues = issues.filter((i) => i.decision === 'applied');
  const text = doc.revised_text ?? buildRevised(doc.original_text, issues) ?? doc.original_text;
  const rawBaseName = (doc.file_name ? doc.file_name.replace(/\.[^.]+$/, '') : (doc.title || 'dokumen'));
  const safe = rawBaseName.replace(/[^\p{L}\p{N}\-_ ]+/gu, '').trim().replace(/\s+/g, '_').slice(0, 80) || 'dokumen';
  const headers = {};

  if (format === 'docx') {
    const orig = await getOriginalUploadPersistent(doc.id, { userId: doc.user_id });
    if (orig && orig.ext === 'docx') {
      const edited = await applyDocxEdits(orig.buffer, { issueEdits: appliedIssues });
      if (!edited.verification?.verified && String(process.env.STRICT_TEMPLATE_PRESERVATION ?? 'true') !== 'false') {
        throw new HttpError(
          422,
          'Validasi preservasi template DOCX asli gagal. Dokumen tidak diubah demi menjaga struktur asli.',
          { code: 'TEMPLATE_PRESERVATION_VALIDATION_FAILED', checks: edited.verification?.checks || null },
        );
      }
      const buf = validateExportBuffer('docx', edited.buffer);
      headers['X-Preservation-Mode'] = 'template-preserved';
      headers['X-Preservation-Status'] = 'docx_template_preserved';
      headers['X-Preservation-Classification'] = edited.verification?.classification || 'preserved';
      headers['X-Preservation-Verified'] = String(Boolean(edited.verification?.verified));
      return {
        buffer: buf,
        contentType: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
        filename: `${safe}_revised.docx`,
        headers,
      };
    }

    // Jangan pernah diam-diam mengganti template PDF unggahan atau DOCX yang hilang dengan DOCX teks polos generik!
    if (orig && orig.ext === 'pdf') {
      throw new HttpError(
        422,
        'Dokumen ini diunggah sebagai PDF. Unduh dalam format .PDF untuk mempertahankan template PDF asli, atau unduh .TXT untuk mengambil teks revisi saja.',
        { code: 'FORMAT_MISMATCH_USE_PDF' },
      );
    }
    if (doc.file_name && /\.(docx|doc|pdf)$/i.test(doc.file_name)) {
      throw new HttpError(
        409,
        'Berkas template asli sudah tidak tersedia di penyimpanan server. Unggah ulang berkas sumber untuk menjaga template asli, atau unduh .TXT untuk teks revisi.',
        { code: 'ORIGINAL_TEMPLATE_MISSING' },
      );
    }

    const { Document, Packer, Paragraph, TextRun } = await import('docx');
    const file = new Document({
      title: doc.title || undefined,
      sections: [{
        children: String(text).split('\n').map((line) => new Paragraph({ children: [new TextRun(line || ' ')] })),
      }],
    });
    const rawBuf = await Packer.toBuffer(file).catch(() => null);
    if (!rawBuf) {
      throw new HttpError(500, 'File gagal dibuat. Silakan coba kembali.', { code: 'DOCX_GENERATION_FAILED' });
    }
    const buf = validateExportBuffer('docx', rawBuf);
    headers['X-Preservation-Mode'] = 'generated-from-text';
    return {
      buffer: buf,
      contentType: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
      filename: `${safe}-revisi.docx`,
      headers,
    };
  }

  if (format === 'pdf') {
    const orig = await getOriginalUploadPersistent(doc.id, { userId: doc.user_id });

    if (orig && orig.ext === 'pdf') {
      if (appliedIssues.length === 0) {
        const buf = validateExportBuffer('pdf', orig.buffer);
        headers['X-Preservation-Mode'] = 'original-unchanged';
        headers['X-Preservation-Status'] = 'pdf_template_preserved';
        headers['X-Preservation-Classification'] = 'preserved';
        headers['X-Preservation-Verified'] = 'true';
        return { buffer: buf, contentType: 'application/pdf', filename: `${safe}_revised.pdf`, headers };
      }

      const edited = await applyPdfEdits(orig.buffer, appliedIssues);
      if (edited.modified) {
        const visual = await comparePdfVisually(orig.buffer, edited.buffer, { editedRegions: edited.applied }).catch(() => null);
        if (visual && visual.layout_preserved && !visual.white_patch_artifacts_detected) {
          const buf = validateExportBuffer('pdf', edited.buffer);
          headers['X-Preservation-Mode'] = 'pdf-inplace-preserved';
          headers['X-Preservation-Status'] = 'pdf_native_edit_success';
          headers['X-Preservation-Classification'] = edited.flagged_count === 0 ? 'preserved' : 'partially_preserved';
          headers['X-Preservation-Verified'] = String(edited.flagged_count === 0);
          headers['X-Visual-Similarity'] = String(visual.average_visual_similarity_percent);
          if (edited.recommend_docx) headers['X-Recommend-Docx'] = 'true';
          return { buffer: buf, contentType: 'application/pdf', filename: `${safe}_revised.pdf`, headers };
        }
        const buf = validateExportBuffer('pdf', orig.buffer);
        headers['X-Preservation-Mode'] = 'original-retained-validation-failed';
        headers['X-Preservation-Status'] = 'pdf_validation_failed';
        headers['X-Preservation-Classification'] = 'validation_failed';
        headers['X-Preservation-Verified'] = 'false';
        headers['X-Recommend-Docx'] = 'true';
        return { buffer: buf, contentType: 'application/pdf', filename: `${safe}_revised.pdf`, headers };
      }

      const buf = validateExportBuffer('pdf', orig.buffer);
      headers['X-Preservation-Mode'] = 'original-retained-unsafe-edit';
      headers['X-Preservation-Status'] = 'pdf_edit_unsafe';
      headers['X-Preservation-Classification'] = 'unsafe_to_edit';
      headers['X-Preservation-Verified'] = 'false';
      headers['X-Unapplied-Edits'] = String(edited.flagged_count);
      headers['X-Recommend-Docx'] = 'true';
      return { buffer: buf, contentType: 'application/pdf', filename: `${safe}_revised.pdf`, headers };
    }

    if (orig && orig.ext === 'docx') {
      const editedDocx = await applyDocxEdits(orig.buffer, { issueEdits: appliedIssues });
      const converted = await convertDocxBufferToPdf(editedDocx.buffer);
      if (converted.ok) {
        const buf = validateExportBuffer('pdf', converted.buffer);
        headers['X-Preservation-Mode'] = 'docx-template-converted-pdf';
        headers['X-Preservation-Status'] = 'docx_pdf_conversion_success';
        headers['X-Preservation-Classification'] = editedDocx.verification?.classification || 'preserved';
        headers['X-Preservation-Verified'] = String(Boolean(editedDocx.verification?.verified));
        return { buffer: buf, contentType: 'application/pdf', filename: `${safe}_revised.pdf`, headers };
      }
      throw new HttpError(
        503,
        converted.reason || 'Konversi PDF belum tersedia. Silakan unduh DOCX atau periksa konfigurasi server.',
        {
          code: converted.code || 'CONVERTER_UNAVAILABLE',
          preservation_status: converted.status || 'docx_pdf_converter_unavailable',
          install_guidance: converted.install_guidance || null,
        },
      );
    }

    // Jangan pernah diam-diam merekonstruksi PDF teks polos dari dokumen unggahan yang berkas aslinya sudah hilang!
    if (doc.file_name && /\.(docx|doc|pdf)$/i.test(doc.file_name)) {
      throw new HttpError(
        409,
        'Berkas template asli sudah tidak tersedia di penyimpanan server. Unggah ulang berkas sumber untuk menjaga template asli, atau unduh .TXT untuk teks revisi.',
        { code: 'ORIGINAL_TEMPLATE_MISSING' },
      );
    }

    const overflow = evaluatePdfTextOverflow(appliedIssues);
    if (overflow.has_overflow_risk) {
      headers['X-Overflow-Risk'] = 'true';
    }
    const { buildPdf } = await import('../services/pdf.js');
    const rawPdf = await buildPdf({
      title: '',
      meta: '',
      body: text,
      includePageNumbers: false,
    });
    const buf = validateExportBuffer('pdf', rawPdf);
    headers['X-Preservation-Mode'] = 'generated-from-text';
    return { buffer: buf, contentType: 'application/pdf', filename: `${safe}_revised.pdf`, headers };
  }

  const buf = validateExportBuffer('txt', text);
  return { buffer: buf, contentType: 'text/plain; charset=utf-8', filename: `${safe}-revisi.txt`, headers };
}

// Phase A: POST /api/documents/:id/download/reserve
// Memesan token secara sementara tanpa memotong saldo permanen sampai file dikonfirmasi tersimpan.
export const reserveDocumentDownload = asyncHandler(async (req, res) => {
  const doc = await ownDocument(req.user.id, req.params.id);
  const format = String(req.body?.format || req.query?.format || 'txt').toLowerCase();
  if (!EXPORT_FORMATS.has(format)) {
    throw new HttpError(400, 'Format unduhan hanya "pdf", "docx", atau "txt".', { code: 'INVALID_FORMAT' });
  }
  const idempotencyKey = req.headers['idempotency-key'] || req.body?.idempotency_key || null;
  const result = await downloadTransactions.reserve({
    user_id: req.user.id,
    document_id: doc.id,
    export_format: format,
    reserved_tokens: DOWNLOAD_TOKEN_COST,
    idempotency_key: idempotencyKey,
    ttl_seconds: RESERVATION_TTL_SECONDS,
  });

  if (!result.ok) {
    throw new HttpError(
      402,
      `Token Anda tidak mencukupi untuk mengunduh file ini. Dibutuhkan ${DOWNLOAD_TOKEN_COST} token, tersedia ${result.available_balance ?? 0} token.`,
      {
        code: 'INSUFFICIENT_TOKENS',
        required: DOWNLOAD_TOKEN_COST,
        balance: result.balance ?? 0,
        reserved_tokens: result.reserved_tokens ?? 0,
        available_balance: result.available_balance ?? 0,
        shortfall: Math.max(0, DOWNLOAD_TOKEN_COST - (result.available_balance ?? 0)),
      },
    );
  }

  res.status(result.duplicate ? 200 : 201).json({
    ok: true,
    duplicate: Boolean(result.duplicate),
    transaction: result.transaction,
    balance: result.balance,
    reserved_tokens: result.reserved_tokens,
    available_balance: result.available_balance,
  });
});

// Phase A.2: GET /api/documents/:id/download/file?tx=<transactionId>
// Menghasilkan & memvalidasi file untuk reservasi yang sah. Bila gagal, reservasi dilepas tanpa memotong token.
export const fetchPreparedDownload = asyncHandler(async (req, res) => {
  const doc = await ownDocument(req.user.id, req.params.id);
  const txId = String(req.query.tx || '').trim();
  if (!txId) {
    throw new HttpError(400, 'ID transaksi unduhan (tx) wajib disertakan.', { code: 'MISSING_TRANSACTION_ID' });
  }
  const tx = await downloadTransactions.findById(txId);
  if (!tx) {
    throw new HttpError(404, 'Transaksi unduhan tidak ditemukan.', { code: 'TRANSACTION_NOT_FOUND' });
  }
  if (tx.user_id !== req.user.id || tx.document_id !== doc.id) {
    throw new HttpError(403, 'Anda tidak berhak mengakses transaksi unduhan ini.', { code: 'TRANSACTION_FORBIDDEN' });
  }
  if (!['reserved', 'file_prepared'].includes(tx.state)) {
    throw new HttpError(409, `Transaksi unduhan tidak aktif (status: ${tx.state}).`, { code: 'RESERVATION_NOT_ACTIVE', state: tx.state });
  }
  if (new Date(tx.expires_at).getTime() <= Date.now()) {
    await downloadTransactions.releaseExpired();
    throw new HttpError(410, 'Reservasi unduhan sudah kedaluwarsa. Token Anda tidak dipotong; silakan mulai unduhan ulang.', { code: 'RESERVATION_EXPIRED' });
  }

  try {
    const artifact = await prepareExportArtifact(doc, tx.export_format);
    await downloadTransactions.markPrepared(tx.id, req.user.id);
    for (const [k, v] of Object.entries(artifact.headers)) {
      res.setHeader(k, v);
    }
    res.setHeader('X-Download-Transaction-Id', tx.id);
    res.setHeader('Content-Type', artifact.contentType);
    res.setHeader('Content-Disposition', `attachment; filename="${artifact.filename}"`);
    return res.send(artifact.buffer);
  } catch (err) {
    await downloadTransactions.markFailed(tx.id, req.user.id, err?.message || 'File generation failed').catch(() => {});
    throw err;
  }
});

// Phase B: POST /api/documents/:id/download/:txId/commit
// Memotong token secara permanen & atomik HANYA setelah penyimpanan file dikonfirmasi.
export const commitDocumentDownload = asyncHandler(async (req, res) => {
  const doc = await ownDocument(req.user.id, req.params.id);
  const txId = String(req.params.txId || '').trim();
  const tx = await downloadTransactions.findById(txId);
  if (!tx) {
    throw new HttpError(404, 'Transaksi unduhan tidak ditemukan.', { code: 'TRANSACTION_NOT_FOUND' });
  }
  if (tx.user_id !== req.user.id || tx.document_id !== doc.id) {
    throw new HttpError(403, 'Anda tidak berhak mengonfirmasi transaksi unduhan ini.', { code: 'TRANSACTION_FORBIDDEN' });
  }

  const result = await downloadTransactions.commit({
    id: tx.id,
    user_id: req.user.id,
    description: `Unduh dokumen "${doc.title}" (.${String(tx.export_format || 'txt').toUpperCase()})`,
    meta: { document_id: doc.id, title: doc.title, format: tx.export_format, token_cost: tx.reserved_tokens },
  });

  if (!result.ok) {
    if (result.error === 'RESERVATION_EXPIRED') {
      throw new HttpError(410, 'Reservasi unduhan sudah kedaluwarsa. Token Anda tidak dipotong.', { code: 'RESERVATION_EXPIRED' });
    }
    if (result.error === 'INSUFFICIENT_TOKENS') {
      throw new HttpError(402, 'Token Anda tidak mencukupi untuk menyelesaikan unduhan ini.', { code: 'INSUFFICIENT_TOKENS', balance: result.balance ?? 0 });
    }
    throw new HttpError(409, 'Konfirmasi unduhan belum berhasil. Status transaksi tidak dapat dikomit.', { code: result.error || 'COMMIT_FAILED', state: result.state });
  }

  const summary = await tokenTransactions.summaryByUser(req.user.id);
  res.json({
    ok: true,
    duplicate: Boolean(result.duplicate),
    transaction: result.transaction,
    balance: summary.balance,
    reserved_tokens: summary.reserved_tokens,
    available_balance: summary.available_balance,
  });
});

// Phase B (Alt): POST /api/documents/:id/download/:txId/cancel
// Melepaskan reservasi token saat pengguna membatalkan Save As / menutup File Explorer / unduhan gagal.
export const cancelDocumentDownload = asyncHandler(async (req, res) => {
  const doc = await ownDocument(req.user.id, req.params.id);
  const txId = String(req.params.txId || '').trim();
  const tx = await downloadTransactions.findById(txId);
  if (!tx) {
    throw new HttpError(404, 'Transaksi unduhan tidak ditemukan.', { code: 'TRANSACTION_NOT_FOUND' });
  }
  if (tx.user_id !== req.user.id || tx.document_id !== doc.id) {
    throw new HttpError(403, 'Anda tidak berhak membatalkan transaksi unduhan ini.', { code: 'TRANSACTION_FORBIDDEN' });
  }

  const reason = String(req.body?.reason || 'user_cancelled').slice(0, 200);
  const result = await downloadTransactions.cancel(tx.id, req.user.id, reason);
  if (!result.ok) {
    throw new HttpError(409, 'Transaksi unduhan sudah selesai dikomit dan tidak dapat dibatalkan.', { code: result.error || 'ALREADY_COMMITTED' });
  }

  const summary = await tokenTransactions.summaryByUser(req.user.id);
  res.json({
    ok: true,
    duplicate: Boolean(result.duplicate),
    message: 'Unduhan dibatalkan. Token Anda tidak dipotong.',
    transaction: result.transaction,
    balance: summary.balance,
    reserved_tokens: summary.reserved_tokens,
    available_balance: summary.available_balance,
  });
});

// Direct API endpoint (kompatibilitas mundur): GET /api/documents/:id/download?format=txt|docx|pdf
// Menggunakan reservasi -> generate & validasi file -> commit atomik (jika gagal, token TIDAK dipotong).
export const downloadDocument = asyncHandler(async (req, res) => {
  const doc = await ownDocument(req.user.id, req.params.id);
  const format = String(req.query.format || 'txt').toLowerCase();
  if (!EXPORT_FORMATS.has(format)) {
    throw new HttpError(400, 'Format unduhan hanya "pdf", "docx", atau "txt".', { code: 'INVALID_FORMAT' });
  }

  const reservation = await downloadTransactions.reserve({
    user_id: req.user.id,
    document_id: doc.id,
    export_format: format,
    reserved_tokens: DOWNLOAD_TOKEN_COST,
    idempotency_key: req.headers['idempotency-key'] || null,
    ttl_seconds: RESERVATION_TTL_SECONDS,
  });
  if (!reservation.ok) {
    throw new HttpError(
      402,
      `Token Anda tidak mencukupi untuk mengunduh file ini. Unduhan membutuhkan ${DOWNLOAD_TOKEN_COST} token, sedangkan saldo tersedia ${reservation.available_balance ?? 0} token.`,
      {
        code: 'INSUFFICIENT_TOKENS',
        required: DOWNLOAD_TOKEN_COST,
        balance: reservation.balance ?? 0,
        available_balance: reservation.available_balance ?? 0,
        shortfall: Math.max(0, DOWNLOAD_TOKEN_COST - (reservation.available_balance ?? 0)),
      },
    );
  }

  const txId = reservation.transaction.id;
  try {
    const artifact = await prepareExportArtifact(doc, format);
    await downloadTransactions.markPrepared(txId, req.user.id);
    const committed = await downloadTransactions.commit({
      id: txId,
      user_id: req.user.id,
      description: `Unduh dokumen "${doc.title}" (.${format.toUpperCase()})`,
      meta: { document_id: doc.id, format, title: doc.title, token_cost: DOWNLOAD_TOKEN_COST },
    });
    if (!committed.ok) {
      throw new HttpError(402, 'Token Anda tidak mencukupi untuk menyelesaikan unduhan ini.', { code: committed.error || 'COMMIT_FAILED' });
    }
    res.setHeader('X-Token-Balance', String(committed.balance));
    res.setHeader('X-Download-Transaction-Id', txId);
    for (const [k, v] of Object.entries(artifact.headers)) {
      res.setHeader(k, v);
    }
    res.setHeader('Content-Type', artifact.contentType);
    res.setHeader('Content-Disposition', `attachment; filename="${artifact.filename}"`);
    return res.send(artifact.buffer);
  } catch (err) {
    await downloadTransactions.markFailed(txId, req.user.id, err?.message || 'File generation failed').catch(() => {});
    throw err;
  }
});

// GET /api/documents/:id/analysis-report?format=json|pdf|docx|annotated
// Ekspor laporan analisis terpisah dari dokumen asli pengguna (tanpa watermark RUNUT).
export const downloadAnalysisReport = asyncHandler(async (req, res) => {
  const doc = await ownDocument(req.user.id, req.params.id);
  const analysis = await latestAnalysis(doc.id);
  const issues = analysis ? await issuesRepo.listByAnalysis(analysis.id) : [];
  const format = String(req.query.format || 'json').toLowerCase();
  const safe = (doc.title || 'dokumen').replace(/[^\p{L}\p{N}\- ]+/gu, '').trim().slice(0, 80) || 'dokumen';

  const report = buildAnalysisReport({ document: doc, analysis, issues });

  if (format === 'pdf') {
    const pdfBuf = await generateAnalysisReportPdf(report);
    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', `attachment; filename="${safe}-analysis-report.pdf"`);
    res.setHeader('X-Report-Artifact', 'analysis-report-pdf');
    return res.send(pdfBuf);
  }

  if (format === 'docx') {
    const docxBuf = await generateAnalysisReportDocx(report);
    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.wordprocessingml.document');
    res.setHeader('Content-Disposition', `attachment; filename="${safe}-analysis-report.docx"`);
    res.setHeader('X-Report-Artifact', 'analysis-report-docx');
    return res.send(docxBuf);
  }

  if (format === 'annotated') {
    const orig = await getOriginalUploadPersistent(doc.id, { userId: doc.user_id });
    if (!orig || (orig.ext !== 'docx' && orig.ext !== 'pdf')) {
      throw new HttpError(422, 'Salinan beranotasi hanya tersedia untuk dokumen unggahan .DOCX atau .PDF. Gunakan Laporan Analisis PDF terpisah.', {
        code: 'ANNOTATED_UNAVAILABLE',
      });
    }
    const annotated = orig.ext === 'docx'
      ? await annotateOriginalDocx(orig.buffer, report.findings)
      : await annotateOriginalPdf(orig.buffer, report.findings);
    if (!annotated.ok) {
      throw new HttpError(422, annotated.reason || 'Dokumen ini tidak dapat diberi anotasi secara aman. Gunakan Laporan Analisis PDF terpisah.', {
        code: 'ANNOTATED_UNAVAILABLE',
      });
    }
    res.setHeader('Content-Type', annotated.mime);
    res.setHeader('Content-Disposition', `attachment; filename="${safe}-annotated.${annotated.format}"`);
    res.setHeader('X-Annotated-Copy', 'true');
    res.setHeader('X-Annotated-Findings', String(annotated.annotated_count));
    return res.send(annotated.buffer);
  }

  return res.json({
    ...report,
    report_type: 'runut_analysis_report',
    document_id: doc.id,
    title: doc.title,
    word_count: doc.word_count,
    issues_count: issues.length,
    applied_count: issues.filter((i) => i.decision === 'applied').length,
    similarity_report: analysis?.stats?.similarity_report || null,
    citation_report: analysis?.stats?.citation_report || null,
    ocr_report: analysis?.stats?.ocr_report || null,
    issues,
  });
});
