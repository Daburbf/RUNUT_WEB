// RUNUT 3-Stage Strict Original Document Template Preservation Engine
// Stage A: Content Editing AI (revises text only, returns structured block replacements)
// Stage B: Template Mapping & Validation (validates block IDs, anchors, placeholders, growth ratio)
// Stage C: Deterministic Template Engine (modifies ONLY authorized text nodes in original file,
//          verifies full structural fingerprint, and rejects any output that breaks the template).

import JSZip from 'jszip';
import { DOMParser, XMLSerializer } from '@xmldom/xmldom';
import { createHash } from 'node:crypto';
import { inspectDocx, applyDocxEdits, validateDocxArchive, validateDocxRelationships } from './docxEditor.js';
import { inspectPdf, applyPdfEdits } from './pdfEditor.js';

const W_NS = 'http://schemas.openxmlformats.org/wordprocessingml/2006/main';
const PLACEHOLDER_RE = /\{\{[A-Z0-9_ -]{1,64}\}\}/g;
const CITATION_RE = /\([A-Z][A-Za-zÀ-ÿ\s&.,-]{1,60},\s*(?:19|20)\d{2}[a-z]?\)|\[\d{1,3}(?:\s*[-,]\s*\d{1,3})*\]/g;
const FIXED_LABEL_RE = /^(?:nama|nim|nip|tanggal|date|nomor|no\.|lampiran|perihal|hal|disetujui oleh|mengetahui|tanda tangan|signature|doc(?:ument)?\s*id|version|versi|revisi)\s*:\s*$/i;

export const TEMPLATE_INSERTION_INSTRUCTION = `You are RUNUT's document template preservation engine.
You do not generate new documents.
You receive:
- An immutable original document.
- Its structural manifest.
- Validated replacement text mapped to stable block IDs.
Modify only authorized text nodes. Keep all other document structures unchanged.
If preservation cannot be guaranteed, reject the generated output.`;

function sha256(buf) {
  return createHash('sha256').update(buf).digest('hex');
}

function extractMatches(text, regex) {
  const out = [];
  const str = String(text || '');
  const re = new RegExp(regex.source, regex.flags);
  let m;
  while ((m = re.exec(str)) !== null) {
    out.push(m[0]);
  }
  return out;
}

function isTableHeaderRow(pNode) {
  let cur = pNode.parentNode;
  while (cur) {
    if (cur.localName === 'tr') {
      const trPr = cur.getElementsByTagNameNS(W_NS, 'trPr')[0];
      if (trPr && trPr.getElementsByTagNameNS(W_NS, 'tblHeader').length > 0) {
        return true;
      }
      // Also treat the first row of a table with short label-like cells as protected header
      let prev = cur.previousSibling;
      let hasPrevRow = false;
      while (prev) {
        if (prev.localName === 'tr') { hasPrevRow = true; break; }
        prev = prev.previousSibling;
      }
      if (!hasPrevRow) {
        const text = String(pNode.textContent || '').trim();
        if (text.length > 0 && text.length <= 40 && !/[.!?]$/.test(text)) {
          return true;
        }
      }
      return false;
    }
    cur = cur.parentNode;
  }
  return false;
}

