// Strict Document Template Preservation for DOCX (OOXML in-place text editing).
// Opens the original DOCX ZIP archive, modifies ONLY approved <w:t> text nodes
// inside target <w:p> paragraphs, and preserves all styles, fonts, sizes, margins,
// headers, footers, page numbers, images, tables, footnotes, hyperlinks, numbering,
// relationships, and bibliography layout intact.
import JSZip from 'jszip';
import { DOMParser, XMLSerializer } from '@xmldom/xmldom';
import { createHash } from 'node:crypto';

const W_NS = 'http://schemas.openxmlformats.org/wordprocessingml/2006/main';
const BIB_HEADING_RE = /^(daftar pustaka|referensi|kepustakaan|references|bibliography|works cited)\s*:?$/i;
const MAX_DOCX_ENTRIES = 500;
const MAX_DOCX_XML_BYTES = 10 * 1024 * 1024; // 10 MB uncompressed document.xml
const MAX_DOCX_TOTAL_UNCOMPRESSED_BYTES = 25 * 1024 * 1024; // 25 MB total ZIP bomb guard
const MAX_DOCX_COMPRESSION_RATIO = 100; // Reject >100:1 compression ratio on entries > 1 MB

export function validateDocxArchive(zip) {
  const names = Object.keys(zip.files || {});
  if (names.length > MAX_DOCX_ENTRIES) {
    throw new Error(`Arsip DOCX melebihi batas jumlah entri aman (${MAX_DOCX_ENTRIES}).`);
  }
  let totalUncompressed = 0;
  for (const name of names) {
    if (name.includes('\0') || name.startsWith('/') || name.startsWith('\\') || /(^|[\\/])\.\.([\\/]|$)/.test(name)) {
      throw new Error('Arsip DOCX ditolak: path traversal terdeteksi di dalam arsip.');
    }
    if (/(^|[\\/])(vbaProject\.bin|vbaData\.xml)$/i.test(name)) {
      throw new Error('Arsip DOCX ditolak: dokumen bermakro VBA (vbaProject.bin) tidak diizinkan demi keamanan.');
    }
    const entry = zip.files[name];
    const size = Number(entry?._data?.uncompressedSize || 0);
    const compressed = Number(entry?._data?.compressedSize || 0);
    if (Number.isFinite(size) && size > 0) {
      if (size > 1024 * 1024 && compressed > 0 && (size / compressed) > MAX_DOCX_COMPRESSION_RATIO) {
        throw new Error('Arsip DOCX ditolak: rasio kompresi ekstrem terdeteksi (potensi ZIP bomb).');
      }
      totalUncompressed += size;
      if (totalUncompressed > MAX_DOCX_TOTAL_UNCOMPRESSED_BYTES) {
        throw new Error('Arsip DOCX ditolak: ukuran dekompresi melebihi batas aman (potensi ZIP bomb).');
      }
    }
  }
}

