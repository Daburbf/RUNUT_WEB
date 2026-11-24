// Optional, strictly gated PDF-to-DOCX editing workflow for suitable fixed-layout PDFs.
// Pipeline:
// 1. Preserve the original PDF (immutable, SHA-256 tracked).
// 2. Convert a working copy into DOCX using a locally installed tool (LibreOffice writer_pdf_import or injected hook).
// 3. Inspect the resulting DOCX structure.
// 4. Compare the converted DOCX with the original PDF.
// 5. Identify changes in text, layout, tables, and images.
// 6. Allow editing ONLY when the document structure is sufficiently reliable.
// 7. Apply AI revisions to the editable DOCX.
// 8. Export the revised DOCX back to PDF.
// 9. Render and compare the resulting PDF against the original.
//
// Never claims PDF-to-DOCX guarantees identical formatting.
// Never silently returns a reconstructed plain-text document.
import { createHash } from 'node:crypto';
import { existsSync } from 'node:fs';
import { inspectDocx, applyDocxEdits } from './docxEditor.js';
import { inspectPdf, selectPdfEditingStrategy, comparePdfVisually } from './pdfEditor.js';
import { convertDocxBufferToPdf, validateDocxBuffer, validateGeneratedPdf } from './docxToPdf.js';
import { runLibreOfficeConversion, getLibreOfficeInstallInstructions } from './libreOffice.js';

export const PDF_TO_DOCX_DISCLAIMER =
  'Konversi PDF-ke-DOCX tidak menjamin pemformatan 100% identik. Rute ini hanya diizinkan bila struktur teks, tata letak, tabel, dan gambar terverifikasi cukup andal; berkas PDF asli selalu dipertahankan secara terpisah.';

function sha256(buf) {
  return createHash('sha256').update(buf).digest('hex');
}

function tokenizeWords(text) {
  return String(text || '')
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s]+/gu, ' ')
    .split(/\s+/)
    .filter(Boolean);
}

function computeWordRetention(origText, convText) {
  const origWords = tokenizeWords(origText);
  const convWords = tokenizeWords(convText);
  if (origWords.length === 0) return convWords.length === 0 ? 1 : 0;

  const convCounts = new Map();
  for (const w of convWords) {
    convCounts.set(w, (convCounts.get(w) || 0) + 1);
  }
  let matched = 0;
  for (const w of origWords) {
    const count = convCounts.get(w) || 0;
    if (count > 0) {
      matched += 1;
      convCounts.set(w, count - 1);
    }
  }
  const recall = matched / origWords.length;
  const precision = convWords.length > 0 ? matched / convWords.length : 0;
  const f1 = (recall + precision) > 0 ? (2 * recall * precision) / (recall + precision) : 0;
  return Math.round(f1 * 1000) / 1000;
}

export async function convertPdfBufferToDocx(pdfBuffer, {
  env = process.env,
  converter = null,
  execRunner = null,
  fileExists = existsSync,
  timeoutMs = Number(env.DOCX_PDF_TIMEOUT_MS || 120000),
  platform = process.platform,
} = {}) {
  const pdfCheck = await validateGeneratedPdf(pdfBuffer);
  if (!pdfCheck.valid) {
    return {
      ok: false,
      code: 'INVALID_PDF_INPUT',
      reason: 'Berkas PDF masukan tidak valid atau rusak.',
    };
  }

  if (typeof converter === 'function') {
    try {
      const out = await converter(Buffer.from(pdfBuffer));
      const validDocx = await validateDocxBuffer(out);
      if (!validDocx) {
        return {
          ok: false,
          code: 'INVALID_DOCX_OUTPUT',
          reason: 'Hasil konversi PDF-ke-DOCX bukan arsip DOCX yang valid.',
        };
      }
      return { ok: true, buffer: out, engine: 'custom' };
    } catch (err) {
      return {
        ok: false,
        code: 'PDF_TO_DOCX_FAILED',
        reason: 'Konversi PDF-ke-DOCX gagal dijalankan.',
        stderr: String(err?.message || ''),
      };
    }
  }

  const run = await runLibreOfficeConversion({
    inputBuffer: pdfBuffer,
    inputFilename: 'source.pdf',
    expectedOutputFilename: 'source.docx',
    convertTo: 'docx',
    inFilter: 'writer_pdf_import',
    env,
    execRunner,
    fileExists,
    timeoutMs,
    platform,
    tempPrefix: 'runut-pdf2docx-',
  });

  if (!run.ok) {
    if (run.code === 'CONVERTER_UNAVAILABLE') {
      const guidance = run.install_guidance || getLibreOfficeInstallInstructions(platform);
      return {
        ok: false,
        code: 'CONVERTER_UNAVAILABLE',
        reason: `Konversi opsional PDF-ke-DOCX memerlukan LibreOffice lokal. ${guidance.summary}`,
        install_guidance: guidance,
      };
    }
    return {
      ok: false,
      code: run.code === 'CONVERSION_TIMEOUT' ? 'CONVERSION_TIMEOUT' : 'PDF_TO_DOCX_FAILED',
      reason: run.code === 'CONVERSION_TIMEOUT'
        ? `Konversi PDF-ke-DOCX melewati batas waktu ${timeoutMs} ms.`
        : 'Konversi PDF-ke-DOCX gagal dijalankan oleh LibreOffice.',
      stderr: run.stderr || run.error || '',
    };
  }

  const validDocx = await validateDocxBuffer(run.buffer);
  if (!validDocx) {
    return {
      ok: false,
      code: 'INVALID_DOCX_OUTPUT',
      reason: 'Hasil konversi PDF-ke-DOCX gagal validasi struktur OOXML.',
      stderr: run.stderr || '',
    };
  }

  return {
    ok: true,
    buffer: run.buffer,
    engine: 'libreoffice',
    binary: run.binary,
    version: run.version,
  };
}