// Compute a comprehensive structural fingerprint of a DOCX package before/after editing.
export async function computeDocxStructuralFingerprint(buffer) {
  const zip = await JSZip.loadAsync(buffer);
  validateDocxArchive(zip);
  await validateDocxRelationships(zip);

  const docFile = zip.file('word/document.xml');
  if (!docFile) {
    throw new Error('Berkas DOCX tidak valid: word/document.xml tidak ditemukan.');
  }

  const xmlStr = await docFile.async('string');
  const parser = new DOMParser();
  const serializer = new XMLSerializer();
  const doc = parser.parseFromString(xmlStr, 'application/xml');

  const paragraphs = doc.getElementsByTagNameNS(W_NS, 'p');
  const tables = doc.getElementsByTagNameNS(W_NS, 'tbl');
  const sectPrNodes = doc.getElementsByTagNameNS(W_NS, 'sectPr');
  const hyperlinks = doc.getElementsByTagNameNS(W_NS, 'hyperlink');
  const bookmarks = doc.getElementsByTagNameNS(W_NS, 'bookmarkStart');

  const tableDimensions = [];
  const tableCellMerges = [];
  for (let i = 0; i < tables.length; i++) {
    const tbl = tables[i];
    const rows = tbl.getElementsByTagNameNS(W_NS, 'tr');
    const colCounts = [];
    const merges = [];
    for (let r = 0; r < rows.length; r++) {
      const cells = rows[r].getElementsByTagNameNS(W_NS, 'tc');
      colCounts.push(cells.length);
      for (let c = 0; c < cells.length; c++) {
        const tcPr = cells[c].getElementsByTagNameNS(W_NS, 'tcPr')[0];
        if (!tcPr) continue;
        const gridSpan = tcPr.getElementsByTagNameNS(W_NS, 'gridSpan')[0];
        const vMerge = tcPr.getElementsByTagNameNS(W_NS, 'vMerge')[0];
        if (gridSpan || vMerge) {
          merges.push({
            row: r,
            col: c,
            gridSpan: gridSpan ? (gridSpan.getAttribute('w:val') || gridSpan.getAttribute('val') || '1') : null,
            vMerge: vMerge ? (vMerge.getAttribute('w:val') || vMerge.getAttribute('val') || 'continue') : null,
          });
        }
      }
    }
    tableDimensions.push({ rows: rows.length, cols_per_row: colCounts });
    tableCellMerges.push(merges);
  }

  // Normalize editable <w:t> text content to compare exact OOXML hierarchy, w:pPr, w:rPr,
  // tables, merges, bookmarks, hyperlinks, and protected nodes without comparing raw text bytes.
  const skeletonDoc = parser.parseFromString(xmlStr, 'application/xml');
  const skelParagraphs = skeletonDoc.getElementsByTagNameNS(W_NS, 'p');
  const pPrHashes = [];
  const rPrHashes = [];
  for (let i = 0; i < skelParagraphs.length; i++) {
    const p = skelParagraphs[i];
    const pPr = p.getElementsByTagNameNS(W_NS, 'pPr')[0];
    pPrHashes.push(pPr ? sha256(Buffer.from(serializer.serializeToString(pPr), 'utf8')) : null);
    const runs = p.getElementsByTagNameNS(W_NS, 'r');
    const runProps = [];
    for (let r = 0; r < runs.length; r++) {
      const rPr = runs[r].getElementsByTagNameNS(W_NS, 'rPr')[0];
      runProps.push(rPr ? sha256(Buffer.from(serializer.serializeToString(rPr), 'utf8')) : null);
    }
    rPrHashes.push(runProps);
    const tNodes = p.getElementsByTagNameNS(W_NS, 't');
    for (let t = 0; t < tNodes.length; t++) {
      tNodes[t].textContent = '__T__';
      tNodes[t].removeAttribute('xml:space');
    }
  }
  const normalizedXmlHierarchyHash = sha256(Buffer.from(serializer.serializeToString(skeletonDoc), 'utf8'));

  const sectPrSerialized = [];
  for (let i = 0; i < sectPrNodes.length; i++) {
    sectPrSerialized.push(sha256(Buffer.from(serializer.serializeToString(sectPrNodes[i]), 'utf8')));
  }

  const hashGroup = async (predicate) => {
    const names = Object.keys(zip.files).filter((f) => !zip.files[f].dir && predicate(f)).sort();
    const hashes = {};
    for (const name of names) {
      const data = await zip.file(name).async('nodebuffer');
      hashes[name] = sha256(data);
    }
    return hashes;
  };

  return {
    file_sha256: sha256(buffer),
    section_count: sectPrNodes.length,
    paragraph_count: paragraphs.length,
    table_count: tables.length,
    table_dimensions: tableDimensions,
    table_cell_merges: tableCellMerges,
    pPr_hashes: pPrHashes,
    rPr_hashes: rPrHashes,
    normalized_xml_hierarchy_hash: normalizedXmlHierarchyHash,
    hyperlink_count: hyperlinks.length,
    bookmark_count: bookmarks.length,
    sectPr_hashes: sectPrSerialized,
    content_types_hashes: await hashGroup((f) => f === '[Content_Types].xml'),
    styles_hashes: await hashGroup((f) => f === 'word/styles.xml'),
    numbering_hashes: await hashGroup((f) => f === 'word/numbering.xml'),
    settings_hashes: await hashGroup((f) => f === 'word/settings.xml'),
    theme_hashes: await hashGroup((f) => /^word\/theme\//i.test(f)),
    media_hashes: await hashGroup((f) => /^word\/media\//i.test(f)),
    header_footer_hashes: await hashGroup((f) => /^word\/(header|footer)\d*\.xml$/i.test(f)),
    notes_comments_hashes: await hashGroup((f) => /^word\/(footnotes|endnotes|comments)\.xml$/i.test(f)),
    rels_hashes: await hashGroup((f) => /\.rels$/i.test(f)),
  };
}

export function compareDocxStructuralFingerprints(before, after) {
  const eqJson = (a, b) => JSON.stringify(a) === JSON.stringify(b);
  const checks = {
    section_count_preserved: before.section_count === after.section_count,
    paragraph_count_preserved: before.paragraph_count === after.paragraph_count,
    table_count_preserved: before.table_count === after.table_count,
    table_dimensions_preserved: eqJson(before.table_dimensions, after.table_dimensions),
    table_cell_merges_preserved: eqJson(before.table_cell_merges, after.table_cell_merges),
    paragraph_properties_preserved: eqJson(before.pPr_hashes, after.pPr_hashes),
    run_properties_preserved: eqJson(before.rPr_hashes, after.rPr_hashes),
    xml_hierarchy_preserved: before.normalized_xml_hierarchy_hash === after.normalized_xml_hierarchy_hash,
    sectPr_page_layout_preserved: eqJson(before.sectPr_hashes, after.sectPr_hashes),
    content_types_preserved: eqJson(before.content_types_hashes, after.content_types_hashes),
    styles_preserved: eqJson(before.styles_hashes, after.styles_hashes),
    numbering_preserved: eqJson(before.numbering_hashes, after.numbering_hashes),
    settings_preserved: eqJson(before.settings_hashes, after.settings_hashes),
    themes_preserved: eqJson(before.theme_hashes, after.theme_hashes),
    images_media_preserved: eqJson(before.media_hashes, after.media_hashes),
    headers_footers_preserved: eqJson(before.header_footer_hashes, after.header_footer_hashes),
    notes_comments_preserved: eqJson(before.notes_comments_hashes, after.notes_comments_hashes),
    relationships_preserved: eqJson(before.rels_hashes, after.rels_hashes),
    hyperlinks_preserved: before.hyperlink_count === after.hyperlink_count,
    bookmarks_preserved: before.bookmark_count === after.bookmark_count,
  };
  const allPassed = Object.values(checks).every(Boolean);
  return { verified: allPassed, checks };
}

// Section 7: Extract a structured document template manifest with stable IDs.
export async function extractDocumentTemplateManifest(buffer, { documentId = 'doc-001', format = 'docx' } = {}) {
  const fmt = String(format || 'docx').toLowerCase();

  if (fmt === 'docx') {
    const inspected = await inspectDocx(buffer);
    const zip = await JSZip.loadAsync(buffer);
    const xmlStr = await zip.file('word/document.xml').async('string');
    const parser = new DOMParser();
    const doc = parser.parseFromString(xmlStr, 'application/xml');
    const paragraphs = doc.getElementsByTagNameNS(W_NS, 'p');

    const sectionsMap = new Map();
    const flatBlocks = [];

    for (const b of inspected.blocks) {
      const pNode = paragraphs[b.paragraph_index];
      const tableHeader = b.in_table && pNode ? isTableHeaderRow(pNode) : false;
      const fixedLabel = FIXED_LABEL_RE.test(String(b.text || '').trim());
      const editable = !b.protected && !tableHeader && !fixedLabel;
      const protectionReason = b.protection_reason
        || (tableHeader ? 'table_header' : (fixedLabel ? 'fixed_template_label' : null));

      const sectionName = b.section || 'Document';
      if (!sectionsMap.has(sectionName)) {
        sectionsMap.set(sectionName, {
          section_id: `section-${String(sectionsMap.size + 1).padStart(3, '0')}`,
          title: sectionName,
          blocks: [],
        });
      }

      const blockEntry = {
        block_id: b.block_id,
        type: b.in_table ? 'table_cell' : 'paragraph',
        editable,
        protection_reason: protectionReason,
        original_text: b.text,
        style_id: b.style || 'Normal',
        section: sectionName,
        placeholders: extractMatches(b.text, PLACEHOLDER_RE),
        citations: extractMatches(b.text, CITATION_RE),
      };
      sectionsMap.get(sectionName).blocks.push(blockEntry);
      flatBlocks.push(blockEntry);
    }

    return {
      document_id: documentId,
      source_format: 'docx',
      original_sha256: sha256(buffer),
      sections: Array.from(sectionsMap.values()),
      blocks: flatBlocks,
      metadata: inspected.metadata,
    };
  }

  if (fmt === 'pdf') {
    const inspected = await inspectPdf(buffer);
    return {
      document_id: documentId,
      source_format: 'pdf',
      original_sha256: sha256(buffer),
      editable: !inspected.is_scanned && inspected.has_text_layer,
      is_scanned: Boolean(inspected.is_scanned),
      editing_strategy: inspected.editing_strategy,
      acroform_fields: inspected.acroform_fields || [],
      page_count: inspected.page_count,
      sections: [],
      blocks: [],
      metadata: inspected,
    };
  }

  throw new Error(`Format dokumen "${fmt}" tidak didukung oleh template preservation engine.`);
}

// Stage B (Deterministic): Validate AI replacement map against the extracted manifest.
export function validateReplacementMap(manifest, replacements = [], { maxGrowthRatio = 1.15 } = {}) {
  const blocksById = new Map((manifest?.blocks || []).map((b) => [b.block_id, b]));
  const seen = new Set();
  const validReplacements = [];
  const overflowBlocks = [];
  const rejectedBlocks = [];

  for (const rep of (Array.isArray(replacements) ? replacements : [])) {
    if (!rep || typeof rep !== 'object' || typeof rep.block_id !== 'string' || typeof rep.revised_text !== 'string') {
      rejectedBlocks.push({ block_id: rep?.block_id || null, reason: 'invalid_replacement_schema' });
      continue;
    }

    const blockId = rep.block_id.trim();
    if (seen.has(blockId)) {
      rejectedBlocks.push({ block_id: blockId, reason: 'duplicate_block_id' });
      continue;
    }
    seen.add(blockId);

    const orig = blocksById.get(blockId);
    if (!orig) {
      rejectedBlocks.push({ block_id: blockId, reason: 'unknown_block_id' });
      continue;
    }
    if (!orig.editable) {
      rejectedBlocks.push({ block_id: blockId, reason: `protected_block:${orig.protection_reason || 'immutable'}` });
      continue;
    }

    const revised = rep.revised_text;
    if (!revised.trim()) {
      rejectedBlocks.push({ block_id: blockId, reason: 'empty_revised_text' });
      continue;
    }

    // Verify protected placeholders are preserved verbatim
    const missingPlaceholders = (orig.placeholders || []).filter((ph) => !revised.includes(ph));
    if (missingPlaceholders.length > 0) {
      rejectedBlocks.push({
        block_id: blockId,
        reason: 'missing_protected_placeholder',
        missing: missingPlaceholders,
      });
      continue;
    }

    // Verify citations are preserved verbatim
    const missingCitations = (orig.citations || []).filter((cit) => !revised.includes(cit));
    if (missingCitations.length > 0) {
      rejectedBlocks.push({
        block_id: blockId,
        reason: 'missing_citation',
        missing: missingCitations,
      });
      continue;
    }

    // Check text length growth ratio to prevent template overflow
    const origLen = Math.max(1, String(orig.original_text || '').length);
    const growthRatio = revised.length / origLen;
    if (growthRatio > maxGrowthRatio && (revised.length - origLen) > 25) {
      overflowBlocks.push({
        block_id: blockId,
        original_text: orig.original_text,
        revised_text: revised,
        growth_ratio: Math.round(growthRatio * 100) / 100,
        max_growth_ratio: maxGrowthRatio,
      });
      continue;
    }

    validReplacements.push({
      block_id: blockId,
      original_text: orig.original_text,
      revised_text: revised,
    });
  }

  return {
    valid: rejectedBlocks.length === 0 && overflowBlocks.length === 0,
    valid_replacements: validReplacements,
    overflow_blocks: overflowBlocks,
    rejected_blocks: rejectedBlocks,
  };
}

// Stage C: Deterministic Template Engine execution for DOCX and PDF.
export async function executeTemplatePreservation({
  originalBuffer,
  format = 'docx',
  documentId = 'doc-001',
  replacements = [],
  issueEdits = [],
  maxGrowthRatio = Number(process.env.MAX_DOCUMENT_TEXT_GROWTH_RATIO || 1.15),
  maxRepairAttempts = Number(process.env.MAX_TEMPLATE_REPAIR_ATTEMPTS || 1),
  repairOverflowFn = null,
} = {}) {
  if (!Buffer.isBuffer(originalBuffer) || originalBuffer.length === 0) {
    throw new Error('Dokumen asli tidak valid atau kosong.');
  }

  const fmt = String(format || 'docx').toLowerCase();
  const originalSha256 = sha256(originalBuffer);
  // Keep originalBuffer immutable by never mutating it in-place
  const workingCopy = Buffer.from(originalBuffer);

  if (fmt === 'docx') {
    const manifest = await extractDocumentTemplateManifest(workingCopy, { documentId, format: 'docx' });
    const fingerprintBefore = await computeDocxStructuralFingerprint(workingCopy);

    let validation = validateReplacementMap(manifest, replacements, { maxGrowthRatio });
    let finalBlockEdits = [...validation.valid_replacements];
    let remainingOverflow = [...validation.overflow_blocks];
    let repairAttempted = 0;

    // If any replacement exceeded maxGrowthRatio, ask content model for a shorter replacement once
    if (remainingOverflow.length > 0 && typeof repairOverflowFn === 'function' && maxRepairAttempts > 0) {
      repairAttempted = 1;
      try {
        const repaired = await repairOverflowFn(remainingOverflow);
        const reval = validateReplacementMap(manifest, repaired, { maxGrowthRatio });
        finalBlockEdits.push(...reval.valid_replacements);
        remainingOverflow = reval.overflow_blocks;
      } catch {
        // If repair fails, preserve original text for overflowing blocks (never silently truncate)
      }
    }

    const edited = await applyDocxEdits(workingCopy, {
      blockEdits: finalBlockEdits,
      issueEdits,
    });

    const fingerprintAfter = await computeDocxStructuralFingerprint(edited.buffer);
    const fingerprintComparison = compareDocxStructuralFingerprints(fingerprintBefore, fingerprintAfter);
    const verified = Boolean(edited.verification?.verified && fingerprintComparison.verified);

    if (!verified) {
      return {
        ok: false,
        code: 'TEMPLATE_PRESERVATION_VALIDATION_FAILED',
        reason: 'Validasi struktur template DOCX gagal; output ditolak dan dokumen asli dipertahankan.',
        original_sha256: originalSha256,
        buffer: workingCopy,
        fingerprint_before: fingerprintBefore,
        fingerprint_after: fingerprintAfter,
        fingerprint_comparison: fingerprintComparison,
        verification: edited.verification,
      };
    }

    return {
      ok: true,
      format: 'docx',
      buffer: edited.buffer,
      original_sha256: originalSha256,
      output_sha256: sha256(edited.buffer),
      original_immutable_verified: sha256(originalBuffer) === originalSha256,
      applied_count: edited.applied_count,
      skipped_count: edited.skipped_count + remainingOverflow.length + validation.rejected_blocks.length,
      rejected_blocks: validation.rejected_blocks,
      overflow_rejected_blocks: remainingOverflow,
      repair_attempted: repairAttempted,
      manifest,
      fingerprint_before: fingerprintBefore,
      fingerprint_after: fingerprintAfter,
      fingerprint_comparison: fingerprintComparison,
      verification: edited.verification,
    };
  }

  if (fmt === 'pdf') {
    const manifest = await extractDocumentTemplateManifest(workingCopy, { documentId, format: 'pdf' });
    if (manifest.is_scanned) {
      return {
        ok: false,
        code: 'SCANNED_PDF_UNSUPPORTED_FOR_NATIVE_EDIT',
        reason: 'PDF hasil pindai (berbasis gambar) tidak dapat disunting secara native tanpa mengubah template asli. Dokumen asli dipertahankan.',
        original_sha256: originalSha256,
        buffer: workingCopy,
        manifest,
      };
    }

    const pdfEdited = await applyPdfEdits(workingCopy, issueEdits);
    if (!pdfEdited.modified && issueEdits.length > 0) {
      return {
        ok: false,
        code: 'PDF_NATIVE_PRESERVATION_UNSAFE',
        reason: 'Perubahan tidak dapat diterapkan secara native pada PDF tanpa merusak tata letak. Dokumen asli dipertahankan.',
        original_sha256: originalSha256,
        buffer: workingCopy,
        flagged_regions: pdfEdited.flagged_regions,
        manifest,
      };
    }

    return {
      ok: true,
      format: 'pdf',
      buffer: pdfEdited.buffer,
      original_sha256: originalSha256,
      output_sha256: sha256(pdfEdited.buffer),
      original_immutable_verified: sha256(originalBuffer) === originalSha256,
      applied_count: pdfEdited.applied_count,
      flagged_count: pdfEdited.flagged_count,
      manifest,
    };
  }

  throw new Error(`Format "${fmt}" tidak didukung.`);
}
