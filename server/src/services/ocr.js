// Scanned PDF OCR Pipeline
// Supports Indonesian (ind), English (eng), and mixed-language (ind+eng) OCR using
// Tesseract.js on rendered scanned PDF pages, while preserving editable pages natively.
// Tracks per-line bounding boxes, OCR confidence scores, and flags uncertain text
// (low confidence, formulas, numbers, or names) so the AI never silently corrupts them.
import { renderPdfPageToCanvas } from './pdfEditor.js';

export const DEFAULT_OCR_LANG = process.env.OCR_LANGUAGES || 'ind+eng';
export const LOW_CONFIDENCE_THRESHOLD = Number(process.env.OCR_CONFIDENCE_THRESHOLD || 75);

const FORMULA_OR_NUM_RE = /(?:\d+[.,]\d+|\d+\s*%|[=±≤≥∑√∫^]|\b(?:19|20)\d{2}\b)/;
const GARBLED_TOKEN_RE = /(?:[A-Za-z]\d[A-Za-z]|[|]{2,}|[~`^]{2,}|[^\p{L}\p{N}\s.,;:!?()[\]"'/%+-]{2,})/u;

export function normalizeOcrLanguage(lang = DEFAULT_OCR_LANG) {
  const clean = String(lang || DEFAULT_OCR_LANG).trim().toLowerCase();
  if (clean === 'id' || clean === 'ind') return 'ind';
  if (clean === 'en' || clean === 'eng') return 'eng';
  if (clean === 'mixed' || clean === 'ind+eng' || clean === 'eng+ind') return 'ind+eng';
  return 'ind+eng';
}

// Default Tesseract.js runner for a PNG buffer
async function runTesseractOnPng(pngBuffer, lang = 'ind+eng') {
  const { createWorker } = await import('tesseract.js');
  const worker = await createWorker(lang);
  try {
    const { data } = await worker.recognize(pngBuffer);
    const lines = (data.lines || []).map((line) => ({
      text: String(line.text || '').trim(),
      confidence: Math.round((Number(line.confidence) || 0) * 100) / 100,
      bbox: line.bbox
        ? {
            x: line.bbox.x0,
            y: line.bbox.y0,
            width: Math.max(0, line.bbox.x1 - line.bbox.x0),
            height: Math.max(0, line.bbox.y1 - line.bbox.y0),
          }
        : null,
    })).filter((l) => l.text.length > 0);

    return {
      text: String(data.text || '').trim(),
      confidence: Math.round((Number(data.confidence) || 0) * 100) / 100,
      lines,
    };
  } finally {
    await worker.terminate().catch(() => {});
  }
}

export function validateOcrPageResult(ocrPage, pageNumber, confidenceThreshold = LOW_CONFIDENCE_THRESHOLD) {
  const uncertainSegments = [];
  const warnings = [];
  const lines = Array.isArray(ocrPage.lines) ? ocrPage.lines : [];

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const reasons = [];
    if (typeof line.confidence === 'number' && line.confidence < confidenceThreshold) {
      reasons.push(`low_confidence (${line.confidence}%)`);
    }
    if (GARBLED_TOKEN_RE.test(line.text)) {
      reasons.push('possible_ocr_artifact');
    }
    if (reasons.length > 0 && FORMULA_OR_NUM_RE.test(line.text)) {
      reasons.push('contains_numbers_or_formula_under_low_confidence');
    }

    if (reasons.length > 0) {
      uncertainSegments.push({
        page: pageNumber,
        line_index: i + 1,
        text: line.text,
        confidence: line.confidence,
        bbox: line.bbox || null,
        reasons,
        instruction: 'Periksa teks hasil OCR ini secara manual sebelum menyetujui revisi AI; jangan ubah angka, nama, tanggal, atau rumus yang meragukan.',
      });
    }
  }

  if (typeof ocrPage.confidence === 'number' && ocrPage.confidence < confidenceThreshold) {
    warnings.push(`Halaman ${pageNumber} memiliki tingkat keyakinan OCR rendah (${ocrPage.confidence}%). Verifikasi teks hasil ekstraksi sebelum menerapkan revisi.`);
  }

  return { uncertainSegments, warnings };
}

// Process a PDF (fully scanned or mixed editable + scanned) page by page.
// Editable pages keep their native PDF text; scanned pages undergo OCR.
export async function processPdfWithOcr(pdfBuffer, inspection, {
  language = DEFAULT_OCR_LANG,
  confidenceThreshold = LOW_CONFIDENCE_THRESHOLD,
  scale = 2.0,
  ocrRunner = runTesseractOnPng,
  renderPage = renderPdfPageToCanvas,
} = {}) {
  const ocrLang = normalizeOcrLanguage(language);
  const pages = inspection?.pages || [];
  const scannedPageNums = pages.filter((p) => p.is_scanned).map((p) => p.page);

  if (scannedPageNums.length === 0) {
    return {
      ocr_applied: false,
      language: ocrLang,
      scanned_pages_processed: [],
      combined_text: inspection?.text || '',
      average_confidence: null,
      needs_user_verification: false,
      uncertain_segments: [],
      warnings: [],
      page_results: pages.map((p) => ({
        page: p.page,
        source: 'native_pdf_text',
        confidence: 100,
        text: p.text,
      })),
      scanned_editing_note: null,
    };
  }

  const pageResults = [];
  const allUncertain = [];
  const allWarnings = [];
  const confidences = [];

  for (const page of pages) {
    if (!page.is_scanned) {
      pageResults.push({
        page: page.page,
        source: 'native_pdf_text',
        confidence: 100,
        text: page.text,
        lines: [],
      });
      continue;
    }

    try {
      const rendered = await renderPage(pdfBuffer, page.page, scale);
      const ocrOut = await ocrRunner(rendered.pngBuffer, ocrLang, { page: page.page });
      const { uncertainSegments, warnings } = validateOcrPageResult(ocrOut, page.page, confidenceThreshold);

      if (typeof ocrOut.confidence === 'number') confidences.push(ocrOut.confidence);
      allUncertain.push(...uncertainSegments);
      allWarnings.push(...warnings);

      pageResults.push({
        page: page.page,
        source: 'ocr',
        language: ocrLang,
        confidence: ocrOut.confidence,
        text: ocrOut.text,
        lines: ocrOut.lines || [],
      });
    } catch (err) {
      allWarnings.push(`OCR gagal pada halaman ${page.page}: ${err?.message || 'error tidak diketahui'}.`);
      pageResults.push({
        page: page.page,
        source: 'ocr_failed',
        confidence: 0,
        text: '',
        lines: [],
      });
    }
  }

  const avgConfidence = confidences.length
    ? Math.round((confidences.reduce((a, b) => a + b, 0) / confidences.length) * 100) / 100
    : 0;

  const combinedText = pageResults
    .map((r) => r.text)
    .filter((t) => t && t.trim().length > 0)
    .join('\n\n');

  const needsVerification = allUncertain.length > 0 || avgConfidence < confidenceThreshold;

  return {
    ocr_applied: true,
    language: ocrLang,
    scanned_pages_processed: scannedPageNums,
    combined_text: combinedText,
    average_confidence: avgConfidence,
    needs_user_verification: needsVerification,
    uncertain_segments: allUncertain,
    warnings: allWarnings,
    page_results: pageResults,
    scanned_editing_note: 'PDF asli hasil pindai tetap disimpan utuh sebagai referensi. Karena penyuntingan teks langsung di atas gambar pindai berisiko merusak tampilan visual, teks revisi disediakan terpisah dan disarankan mengunggah berkas sumber DOCX bila tersedia.',
  };
}