// Steps 4 & 5: Compare converted DOCX structure against original PDF inspection
// and identify concrete differences in text, layout, tables, and images.
export function compareConvertedDocxWithPdf(pdfInspection, docxInspection, {
  minTextRetention = 0.85,
  maxImageDelta = 1,
} = {}) {
  const differences = [];
  const textRetention = computeWordRetention(pdfInspection.text, docxInspection.text);

  if (textRetention < minTextRetention) {
    differences.push({
      category: 'text',
      severity: 'high',
      detail: `Retensi teks hasil konversi rendah (${Math.round(textRetention * 100)}%, minimal ${Math.round(minTextRetention * 100)}%).`,
    });
  }

  const pdfParaCount = Math.max(1, (pdfInspection.paragraphs || []).length);
  const docxBlockCount = Math.max(0, (docxInspection.blocks || []).length);
  const paraRatio = docxBlockCount / pdfParaCount;
  if (docxBlockCount === 0 || paraRatio < 0.4 || paraRatio > 3.5) {
    differences.push({
      category: 'layout',
      severity: 'high',
      detail: `Struktur paragraf berubah signifikan (PDF: ${pdfParaCount} paragraf, DOCX: ${docxBlockCount} blok).`,
    });
  }

  const pdfImages = (pdfInspection.pages || []).reduce((sum, p) => sum + (p.image_count || 0), 0);
  const docxImages = Number(docxInspection.metadata?.images_count || 0);
  const imageDelta = Math.abs(pdfImages - docxImages);
  if (imageDelta > maxImageDelta) {
    differences.push({
      category: 'images',
      severity: 'high',
      detail: `Jumlah gambar berbeda setelah konversi (PDF: ${pdfImages}, DOCX: ${docxImages}).`,
    });
  }

  const docxTables = Number(docxInspection.metadata?.tables_count || 0);
  const pdfVectorOps = (pdfInspection.pages || []).reduce((sum, p) => sum + (p.vector_ops_count || 0), 0);
  const likelyHadTables = pdfVectorOps >= 20;
  if (likelyHadTables && docxTables === 0) {
    differences.push({
      category: 'tables',
      severity: 'medium',
      detail: `PDF memiliki garis/vektor padat (${pdfVectorOps} operasi) yang kemungkinan tabel, tetapi 0 tabel terdeteksi di DOCX.`,
    });
  }

  const highSeverityCount = differences.filter((d) => d.severity === 'high').length;
  const reliable = highSeverityCount === 0 && textRetention >= minTextRetention;

  return {
    reliable,
    text_retention: textRetention,
    pdf_paragraph_count: pdfParaCount,
    docx_block_count: docxBlockCount,
    pdf_images_count: pdfImages,
    docx_images_count: docxImages,
    docx_tables_count: docxTables,
    differences,
    disclaimer: PDF_TO_DOCX_DISCLAIMER,
  };
}

