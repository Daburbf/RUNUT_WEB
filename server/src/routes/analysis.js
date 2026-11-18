import multer from 'multer';
import {
  documents,
  analyses,
  issues as issuesRepo,
  tokenTransactions,
} from '../repositories/index.js';
import { HttpError, asyncHandler } from '../middleware/errors.js';
import { AiError, analyzeWithProvider } from '../services/aiProvider.js';
import { rankIssues, validateAiIssues } from '../services/aiValidate.js';
import { computeStats, computeScores, countWords, CATEGORIES } from '../services/stats.js';
import { splitForAi, mapLimit } from '../services/chunk.js';
import {
  MIN_ANALYSIS_WORDS,
  AI_MAX_CHARS,
  MAX_UPLOAD_BYTES,
  calculateTokenCost,
  estimateTextAnalysis,
} from '../services/tokens.js';

export { MIN_ANALYSIS_WORDS, AI_MAX_CHARS, MAX_UPLOAD_BYTES };
export const AI_MAX_ISSUES = 12; // per bagian
export const AI_MAX_TOTAL_ISSUES = 120;
export const AI_PARALLEL = 3;

export const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: MAX_UPLOAD_BYTES, files: 1 },
});

const inFlightIdempotency = new Set();

export async function extractText(file) {
  const name = (file.originalname || '').toLowerCase();
  const isDocx = name.endsWith('.docx') || file.mimetype === 'application/vnd.openxmlformats-officedocument.wordprocessingml.document';
  const isPdf = name.endsWith('.pdf') || file.mimetype === 'application/pdf';
  const isTxt = name.endsWith('.txt') || file.mimetype === 'text/plain';
  if (isTxt) return file.buffer.toString('utf8');
  try {
    if (isDocx) {
      const { default: mammoth } = await import('mammoth');
      const { value } = await mammoth.extractRawText({ buffer: file.buffer });
      return value || '';
    }
    if (isPdf) {
      const mod = await import('pdf-parse');
      const parse = mod.default || mod;
      const data = await parse(file.buffer);
      return data?.text || '';
    }
  } catch {
    return '';
  }
  throw new HttpError(415, 'Format file tidak didukung. Gunakan TXT, DOCX, atau PDF (maksimal 5 MB).', { code: 'BAD_FILE_TYPE' });
}

export function buildEvidenceBrief(stats) {
  const parts = [];
  for (const p of (stats.top_phrases || []).slice(0, 6)) parts.push(`frasa "${p.phrase}" muncul ${p.count}x`);
  for (const o of (stats.repeated_openings || []).slice(0, 4)) parts.push(`pembuka "${o.opening}" muncul ${o.count}x`);
  for (const w of (stats.top_words || []).filter((x) => !x.common && x.count > 2).slice(0, 8)) parts.push(`kata "${w.word}" muncul ${w.count}x`);
  return parts.join('; ');
}

// POST /api/analysis/estimate - hitung jumlah kata dan biaya token di backend
// (termasuk ekstraksi teks dari DOCX/PDF) tanpa memotong saldo token.
export const estimateAnalysis = asyncHandler(async (req, res) => {
  let text = typeof req.body?.text === 'string' ? req.body.text : '';
  if (req.file) text = await extractText(req.file);
  text = (text || '').replace(/\r\n/g, '\n');

  if (req.file && !text.trim()) {
    throw new HttpError(
      400,
      'File tidak menghasilkan teks yang bisa dibaca. Untuk PDF hasil pindai tanpa lapisan teks, salin teksnya secara manual lalu tempel di editor.',
      { code: 'NO_TEXT' },
    );
  }

  const summary = await tokenTransactions.summaryByUser(req.user.id);
  const estimate = estimateTextAnalysis(text, summary.balance);
  const fileTitle = req.file ? String(req.file.originalname || '').replace(/\.[^.]+$/, '').trim().slice(0, 255) : '';

  res.json({
    ...estimate,
    title: fileTitle || undefined,
    file_name: req.file ? req.file.originalname : null,
    extracted_text: req.file ? text : undefined,
  });
});