export async function validateDocxRelationships(zip) {
  const relFiles = Object.keys(zip.files || {}).filter((f) => /\.rels$/i.test(f) && !zip.files[f].dir);
  for (const relPath of relFiles) {
    const content = await zip.file(relPath).async('string');
    assertSafeXml(content);
    // Reject external template injection or external OLE objects (common Office SSRF/RCE vectors)
    if (/TargetMode=["']External["']/i.test(content) && /(attachedTemplate|oleObject|externalLink|subDocument)/i.test(content)) {
      throw new Error('Arsip DOCX ditolak: relasi eksternal berbahaya (attachedTemplate/oleObject) tidak diizinkan.');
    }
  }
}

function assertSafeXml(xmlStr) {
  if (Buffer.byteLength(xmlStr, 'utf8') > MAX_DOCX_XML_BYTES) {
    throw new Error('Isi XML dokumen DOCX terlalu besar.');
  }
  if (/<!DOCTYPE\b|<!ENTITY\b/i.test(xmlStr)) {
    throw new Error('Dokumen DOCX ditolak: deklarasi DOCTYPE/ENTITY tidak diizinkan.');
  }
}

function sha256(buf) {
  return createHash('sha256').update(buf).digest('hex');
}

function getParagraphStyle(pNode) {
  const pPr = pNode.getElementsByTagNameNS(W_NS, 'pPr')[0];
  if (!pPr) return null;
  const pStyle = pPr.getElementsByTagNameNS(W_NS, 'pStyle')[0];
  return pStyle ? (pStyle.getAttribute('w:val') || pStyle.getAttribute('val') || null) : null;
}

function isInsideAncestor(node, localName) {
  let cur = node.parentNode;
  while (cur) {
    if (cur.localName === localName) return true;
    cur = cur.parentNode;
  }
  return false;
}

function hasProtectedChild(pNode) {
  // Protect math equations and field codes
  if (pNode.getElementsByTagName('m:oMath').length > 0) return true;
  if (pNode.getElementsByTagName('m:oMathPara').length > 0) return true;
  if (pNode.getElementsByTagNameNS(W_NS, 'fldChar').length > 0) return true;
  if (pNode.getElementsByTagNameNS(W_NS, 'instrText').length > 0) return true;
  return false;
}

function getTextNodesOfParagraph(pNode) {
  const tNodes = [];
  const all = pNode.getElementsByTagNameNS(W_NS, 't');
  for (let i = 0; i < all.length; i++) {
    tNodes.push(all[i]);
  }
  return tNodes;
}

function getParagraphText(pNode) {
  return getTextNodesOfParagraph(pNode).map((n) => n.textContent || '').join('');
}

// Replace text across existing <w:t> nodes in-place without destroying <w:pPr>,
// <w:rPr>, <w:drawing>, <w:hyperlink>, <w:footnoteReference>, or other XML siblings.
function replaceTextInParagraph(pNode, newText) {
  const tNodes = getTextNodesOfParagraph(pNode);
  if (tNodes.length === 0) return false;

  const oldText = tNodes.map((n) => n.textContent || '').join('');
  if (oldText === newText) return false;

  // Compute common prefix & suffix so we preserve formatting on untouched runs
  let prefixLen = 0;
  const minLen = Math.min(oldText.length, newText.length);
  while (prefixLen < minLen && oldText[prefixLen] === newText[prefixLen]) {
    prefixLen += 1;
  }

  let suffixLen = 0;
  while (
    suffixLen < (minLen - prefixLen) &&
    oldText[oldText.length - 1 - suffixLen] === newText[newText.length - 1 - suffixLen]
  ) {
    suffixLen += 1;
  }

  const editStart = prefixLen;
  const editEnd = oldText.length - suffixLen;
  const inserted = newText.slice(prefixLen, newText.length - suffixLen);

  let cursor = 0;
  let insertedDone = false;

  for (const tNode of tNodes) {
    const val = tNode.textContent || '';
    const nodeStart = cursor;
    const nodeEnd = cursor + val.length;
    cursor = nodeEnd;

    if (nodeEnd <= editStart || nodeStart >= editEnd) {
      // Untouched run — keep completely intact
      continue;
    }

    const keepBefore = Math.max(0, editStart - nodeStart);
    const keepAfter = Math.max(0, nodeEnd - editEnd);
    const beforeStr = val.slice(0, keepBefore);
    const afterStr = keepAfter > 0 ? val.slice(val.length - keepAfter) : '';

    if (!insertedDone) {
      const updated = beforeStr + inserted + afterStr;
      tNode.textContent = updated;
      if (/^\s|\s$/.test(updated)) {
        tNode.setAttribute('xml:space', 'preserve');
      }
      insertedDone = true;
    } else {
      const updated = beforeStr + afterStr;
      tNode.textContent = updated;
      if (/^\s|\s$/.test(updated)) {
        tNode.setAttribute('xml:space', 'preserve');
      }
    }
  }

  // Fallback for pure insertion at boundary (editStart === editEnd)
  if (!insertedDone && tNodes.length > 0) {
    const first = tNodes[0];
    const updated = newText;
    first.textContent = updated;
    if (/^\s|\s$/.test(updated)) first.setAttribute('xml:space', 'preserve');
    for (let i = 1; i < tNodes.length; i++) {
      tNodes[i].textContent = '';
    }
  }

  return true;
}

export async function inspectDocx(buffer) {
  const zip = await JSZip.loadAsync(buffer);
  validateDocxArchive(zip);
  await validateDocxRelationships(zip);
  const docFile = zip.file('word/document.xml');
  if (!docFile) {
    throw new Error('Berkas DOCX tidak valid: word/document.xml tidak ditemukan.');
  }

  const xmlStr = await docFile.async('string');
  assertSafeXml(xmlStr);
  const parser = new DOMParser();
  const doc = parser.parseFromString(xmlStr, 'application/xml');
  const paragraphs = doc.getElementsByTagNameNS(W_NS, 'p');

  const blocks = [];
  let inBibliography = false;
  let currentSection = 'Document';
  let fullTextParts = [];
  let offset = 0;

  for (let i = 0; i < paragraphs.length; i++) {
    const p = paragraphs[i];
    const text = getParagraphText(p);
    const trimmed = text.trim();
    const style = getParagraphStyle(p);
    const inTable = isInsideAncestor(p, 'tbl');
    const inSdt = isInsideAncestor(p, 'sdt');
    const hasProtected = hasProtectedChild(p);

    if (BIB_HEADING_RE.test(trimmed)) {
      inBibliography = true;
      currentSection = trimmed;
    } else if (style && /heading|judul|bab/i.test(style) && trimmed) {
      currentSection = trimmed;
    }

    const isProtected = inBibliography || inSdt || hasProtected || !trimmed;
    const blockId = `paragraph_${String(i + 1).padStart(4, '0')}`;

    if (trimmed) {
      if (fullTextParts.length > 0) {
        fullTextParts.push('\n');
        offset += 1;
      }
      const start = offset;
      fullTextParts.push(text);
      offset += text.length;
      blocks.push({
        block_id: blockId,
        paragraph_index: i,
        section: currentSection,
        style,
        in_table: inTable,
        protected: isProtected,
        protection_reason: inBibliography
          ? 'bibliography'
          : (inSdt ? 'structured_document_tag' : (hasProtected ? 'equation_or_field' : null)),
        text,
        start_pos: start,
        end_pos: offset,
      });
    }
  }

  const fileNames = Object.keys(zip.files).filter((f) => !zip.files[f].dir);
  const headers = fileNames.filter((f) => /^word\/header\d*\.xml$/i.test(f));
  const footers = fileNames.filter((f) => /^word\/footer\d*\.xml$/i.test(f));
  const media = fileNames.filter((f) => /^word\/media\//i.test(f));
  const tablesCount = doc.getElementsByTagNameNS(W_NS, 'tbl').length;
  const footnotesFile = zip.file('word/footnotes.xml');
  const sectPrNodes = doc.getElementsByTagNameNS(W_NS, 'sectPr');

  return {
    text: fullTextParts.join(''),
    blocks,
    metadata: {
      format: 'docx',
      paragraph_count: paragraphs.length,
      editable_blocks: blocks.filter((b) => !b.protected).length,
      protected_blocks: blocks.filter((b) => b.protected).length,
      tables_count: tablesCount,
      images_count: media.length,
      headers_count: headers.length,
      footers_count: footers.length,
      has_footnotes: Boolean(footnotesFile),
      has_styles: Boolean(zip.file('word/styles.xml')),
      has_numbering: Boolean(zip.file('word/numbering.xml')),
      section_count: sectPrNodes.length,
      bibliography_detected: inBibliography,
    },
  };
}

// Apply approved edits to an original DOCX buffer in-place.
// Supports both:
// - blockEdits: [{ block_id, revised_text }]
// - issueEdits: [{ snippet, suggestion }] (matched against editable, non-bibliography paragraphs)
export async function applyDocxEdits(originalBuffer, { blockEdits = [], issueEdits = [] } = {}) {
  const zip = await JSZip.loadAsync(originalBuffer);
  validateDocxArchive(zip);
  const docFile = zip.file('word/document.xml');
  if (!docFile) {
    throw new Error('Berkas DOCX tidak valid: word/document.xml tidak ditemukan.');
  }

  const xmlStr = await docFile.async('string');
  assertSafeXml(xmlStr);
  const parser = new DOMParser();
  const doc = parser.parseFromString(xmlStr, 'application/xml');
  const paragraphs = doc.getElementsByTagNameNS(W_NS, 'p');

  const appliedLog = [];
  const skippedLog = [];
  let inBibliography = false;

  const blockEditMap = new Map();
  for (const edit of blockEdits) {
    if (edit?.block_id && typeof edit.revised_text === 'string') {
      blockEditMap.set(edit.block_id, edit);
    }
  }

  const pendingIssues = (Array.isArray(issueEdits) ? issueEdits : [])
    .filter((i) => i && typeof i.snippet === 'string' && i.snippet.length > 0 && typeof i.suggestion === 'string')
    .map((i, idx) => ({ ...i, _idx: idx, _applied: false }));

  for (let i = 0; i < paragraphs.length; i++) {
    const p = paragraphs[i];
    const origText = getParagraphText(p);
    const trimmed = origText.trim();

    if (BIB_HEADING_RE.test(trimmed)) {
      inBibliography = true;
      continue;
    }

    const inSdt = isInsideAncestor(p, 'sdt');
    const protectedPara = inBibliography || inSdt || hasProtectedChild(p);
    const blockId = `paragraph_${String(i + 1).padStart(4, '0')}`;

    if (blockEditMap.has(blockId)) {
      const edit = blockEditMap.get(blockId);
      if (protectedPara) {
        skippedLog.push({ block_id: blockId, reason: 'protected_element' });
        continue;
      }
      if (edit.original_text && edit.original_text !== origText) {
        skippedLog.push({ block_id: blockId, reason: 'original_text_mismatch' });
        continue;
      }
      if (replaceTextInParagraph(p, edit.revised_text)) {
        appliedLog.push({ block_id: blockId, type: 'block_edit' });
      }
      continue;
    }

    if (!protectedPara && pendingIssues.length > 0 && trimmed) {
      let currentText = origText;
      let changed = false;
      for (const issue of pendingIssues) {
        if (issue._applied) continue;
        const pos = currentText.indexOf(issue.snippet);
        if (pos !== -1) {
          currentText = currentText.slice(0, pos) + issue.suggestion + currentText.slice(pos + issue.snippet.length);
          issue._applied = true;
          changed = true;
          appliedLog.push({ block_id: blockId, type: 'issue_edit', snippet: issue.snippet.slice(0, 60) });
        }
      }
      if (changed) {
        replaceTextInParagraph(p, currentText);
      }
    }
  }

  for (const issue of pendingIssues) {
    if (!issue._applied) {
      skippedLog.push({ type: 'issue_edit', snippet: issue.snippet.slice(0, 60), reason: 'not_found_in_editable_paragraphs' });
    }
  }

  const serializer = new XMLSerializer();
  const updatedXml = serializer.serializeToString(doc);
  zip.file('word/document.xml', updatedXml);

  const modifiedBuffer = await zip.generateAsync({ type: 'nodebuffer', compression: 'DEFLATE' });
  const verification = await verifyDocxPreservation(originalBuffer, modifiedBuffer);

  return {
    buffer: modifiedBuffer,
    applied_count: appliedLog.length,
    skipped_count: skippedLog.length,
    applied: appliedLog,
    skipped: skippedLog,
    verification,
  };
}

export async function verifyDocxPreservation(originalBuffer, modifiedBuffer) {
  const origZip = await JSZip.loadAsync(originalBuffer);
  const modZip = await JSZip.loadAsync(modifiedBuffer);

  const compareFileGroup = async (predicate) => {
    const origFiles = Object.keys(origZip.files).filter((f) => !origZip.files[f].dir && predicate(f)).sort();
    const modFiles = Object.keys(modZip.files).filter((f) => !modZip.files[f].dir && predicate(f)).sort();
    if (origFiles.length !== modFiles.length) return false;
    for (let i = 0; i < origFiles.length; i++) {
      if (origFiles[i] !== modFiles[i]) return false;
      const origEntry = origZip.file(origFiles[i]);
      const modEntry = modZip.file(modFiles[i]);
      if (!origEntry || !modEntry) return false;
      const a = await origEntry.async('nodebuffer');
      const b = await modEntry.async('nodebuffer');
      if (sha256(a) !== sha256(b)) return false;
    }
    return true;
  };

  const parser = new DOMParser();
  const serializer = new XMLSerializer();
  const origDoc = parser.parseFromString(await origZip.file('word/document.xml').async('string'), 'application/xml');
  const modDoc = parser.parseFromString(await modZip.file('word/document.xml').async('string'), 'application/xml');

  const serializeNodes = (doc, localName) => {
    const nodes = doc.getElementsByTagNameNS(W_NS, localName);
    const arr = [];
    for (let i = 0; i < nodes.length; i++) arr.push(serializer.serializeToString(nodes[i]));
    return arr;
  };

  const origSectPr = serializeNodes(origDoc, 'sectPr');
  const modSectPr = serializeNodes(modDoc, 'sectPr');
  const pageConfigPreserved = origSectPr.length === modSectPr.length &&
    origSectPr.every((s, idx) => s === modSectPr[idx]);

  const origTblPr = serializeNodes(origDoc, 'tblPr');
  const modTblPr = serializeNodes(modDoc, 'tblPr');
  const tablesPreserved = origDoc.getElementsByTagNameNS(W_NS, 'tbl').length === modDoc.getElementsByTagNameNS(W_NS, 'tbl').length &&
    origTblPr.length === modTblPr.length &&
    origTblPr.every((s, idx) => s === modTblPr[idx]);

  const headersFootersPreserved = await compareFileGroup((f) => /^word\/(header|footer)\d*\.xml$/i.test(f));
  const imagesPreserved = await compareFileGroup((f) => /^word\/media\//i.test(f));
  const stylesPreserved = await compareFileGroup((f) => f === 'word/styles.xml' || f === 'word/numbering.xml' || f === 'word/theme/theme1.xml');
  const footnotesPreserved = await compareFileGroup((f) => f === 'word/footnotes.xml' || f === 'word/endnotes.xml');
  const hyperlinksPreserved = await compareFileGroup((f) => f === 'word/_rels/document.xml.rels');

  // Verify bibliography paragraphs were untouched
  const extractBibTexts = (doc) => {
    const ps = doc.getElementsByTagNameNS(W_NS, 'p');
    let inBib = false;
    const out = [];
    for (let i = 0; i < ps.length; i++) {
      const t = getParagraphText(ps[i]).trim();
      if (BIB_HEADING_RE.test(t)) { inBib = true; continue; }
      if (inBib && t) out.push(t);
    }
    return out;
  };
  const origBib = extractBibTexts(origDoc);
  const modBib = extractBibTexts(modDoc);
  const bibliographyPreserved = origBib.length === modBib.length && origBib.every((t, idx) => t === modBib[idx]);

  const allPreserved = pageConfigPreserved &&
    headersFootersPreserved &&
    imagesPreserved &&
    tablesPreserved &&
    stylesPreserved &&
    footnotesPreserved &&
    hyperlinksPreserved &&
    bibliographyPreserved;

  const classification = allPreserved
    ? 'preserved'
    : (stylesPreserved && tablesPreserved && imagesPreserved ? 'partially_preserved' : 'validation_failed');

  return {
    verified: allPreserved,
    classification,
    format: 'docx',
    checks: {
      original_formatting_preserved: stylesPreserved,
      tables_preserved: tablesPreserved,
      images_preserved: imagesPreserved,
      headers_footers_preserved: headersFootersPreserved,
      bibliography_preserved: bibliographyPreserved,
      page_configuration_preserved: pageConfigPreserved,
      footnotes_preserved: footnotesPreserved,
      hyperlinks_preserved: hyperlinksPreserved,
    },
  };
}