// Complete 9-step gated PDF-to-DOCX editing workflow.
export async function runOptionalPdfToDocxWorkflow(originalPdfBuffer, edits = [], {
  env = process.env,
  pdfToDocxConverter = null,
  docxToPdfConverter = null,
  execRunner = null,
  fileExists = existsSync,
  timeoutMs = Number(env.DOCX_PDF_TIMEOUT_MS || 120000),
  platform = process.platform,
  minTextRetention = 0.85,
  minVisualSimilarity = 85,
} = {}) {
  // Step 1: Preserve original PDF immutably
  const originalCopy = Buffer.from(originalPdfBuffer);
  const originalSha256 = sha256(originalCopy);

  const pdfInspection = await inspectPdf(originalCopy);
  const strategy = selectPdfEditingStrategy(pdfInspection, { allowOptionalPdfToDocx: true });

  if (!strategy.pdf_to_docx_eligible) {
    return {
      ok: false,
      route_rejected: true,
      code: 'PDF_NOT_SUITABLE_FOR_DOCX_CONVERSION',
      reason: strategy.reason,
      strategy,
      original_sha256: originalSha256,
      buffer: originalCopy,
      disclaimer: PDF_TO_DOCX_DISCLAIMER,
    };
  }

  // Step 2: Convert working copy into DOCX
  const toDocx = await convertPdfBufferToDocx(originalCopy, {
    env,
    converter: pdfToDocxConverter,
    execRunner,
    fileExists,
    timeoutMs,
    platform,
  });
  if (!toDocx.ok) {
    return {
      ok: false,
      route_rejected: true,
      code: toDocx.code,
      reason: toDocx.reason,
      install_guidance: toDocx.install_guidance || null,
      strategy,
      original_sha256: originalSha256,
      buffer: originalCopy,
      disclaimer: PDF_TO_DOCX_DISCLAIMER,
    };
  }

  // Step 3: Inspect converted DOCX structure
  let docxInspection;
  try {
    docxInspection = await inspectDocx(toDocx.buffer);
  } catch (err) {
    return {
      ok: false,
      route_rejected: true,
      code: 'CONVERTED_DOCX_INSPECTION_FAILED',
      reason: `DOCX hasil konversi tidak dapat diinspeksi: ${err?.message || 'struktur rusak'}.`,
      strategy,
      original_sha256: originalSha256,
      buffer: originalCopy,
      disclaimer: PDF_TO_DOCX_DISCLAIMER,
    };
  }

  // Steps 4, 5 & 6: Compare structure & gate editing on reliability
  const structureComparison = compareConvertedDocxWithPdf(pdfInspection, docxInspection, {
    minTextRetention,
  });
  if (!structureComparison.reliable) {
    return {
      ok: false,
      route_rejected: true,
      code: 'LAYOUT_DIVERGENCE_REJECTED',
      reason: 'Konversi PDF-ke-DOCX menimbulkan perbedaan tata letak/struktur signifikan sehingga rute ini ditolak. PDF asli dipertahankan.',
      strategy,
      structure_comparison: structureComparison,
      original_sha256: originalSha256,
      buffer: originalCopy,
      disclaimer: PDF_TO_DOCX_DISCLAIMER,
    };
  }

  // Step 7: Apply AI revisions to the editable DOCX
  const normalizedEdits = (Array.isArray(edits) ? edits : []).map((e) => ({
    snippet: e.snippet || e.original_text || '',
    suggestion: e.suggestion || e.revised_text || '',
  })).filter((e) => e.snippet && e.suggestion);

  const editedDocx = await applyDocxEdits(toDocx.buffer, { issueEdits: normalizedEdits });
  if (normalizedEdits.length > 0 && editedDocx.applied_count === 0) {
    return {
      ok: false,
      route_rejected: true,
      code: 'NO_EDITS_APPLIED_IN_DOCX',
      reason: 'Tidak ada revisi yang berhasil diterapkan ke DOCX hasil konversi; PDF asli dipertahankan.',
      strategy,
      structure_comparison: structureComparison,
      docx_edit_result: {
        applied_count: editedDocx.applied_count,
        skipped_count: editedDocx.skipped_count,
      },
      original_sha256: originalSha256,
      buffer: originalCopy,
      disclaimer: PDF_TO_DOCX_DISCLAIMER,
    };
  }

  // Step 8: Export revised DOCX back to PDF
  const backToPdf = await convertDocxBufferToPdf(editedDocx.buffer, {
    env,
    converter: docxToPdfConverter,
    execRunner,
    fileExists,
    timeoutMs,
    platform,
  });
  if (!backToPdf.ok) {
    return {
      ok: false,
      route_rejected: true,
      code: backToPdf.code || 'DOCX_TO_PDF_EXPORT_FAILED',
      reason: backToPdf.reason || 'Ekspor kembali DOCX revisi ke PDF gagal; PDF asli dipertahankan.',
      strategy,
      structure_comparison: structureComparison,
      original_sha256: originalSha256,
      buffer: originalCopy,
      disclaimer: PDF_TO_DOCX_DISCLAIMER,
    };
  }

  // Step 9: Render and compare resulting PDF against original
  const visualComparison = await comparePdfVisually(originalCopy, backToPdf.buffer).catch(() => null);
  const visualAcceptable = Boolean(
    visualComparison
    && visualComparison.page_count_match
    && visualComparison.average_visual_similarity_percent >= minVisualSimilarity,
  );

  if (!visualAcceptable) {
    return {
      ok: false,
      route_rejected: true,
      code: 'FINAL_VISUAL_DIVERGENCE_REJECTED',
      reason: 'PDF hasil ekspor ulang menunjukkan perbedaan tata letak visual signifikan dibanding PDF asli; rute ditolak dan PDF asli dipertahankan.',
      strategy,
      structure_comparison: structureComparison,
      visual_comparison: visualComparison,
      original_sha256: originalSha256,
      buffer: originalCopy,
      disclaimer: PDF_TO_DOCX_DISCLAIMER,
    };
  }

  return {
    ok: true,
    route_rejected: false,
    code: 'PDF_TO_DOCX_ROUNDTRIP_VERIFIED',
    strategy,
    buffer: backToPdf.buffer,
    edited_docx_buffer: editedDocx.buffer,
    applied_count: editedDocx.applied_count,
    skipped_count: editedDocx.skipped_count,
    structure_comparison: structureComparison,
    visual_comparison: visualComparison,
    original_sha256: originalSha256,
    disclaimer: PDF_TO_DOCX_DISCLAIMER,
  };
}