// POST /api/analysis - validasi teks, verifikasi & potong saldo token secara atomik,
// jalankan AI, dan kembalikan token otomatis jika analisis gagal sepenuhnya.
export const createAnalysis = asyncHandler(async (req, res) => {
  let text = typeof req.body?.text === 'string' ? req.body.text : '';
  if (req.file) text = await extractText(req.file);
  text = (text || '').replace(/\r\n/g, '\n');

  if (!text.trim()) {
    throw new HttpError(400, req.file
      ? 'File tidak menghasilkan teks yang bisa dibaca. Untuk PDF hasil pindai tanpa lapisan teks, salin teksnya secara manual lalu tempel di editor.'
      : 'Teks masih kosong.', { code: 'NO_TEXT' });
  }
  const words = countWords(text);
  if (words < MIN_ANALYSIS_WORDS) {
    throw new HttpError(400, `Teks minimal ${MIN_ANALYSIS_WORDS} kata agar bisa dianalisis (saat ini ${words} kata).`, {
      code: 'TOO_SHORT',
      words,
      min_words: MIN_ANALYSIS_WORDS,
    });
  }
  if (text.length > AI_MAX_CHARS) {
    throw new HttpError(413, `Teks ${text.length.toLocaleString('id-ID')} karakter melebihi batas satu dokumen (${AI_MAX_CHARS.toLocaleString('id-ID')} karakter). Pecah menjadi beberapa dokumen.`, {
      code: 'TEXT_TOO_LARGE',
      limit: AI_MAX_CHARS,
      chars: text.length,
    });
  }
  if (req.body?.ai_consent !== true && req.body?.ai_consent !== 'true') {
    throw new HttpError(400, 'Persetujuan diperlukan: teks akan dikirim ke layanan AI yang dikonfigurasi server untuk dianalisis.', { code: 'AI_CONSENT_REQUIRED' });
  }

  const rawIdemKey = req.headers['idempotency-key'] || req.body?.idempotency_key || '';
  const idempotencyKey = String(rawIdemKey).trim().slice(0, 128) || null;
  const inFlightLockKey = idempotencyKey ? `${req.user.id}:${idempotencyKey}` : null;

  if (inFlightLockKey) {
    if (inFlightIdempotency.has(inFlightLockKey)) {
      throw new HttpError(409, 'Permintaan analisis dengan kunci idempotensi ini sedang diproses.', { code: 'DUPLICATE_IN_FLIGHT' });
    }
    const existingTx = await tokenTransactions.findByIdempotencyKey(req.user.id, idempotencyKey);
    if (existingTx && existingTx.reference_id) {
      const existingDoc = await documents.findById(existingTx.reference_id);
      if (existingDoc && existingDoc.user_id === req.user.id) {
        const existingAnalysis = await analyses.findLatestByDocument(existingDoc.id);
        const existingIssues = existingAnalysis ? await issuesRepo.listByAnalysis(existingAnalysis.id) : [];
        const summary = await tokenTransactions.summaryByUser(req.user.id);
        return res.status(200).json({
          idempotent_replay: true,
          document: {
            id: existingDoc.id,
            title: existingDoc.title,
            original_text: existingDoc.original_text,
            revised_text: existingDoc.revised_text,
            word_count: existingDoc.word_count,
            token_cost: existingDoc.token_cost || Math.abs(existingTx.amount),
            status: existingDoc.status,
            created_at: existingDoc.created_at,
            updated_at: existingDoc.updated_at,
            expires_at: existingDoc.expires_at,
          },
          analysis: existingAnalysis ? {
            id: existingAnalysis.id,
            stats: existingAnalysis.stats,
            locked: false,
            token_cost: existingAnalysis.token_cost || Math.abs(existingTx.amount),
            ai: {
              provider: existingAnalysis.ai_provider,
              model: existingAnalysis.ai_model,
              latencyMs: existingAnalysis.ai_latency_ms,
              status: existingAnalysis.ai_status,
            },
            categories: CATEGORIES,
            warnings: existingAnalysis.stats?.ai_warnings || [],
          } : null,
          issues: existingIssues,
          meta: {
            token_cost: existingDoc.token_cost || Math.abs(existingTx.amount),
            token_balance: summary.balance,
            shown: existingIssues.length,
            total_found: existingIssues.length,
          },
        });
      }
    }
    inFlightIdempotency.add(inFlightLockKey);
  }

  const fileTitle = req.file ? String(req.file.originalname || '').replace(/\.[^.]+$/, '').trim().slice(0, 255) : '';
  const title = String(req.body?.title || '').trim().slice(0, 255) || fileTitle || 'Dokumen tanpa judul';
  const tokenCost = calculateTokenCost(words);

  try {
    // Potong saldo secara atomik sebelum menjalankan AI.
    const deduction = await tokenTransactions.deduct({
      user_id: req.user.id,
      amount: tokenCost,
      description: `Analisis "${title}" (${words} kata)`,
      reference_type: 'analysis',
      reference_id: null,
      idempotency_key: idempotencyKey,
      meta: { title, word_count: words, token_cost: tokenCost },
    });

    if (!deduction.ok) {
      throw new HttpError(
        402,
        `Saldo token tidak mencukupi. Analisis ${words} kata membutuhkan ${tokenCost} token, sedangkan saldo Anda ${deduction.balance} token. Silakan isi token terlebih dahulu.`,
        {
          code: 'INSUFFICIENT_TOKENS',
          required: tokenCost,
          balance: deduction.balance,
          shortfall: Math.max(0, tokenCost - deduction.balance),
          word_count: words,
        },
      );
    }

    const txId = deduction.transaction?.id;
    let doc = null;
    try {
      const stats = computeStats(text);
      stats.scores = computeScores(text, stats);
      const evidence = buildEvidenceBrief(stats);
      const chunks = splitForAi(text);
      const startedAt = Date.now();

      const results = await mapLimit(chunks, AI_PARALLEL, async (chunk) => {
        try {
          const out = await analyzeWithProvider(chunk.text, { maxIssues: AI_MAX_ISSUES, evidence });
          return { chunk, ...out };
        } catch (err) {
          return { chunk, error: err };
        }
      });

      const failures = results.filter((r) => r.error);
      if (failures.length === results.length) {
        const first = failures[0].error;
        if (first instanceof AiError) {
          throw new HttpError(first.status, first.message, { code: first.code, retryable: first.retryable });
        }
        throw first;
      }

      const warnings = [];
      const seen = new Set();
      const all = [];
      let providerMeta = null;
      for (const result of results) {
        if (result.error) {
          warnings.push(`${result.error.message || 'Satu bagian teks gagal dianalisis.'} Bagian lain tetap diperiksa.`);
          continue;
        }
        providerMeta ||= { provider: result.provider, model: result.model };
        const { valid, errors } = validateAiIssues(result.parsed, result.chunk.text, { maxIssues: AI_MAX_ISSUES });
        warnings.push(...errors.slice(0, 2));
        for (const issue of valid) {
          const start = issue.start_pos + result.chunk.offset;
          const end = issue.end_pos + result.chunk.offset;
          const key = `${issue.category}:${start}:${end}`;
          if (seen.has(key)) continue;
          seen.add(key);
          if (text.slice(start, end) !== issue.snippet) {
            warnings.push('Satu saran dilewati karena posisinya tidak cocok dengan teks asli.');
            continue;
          }
          all.push({ ...issue, start_pos: start, end_pos: end });
        }
      }

      const ranked = rankIssues(all, text).slice(0, AI_MAX_TOTAL_ISSUES);
      const aiStatus = ranked.length === 0 ? 'empty' : (failures.length ? 'partial' : 'ok');
      const providerMetaSafe = providerMeta || { provider: 'tidak diketahui', model: 'tidak diketahui' };

      console.log(JSON.stringify({
        event: 'ai_analysis',
        user: req.user.id,
        provider: providerMetaSafe.provider,
        model: providerMetaSafe.model,
        latency_ms: Date.now() - startedAt,
        status: aiStatus,
        sections: chunks.length,
        failed_sections: failures.length,
        issues: ranked.length,
        token_cost: tokenCost,
      }));

      doc = await documents.create({
        user_id: req.user.id,
        title,
        original_text: text,
        word_count: stats.word_count,
        token_cost: tokenCost,
        file_name: req.file ? String(req.file.originalname || '').slice(0, 255) : null,
      });

      const analysis = await analyses.create({
        document_id: doc.id,
        stats: { ...stats, ai_sections: chunks.length, ai_warnings: warnings.slice(0, 5) },
        locked: false,
        token_cost: tokenCost,
        idempotency_key: idempotencyKey,
        ai_provider: providerMetaSafe.provider,
        ai_model: providerMetaSafe.model,
        ai_latency_ms: Date.now() - startedAt,
        ai_status: aiStatus,
      });

      const stored = await issuesRepo.createMany(ranked.map((it) => ({
        analysis_id: analysis.id,
        category: it.category,
        start_pos: it.start_pos,
        end_pos: it.end_pos,
        snippet: it.snippet,
        explanation: it.explanation,
        suggestion: it.suggestion,
        needs_manual_review: it.needs_manual_review,
        review_reasons: it.review_reasons || [],
        evidence: it.evidence || null,
        decision: 'active',
      })));

      if (txId) {
        await tokenTransactions.updateReference(txId, {
          reference_id: doc.id,
          meta: { document_id: doc.id, analysis_id: analysis.id, word_count: stats.word_count, token_cost: tokenCost },
        });
      }

      res.status(201).json({
        document: {
          id: doc.id,
          title: doc.title,
          original_text: doc.original_text,
          revised_text: null,
          word_count: doc.word_count,
          token_cost: tokenCost,
          status: doc.status,
          created_at: doc.created_at,
          updated_at: doc.updated_at,
          expires_at: doc.expires_at,
        },
        analysis: {
          id: analysis.id,
          stats,
          locked: false,
          token_cost: tokenCost,
          ai: { ...providerMetaSafe, latencyMs: Date.now() - startedAt, status: aiStatus, sections: chunks.length },
          categories: CATEGORIES,
          warnings: warnings.slice(0, 5),
        },
        issues: stored,
        meta: {
          token_cost: tokenCost,
          token_balance: deduction.balance,
          shown: stored.length,
          total_found: stored.length,
          sections: chunks.length,
          locked_note: null,
        },
      });
    } catch (err) {
      // Jika analisis gagal sepenuhnya sebelum dokumen disimpan, kembalikan token.
      if (!doc && !deduction.duplicate) {
        await tokenTransactions.refund({
          user_id: req.user.id,
          amount: tokenCost,
          description: `Pengembalian token: analisis "${title}" gagal diproses`,
          reference_type: 'analysis_refund',
          reference_id: txId || null,
          idempotency_key: txId ? `refund:${txId}` : null,
          meta: { reason: err.message, code: err.code || 'ANALYSIS_FAILED', word_count: words },
        }).catch((refundErr) => {
          console.error('[tokens] gagal mengembalikan token:', refundErr);
        });
      }
      throw err;
    }
  } finally {
    if (inFlightLockKey) inFlightIdempotency.delete(inFlightLockKey);
  }
});
