// Centralized cross-platform document-processing abstraction for RUNUT.
// Unifies native Windows, native Linux, macOS, and optional Docker deployments
// without duplicating OS-specific processing logic across routes or services.
import {
  detectLibreOffice,
  getLibreOfficeInstallInstructions,
  isRunningInDocker,
} from './libreOffice.js';
import {
  convertDocBufferToDocx,
  convertDocxBufferToPdf,
  hasOleDocMagic,
  validateDocxBuffer,
  validateGeneratedPdf,
} from './docxToPdf.js';
import {
  inspectDocx,
  applyDocxEdits,
  verifyDocxPreservation,
} from './docxEditor.js';
import {
  inspectPdf,
  selectPdfEditingStrategy,
  applyPdfEdits,
  comparePdfVisually,
  evaluatePdfTextOverflow,
} from './pdfEditor.js';
import {
  convertPdfBufferToDocx,
  compareConvertedDocxWithPdf,
  runOptionalPdfToDocxWorkflow,
  PDF_TO_DOCX_DISCLAIMER,
} from './pdfToDocxWorkflow.js';

let cachedCapability = null;
let cachedAt = 0;
const CAPABILITY_CACHE_TTL_MS = 30_000;

export function resetDocumentProcessingCache() {
  cachedCapability = null;
  cachedAt = 0;
}

export async function getDocumentProcessingCapabilities({
  forceRefresh = false,
  env = process.env,
  execRunner = null,
  fileExists = undefined,
  platform = process.platform,
} = {}) {
  const canUseCache = !forceRefresh && !execRunner && !fileExists && env === process.env && platform === process.platform;
  if (canUseCache && cachedCapability && (Date.now() - cachedAt) < CAPABILITY_CACHE_TTL_MS) {
    return cachedCapability;
  }

  const lo = await detectLibreOffice({
    env,
    execRunner,
    ...(fileExists ? { fileExists } : {}),
    platform,
  });
  const docxPdfEnabled = String(env.DOCX_PDF_CONVERSION_ENABLED || 'true') !== 'false';

  const result = {
    platform,
    in_docker: isRunningInDocker(),
    docker_required: false,
    libreoffice: {
      available: lo.available,
      binary: lo.binary,
      version: lo.version,
      prefers_console_binary: Boolean(lo.prefers_console_binary),
      checked_paths: lo.checked_paths,
      install_guidance: lo.available ? null : (lo.install_guidance || getLibreOfficeInstallInstructions(platform)),
    },
    capabilities: {
      docx_native_edit: true,
      doc_to_docx_conversion: lo.available,
      docx_to_pdf_conversion: lo.available && docxPdfEnabled,
      pdf_extraction: true,
      pdf_native_edit: true,
      pdf_acroform_fill: true,
      pdf_placeholder_edit: true,
      pdf_ocr_extraction: String(env.OCR_ENABLED || 'true') !== 'false',
      optional_pdf_to_docx: lo.available,
    },
  };

  if (canUseCache) {
    cachedCapability = result;
    cachedAt = Date.now();
  }
  return result;
}

export async function processPdfWithStrategy(originalPdfBuffer, edits = [], {
  allowOptionalPdfToDocx = false,
  allowCompatibleSubstitution = false,
  allowCrossPageReflow = false,
  env = process.env,
  pdfToDocxConverter = null,
  docxToPdfConverter = null,
  execRunner = null,
  fileExists = undefined,
  platform = process.platform,
} = {}) {
  const originalCopy = Buffer.from(originalPdfBuffer);
  const inspection = await inspectPdf(originalCopy);
  const strategy = selectPdfEditingStrategy(inspection, { allowOptionalPdfToDocx });

  // Strategy E: Scanned / photographic / incomplete mapping -> never force unsafe replacement
  if (strategy.code === 'E') {
    return {
      ok: false,
      modified: false,
      strategy,
      buffer: originalCopy,
      original_preserved: true,
      applied_count: 0,
      flagged_count: Array.isArray(edits) ? edits.length : 0,
      reason: strategy.reason,
      inspection,
    };
  }

  // Strategy D: Optional gated PDF-to-DOCX route when explicitly requested or selected
  if (strategy.code === 'D' && allowOptionalPdfToDocx) {
    const roundtrip = await runOptionalPdfToDocxWorkflow(originalCopy, edits, {
      env,
      pdfToDocxConverter,
      docxToPdfConverter,
      execRunner,
      ...(fileExists ? { fileExists } : {}),
      platform,
    });
    return {
      ok: roundtrip.ok,
      modified: roundtrip.ok,
      strategy,
      buffer: roundtrip.buffer,
      original_preserved: true,
      applied_count: roundtrip.applied_count || 0,
      flagged_count: roundtrip.ok ? (roundtrip.skipped_count || 0) : (Array.isArray(edits) ? edits.length : 0),
      route_rejected: Boolean(roundtrip.route_rejected),
      code: roundtrip.code,
      reason: roundtrip.reason || null,
      structure_comparison: roundtrip.structure_comparison || null,
      visual_comparison: roundtrip.visual_comparison || null,
      disclaimer: roundtrip.disclaimer,
      inspection,
    };
  }

  // Strategies A (editable), B (fillable AcroForm), C (placeholder) -> Native PDF editing
  const nativeEdit = await applyPdfEdits(originalCopy, edits, {
    allowCompatibleSubstitution,
    allowCrossPageReflow,
  });
  return {
    ok: nativeEdit.modified || (Array.isArray(edits) && edits.length === 0),
    modified: nativeEdit.modified,
    strategy,
    buffer: nativeEdit.buffer,
    original_preserved: true,
    applied_count: nativeEdit.applied_count,
    flagged_count: nativeEdit.flagged_count,
    applied: nativeEdit.applied,
    flagged_regions: nativeEdit.flagged_regions,
    recommend_docx: nativeEdit.recommend_docx,
    inspection: nativeEdit.inspection,
  };
}

export {
  convertDocBufferToDocx as convertDocToDocx,
  convertDocxBufferToPdf as convertDocxToPdf,
  convertPdfBufferToDocx as convertPdfToDocx,
  hasOleDocMagic,
  validateDocxBuffer,
  validateGeneratedPdf,
  inspectDocx,
  applyDocxEdits as editDocxPreservingTemplate,
  verifyDocxPreservation,
  inspectPdf as inspectPdfDocument,
  selectPdfEditingStrategy,
  applyPdfEdits as editPdfPreservingTemplate,
  comparePdfVisually,
  evaluatePdfTextOverflow,
  compareConvertedDocxWithPdf,
  runOptionalPdfToDocxWorkflow,
  PDF_TO_DOCX_DISCLAIMER,
};
