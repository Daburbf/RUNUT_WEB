// Fixed-Layout PDF Inspection, Deeper Subset Font Analysis, Multi-Line Paragraph
// Grouping, Complex Background Restoration, Safe In-Place Editing, and Visual Validation.
import { PDFDocument, StandardFonts, rgb, PDFName } from 'pdf-lib';
import { createCanvas } from '@napi-rs/canvas';
import * as pdfjsLib from 'pdfjs-dist/legacy/build/pdf.mjs';
import {
  classifyRegionBackground,
  buildBackgroundRestoration,
  validateBackgroundRestoration,
} from './pdfBackground.js';

const SUBSET_FONT_RE = /^[A-Z]{6}\+/;
const UNMAPPED_GLYPH_RE = /[\uFFFD\uE000-\uF8FF]/;
const PLACEHOLDER_RE = /\{\{[A-Z0-9_ -]{2,48}\}\}/g;
export const MAX_PDF_PAGES = Number(process.env.MAX_PDF_PAGES || 200);

export function scanPdfSecurityRisks(pdfDoc) {
  const findings = {
    has_javascript: false,
    has_launch_action: false,
    has_embedded_files: false,
  };
  if (!pdfDoc?.context) return findings;
  const visited = new Set();

  const inspectObject = (obj, depth = 0) => {
    if (!obj || depth > 12 || visited.has(obj)) return;
    visited.add(obj);

    if (typeof obj.get === 'function') {
      if (obj.get(PDFName.of('JS')) || obj.get(PDFName.of('JavaScript'))) {
        findings.has_javascript = true;
      }
      const actionType = obj.get(PDFName.of('S'));
      if (actionType) {
        const s = String(actionType);
        if (s === '/JavaScript') findings.has_javascript = true;
        if (s === '/Launch') findings.has_launch_action = true;
      }
      if (obj.get(PDFName.of('EmbeddedFiles')) || String(obj.get(PDFName.of('Type')) || '') === '/EmbeddedFile') {
        findings.has_embedded_files = true;
      }
      if (typeof obj.entries === 'function') {
        for (const [, val] of obj.entries()) {
          if (val && typeof val === 'object') inspectObject(val, depth + 1);
        }
      }
      return;
    }

    if (typeof obj.size === 'function' && typeof obj.get === 'function') {
      const len = Math.min(obj.size(), 200);
      for (let i = 0; i < len; i++) {
        const item = obj.get(i);
        if (item && typeof item === 'object') inspectObject(item, depth + 1);
      }
    }
  };

  try {
    for (const [, obj] of pdfDoc.context.enumerateIndirectObjects()) {
      inspectObject(obj, 0);
    }
  } catch {
    // Graceful fallback on unusual PDF object graphs
  }
  return findings;
}

function detectAcroFormFields(pdfDoc) {
  const fields = [];
  try {
    const form = pdfDoc.getForm();
    for (const f of form.getFields()) {
      const name = f.getName();
      const typeName = f.constructor?.name || 'PDFObject';
      let value = '';
      let isTextField = false;
      if (typeof f.getText === 'function') {
        isTextField = true;
        value = String(f.getText() || '');
      }
      fields.push({
        name,
        type: typeName,
        is_text_field: isTextField,
        value,
      });
    }
  } catch {
    // PDF has no AcroForm
  }
  return fields;
}

function normalizeForPdfWinAnsi(str) {
  return String(str ?? '')
    .replace(/[\u2018\u2019]/g, "'")
    .replace(/[\u201c\u201d]/g, '"')
    .replace(/[\u2013\u2014]/g, '-')
    .replace(/\u2026/g, '...')
    .replace(/[^\x09\x0A\x20-\xFF]/g, '?');
}

function mapToStandardFont(fontName = '') {
  const lower = String(fontName || '').toLowerCase();
  const isBold = /bold|black|heavy|semibold|demi/.test(lower);
  const isItalic = /italic|oblique/.test(lower);
  if (/times|serif|georgia|garamond|cambria/.test(lower)) {
    if (isBold && isItalic) return StandardFonts.TimesRomanBoldItalic;
    if (isBold) return StandardFonts.TimesRomanBold;
    if (isItalic) return StandardFonts.TimesRomanItalic;
    return StandardFonts.TimesRoman;
  }
  if (/courier|mono|consolas/.test(lower)) {
    if (isBold && isItalic) return StandardFonts.CourierBoldOblique;
    if (isBold) return StandardFonts.CourierBold;
    if (isItalic) return StandardFonts.CourierOblique;
    return StandardFonts.Courier;
  }
  if (isBold && isItalic) return StandardFonts.HelveticaBoldOblique;
  if (isBold) return StandardFonts.HelveticaBold;
  if (isItalic) return StandardFonts.HelveticaOblique;
  return StandardFonts.Helvetica;
}

// Deeper PDF font dictionary inspection: detects embedded fonts, subset fonts,
// encoding, ToUnicode CMap availability, character widths, and mapping reliability.
function detectPdfFontsFromLib(pdfDoc) {
  const fonts = [];
  const seen = new Set();
  try {
    const context = pdfDoc.context;
    for (const [, obj] of context.enumerateIndirectObjects()) {
      if (!obj || typeof obj.get !== 'function') continue;
      const type = obj.get(PDFName.of('Type'));
      if (type && String(type) === '/Font') {
        const baseFont = obj.get(PDFName.of('BaseFont'));
        const name = baseFont ? String(baseFont).replace(/^\//, '') : 'Unknown';
        if (seen.has(name)) continue;
        seen.add(name);

        const subtypeObj = obj.get(PDFName.of('Subtype'));
        const subtype = subtypeObj ? String(subtypeObj).replace(/^\//, '') : 'Unknown';
        const encodingObj = obj.get(PDFName.of('Encoding'));
        const encoding = encodingObj ? String(encodingObj).replace(/^\//, '') : null;
        const toUnicodeObj = obj.get(PDFName.of('ToUnicode'));
        const hasToUnicode = Boolean(toUnicodeObj);
        const hasWidths = Boolean(obj.get(PDFName.of('Widths')) || obj.get(PDFName.of('W')));
        const descriptor = obj.get(PDFName.of('FontDescriptor'));

        const isSubset = SUBSET_FONT_RE.test(name);
        const isEmbedded = Boolean(descriptor) || isSubset;
        const isStandard = !isSubset && /^(Helvetica|Times|Courier|Symbol|ZapfDingbats)/i.test(name);
        const isStandardEncoding = Boolean(encoding && /^(WinAnsiEncoding|MacRomanEncoding|StandardEncoding)$/i.test(encoding));

        let mappingStatus = 'standard_complete';
        if (isSubset) {
          if (hasToUnicode) {
            mappingStatus = 'subset_with_tounicode';
          } else if (isStandardEncoding && subtype !== 'Type0') {
            mappingStatus = 'subset_standard_encoding';
          } else {
            mappingStatus = 'subset_incomplete_mapping';
          }
        } else if (!isStandard && !hasToUnicode && encoding === 'Identity-H') {
          mappingStatus = 'subset_incomplete_mapping';
        }

        fonts.push({
          name,
          subtype,
          encoding,
          has_to_unicode: hasToUnicode,
          has_widths: hasWidths,
          is_subset: isSubset,
          is_embedded: isEmbedded,
          is_standard: isStandard,
          mapping_status: mappingStatus,
          text_extractable_reliably: mappingStatus !== 'subset_incomplete_mapping',
        });
      }
    }
  } catch {
    // Graceful fallback if font dictionary traversal encounters unusual structures
  }
  return fonts;
}

function groupItemsIntoLines(items, pageNumber, pageWidth, pageHeight, fontStyles = {}, docFontMap = new Map()) {
  const lines = [];
  const sorted = [...items]
    .filter((it) => typeof it.str === 'string' && it.str.length > 0)
    .map((it) => {
      const tx = it.transform || [12, 0, 0, 12, 0, 0];
      const fontSize = Math.round(Math.hypot(tx[0], tx[1]) * 100) / 100 || Math.round(Math.abs(tx[3]) * 100) / 100 || 11;
      const x = Math.round(tx[4] * 100) / 100;
      const y = Math.round(tx[5] * 100) / 100;
      const width = Math.round((it.width || 0) * 100) / 100;
      const height = Math.round((it.height || fontSize) * 100) / 100;
      const styleInfo = fontStyles[it.fontName] || {};
      const resolvedFontName = styleInfo.fontFamily || it.fontName || 'Helvetica';
      const fontMeta = docFontMap.get(it.fontName) || docFontMap.get(resolvedFontName) || null;
      const isSubset = SUBSET_FONT_RE.test(it.fontName || '') || Boolean(fontMeta?.is_subset);
      const mappingStatus = fontMeta?.mapping_status || (isSubset ? 'subset_incomplete_mapping' : 'standard_complete');
      return {
        str: it.str,
        x,
        y,
        width,
        height,
        fontSize,
        fontName: it.fontName || 'Helvetica',
        fontFamily: resolvedFontName,
        isSubset,
        mappingStatus,
      };
    });

  for (const item of sorted) {
    let line = lines.find((l) => Math.abs(l.y - item.y) <= Math.max(3, item.fontSize * 0.3));
    if (!line) {
      line = { page: pageNumber, y: item.y, items: [] };
      lines.push(line);
    }
    line.items.push(item);
  }

  lines.sort((a, b) => b.y - a.y);

  return lines.map((line, idx) => {
    line.items.sort((a, b) => a.x - b.x);
    let text = '';
    for (let i = 0; i < line.items.length; i++) {
      const cur = line.items[i];
      if (i > 0) {
        const prev = line.items[i - 1];
        const gap = cur.x - (prev.x + prev.width);
        if (gap > cur.fontSize * 0.18 && !text.endsWith(' ') && !cur.str.startsWith(' ')) {
          text += ' ';
        }
      }
      text += cur.str;
    }
    const minX = Math.min(...line.items.map((i) => i.x));
    const maxX = Math.max(...line.items.map((i) => i.x + i.width));
    const maxH = Math.max(...line.items.map((i) => i.height));
    const primary = line.items[0];
    const hasSubset = line.items.some((i) => i.isSubset);
    const hasUnmappedGlyphs = UNMAPPED_GLYPH_RE.test(text);
    const mappingStatus = hasUnmappedGlyphs ? 'subset_incomplete_mapping' : primary.mappingStatus;

    return {
      region_id: `p${pageNumber}_l${idx + 1}`,
      page: pageNumber,
      text: text.trim(),
      bbox: {
        x: Math.round(minX * 100) / 100,
        y: Math.round(line.y * 100) / 100,
        width: Math.round(Math.max(1, maxX - minX) * 100) / 100,
        height: Math.round(maxH * 100) / 100,
      },
      available_width: Math.round(Math.max(maxX - minX, pageWidth - minX - 36) * 100) / 100,
      font_name: primary.fontName,
      font_family: primary.fontFamily,
      font_size: primary.fontSize,
      is_subset_font: hasSubset,
      mapping_status: mappingStatus,
      safe_to_edit: !hasSubset && !hasUnmappedGlyphs,
      safety_reason: hasUnmappedGlyphs
        ? 'incomplete_tounicode_mapping'
        : (hasSubset ? mappingStatus : 'standard_editable_text'),
      page_height: pageHeight,
    };
  }).filter((l) => l.text.length > 0);
}

// Group consecutive lines on the same page into multi-line paragraph regions,
// detecting line spacing, paragraph boundaries, alignment, and available vertical space.
function groupLinesIntoParagraphs(lines, pageNumber, pageWidth, pageHeight) {
  if (!lines.length) return [];
  const groups = [];
  let cur = [lines[0]];

  for (let i = 1; i < lines.length; i++) {
    const prev = cur[cur.length - 1];
    const next = lines[i];
    const dy = prev.bbox.y - next.bbox.y;
    const sameFontSize = Math.abs(prev.font_size - next.font_size) <= 1.0;
    const normalSpacing = dy >= prev.font_size * 0.7 && dy <= prev.font_size * 2.15;
    const xClose = Math.abs(prev.bbox.x - next.bbox.x) <= 36;

    if (sameFontSize && normalSpacing && xClose) {
      cur.push(next);
    } else {
      groups.push(cur);
      cur = [next];
    }
  }
  groups.push(cur);

  return groups.map((g, idx) => {
    const minX = Math.min(...g.map((l) => l.bbox.x));
    const maxX = Math.max(...g.map((l) => l.bbox.x + l.bbox.width));
    const topY = Math.max(...g.map((l) => l.bbox.y + l.bbox.height));
    const bottomY = Math.min(...g.map((l) => l.bbox.y));

    const spacings = [];
    for (let i = 1; i < g.length; i++) {
      spacings.push(g[i - 1].bbox.y - g[i].bbox.y);
    }
    const lineSpacing = spacings.length
      ? Math.round((spacings.reduce((a, b) => a + b, 0) / spacings.length) * 100) / 100
      : Math.round(g[0].font_size * 1.45 * 100) / 100;

    // Detect alignment across multi-line paragraphs
    let alignment = 'left';
    if (g.length >= 2) {
      const nonLast = g.slice(0, -1);
      const rightEdges = nonLast.map((l) => l.bbox.x + l.bbox.width);
      const leftEdges = nonLast.map((l) => l.bbox.x);
      const leftSpread = Math.max(...leftEdges) - Math.min(...leftEdges);
      const rightSpread = Math.max(...rightEdges) - Math.min(...rightEdges);
      const centers = g.map((l) => l.bbox.x + l.bbox.width / 2);
      const centerSpread = Math.max(...centers) - Math.min(...centers);

      if (leftSpread <= 6 && rightSpread <= 8 && (maxX - minX) >= pageWidth * 0.45) {
        alignment = 'justified';
      } else if (centerSpread <= 8 && leftSpread > 10) {
        alignment = 'center';
      } else if (rightSpread <= 6 && leftSpread > 10) {
        alignment = 'right';
      }
    }

    // Available vertical height before next paragraph or bottom margin
    const nextGroup = groups[idx + 1];
    const floorY = nextGroup ? Math.max(...nextGroup.map((l) => l.bbox.y + l.bbox.height)) + 4 : 42;
    const availableHeight = Math.round(Math.max(topY - bottomY, topY - floorY) * 100) / 100;

    const primary = g[0];
    const hasSubset = g.some((l) => l.is_subset_font);
    const hasIncomplete = g.some((l) => l.mapping_status === 'subset_incomplete_mapping');

    return {
      paragraph_id: `p${pageNumber}_para_${idx + 1}`,
      page: pageNumber,
      line_count: g.length,
      text: g.map((l) => l.text).join(' '),
      lines: g,
      line_spacing: lineSpacing,
      alignment,
      bbox: {
        x: Math.round(minX * 100) / 100,
        y: Math.round(bottomY * 100) / 100,
        width: Math.round(Math.max(1, maxX - minX) * 100) / 100,
        height: Math.round(Math.max(1, topY - bottomY) * 100) / 100,
      },
      available_width: Math.round(Math.max(maxX - minX, pageWidth - minX - 36) * 100) / 100,
      available_height: availableHeight,
      font_name: primary.font_name,
      font_family: primary.font_family,
      font_size: primary.font_size,
      is_subset_font: hasSubset,
      mapping_status: hasIncomplete ? 'subset_incomplete_mapping' : primary.mapping_status,
      page_height: pageHeight,
    };
  });
}

function wrapTextToWidth(text, font, fontSize, maxWidth) {
  const words = String(text || '').split(/\s+/).filter(Boolean);
  if (!words.length) return [''];
  const out = [];
  let line = words[0];
  for (let i = 1; i < words.length; i++) {
    const candidate = `${line} ${words[i]}`;
    if (font.widthOfTextAtSize(candidate, fontSize) <= maxWidth) {
      line = candidate;
    } else {
      out.push(line);
      line = words[i];
    }
  }
  out.push(line);
  return out;
}

export async function inspectPdf(buffer) {
  const bytes = new Uint8Array(buffer);
  let pdfLibDoc = null;
  let fonts = [];
  let acroFormFields = [];
  let securityRisks = { has_javascript: false, has_launch_action: false, has_embedded_files: false };

  try {
    pdfLibDoc = await PDFDocument.load(bytes, { ignoreEncryption: true });
    securityRisks = scanPdfSecurityRisks(pdfLibDoc);
    fonts = detectPdfFontsFromLib(pdfLibDoc);
    acroFormFields = detectAcroFormFields(pdfLibDoc);
  } catch {
    // Ignore if pdf-lib fails
  }

  if (securityRisks.has_javascript || securityRisks.has_launch_action) {
    throw new Error('Dokumen PDF ditolak: mengandung skrip aktif atau aksi berbahaya (/JavaScript atau /Launch).');
  }

  const hasAnySubsetFont = fonts.some((f) => f.is_subset);
  const hasIncompleteMapping = fonts.some((f) => f.mapping_status === 'subset_incomplete_mapping');
  const fontMap = new Map(fonts.map((f) => [f.name, f]));

  const loadingTask = pdfjsLib.getDocument({
    data: new Uint8Array(bytes),
    useSystemFonts: true,
    disableFontFace: true,
    verbosity: 0,
  });
  const pdfjsDoc = await loadingTask.promise;

  const pageCount = pdfjsDoc.numPages;
  if (pageCount > MAX_PDF_PAGES) {
    await loadingTask.destroy?.().catch(() => {});
    throw new Error(`Dokumen PDF ditolak: jumlah halaman (${pageCount}) melebihi batas aman maksimum (${MAX_PDF_PAGES} halaman).`);
  }
  const pages = [];
  const pageDimensions = [];
  const allRegions = [];
  const allParagraphs = [];
  const pageTextParts = [];

  for (let p = 1; p <= pageCount; p++) {
    const page = await pdfjsDoc.getPage(p);
    const viewport = page.getViewport({ scale: 1.0 });
    const width = Math.round(viewport.width * 100) / 100;
    const height = Math.round(viewport.height * 100) / 100;
    pageDimensions.push({ page: p, width, height });

    const textContent = await page.getTextContent();
    const lines = groupItemsIntoLines(textContent.items || [], p, width, height, textContent.styles || {}, fontMap);

    let imageCount = 0;
    let vectorOpsCount = 0;
    let hasTransparency = false;
    try {
      const opList = await page.getOperatorList();
      const imageOps = new Set([
        pdfjsLib.OPS.paintImageXObject,
        pdfjsLib.OPS.paintInlineImageXObject,
        pdfjsLib.OPS.paintImageMaskXObject,
      ]);
      const vectorOps = new Set([
        pdfjsLib.OPS.stroke,
        pdfjsLib.OPS.fill,
        pdfjsLib.OPS.eoFill,
        pdfjsLib.OPS.fillStroke,
      ]);
      for (const fn of opList.fnArray) {
        if (imageOps.has(fn)) imageCount += 1;
        else if (vectorOps.has(fn)) vectorOpsCount += 1;
        else if (fn === pdfjsLib.OPS.setGState) hasTransparency = true;
      }
    } catch {
      // Ignore opList errors
    }

    // Propagate document-level subset/incomplete mapping status when all fonts are subsetted
    if (hasAnySubsetFont && fonts.every((f) => f.is_subset)) {
      const docStatus = hasIncompleteMapping ? 'subset_incomplete_mapping' : 'subset_with_tounicode';
      for (const line of lines) {
        line.is_subset_font = true;
        line.mapping_status = docStatus;
        line.safe_to_edit = false;
        line.safety_reason = docStatus;
      }
    }

    const paragraphs = groupLinesIntoParagraphs(lines, p, width, height);
    const pageText = lines.map((l) => l.text).join('\n');
    const charCount = pageText.replace(/\s+/g, '').length;
    const pageHasPlaceholder = Boolean(pageText.match(PLACEHOLDER_RE));
    const isScannedPage = charCount < 25 && !pageHasPlaceholder;

    pages.push({
      page: p,
      width,
      height,
      char_count: charCount,
      line_count: lines.length,
      paragraph_count: paragraphs.length,
      image_count: imageCount,
      vector_ops_count: vectorOpsCount,
      has_transparency: hasTransparency,
      is_scanned: isScannedPage,
      editable_status: isScannedPage ? 'scanned_image_only' : 'editable_text',
      text: pageText,
    });

    allRegions.push(...lines);
    allParagraphs.push(...paragraphs);
    if (pageText) pageTextParts.push(pageText);
  }

  await loadingTask.destroy?.().catch(() => {});

  const scannedPages = pages.filter((p) => p.is_scanned).map((p) => p.page);
  const editablePages = pages.filter((p) => !p.is_scanned).map((p) => p.page);
  const isAllScanned = pageCount > 0 && scannedPages.length === pageCount;
  const isMixed = scannedPages.length > 0 && editablePages.length > 0;
  const formText = acroFormFields.filter((f) => f.is_text_field && f.value.trim()).map((f) => f.value).join('\n');
  const fullText = [pageTextParts.join('\n\n'), formText].filter(Boolean).join('\n\n');

  const placeholders = [];
  for (const r of allRegions) {
    for (const m of r.text.matchAll(PLACEHOLDER_RE)) {
      placeholders.push({ token: m[0], page: r.page, region_id: r.region_id });
    }
  }
  for (const f of acroFormFields) {
    if (!f.is_text_field) continue;
    for (const m of f.value.matchAll(PLACEHOLDER_RE)) {
      placeholders.push({ token: m[0], field_name: f.name });
    }
  }

  let editableStatus = 'empty_or_unreadable';
  if (acroFormFields.some((f) => f.is_text_field)) editableStatus = 'fillable_acroform_pdf';
  else if (isAllScanned) editableStatus = 'scanned_image_only';
  else if (isMixed) editableStatus = 'mixed_editable_and_scanned';
  else if (editablePages.length > 0) {
    editableStatus = hasIncompleteMapping
      ? 'subset_incomplete_mapping'
      : (hasAnySubsetFont ? 'editable_with_subset_fonts' : 'editable_fixed_layout');
  }

  const inspectionBase = {
    format: 'pdf',
    text: fullText,
    page_count: pageCount,
    page_dimensions: pageDimensions,
    pages,
    scanned_pages: scannedPages,
    editable_pages: editablePages,
    fonts,
    acroform_fields: acroFormFields,
    has_acroform: acroFormFields.length > 0,
    placeholders,
    has_placeholders: placeholders.length > 0,
    has_subset_fonts: hasAnySubsetFont,
    has_incomplete_font_mapping: hasIncompleteMapping,
    has_embedded_fonts: fonts.some((f) => f.is_embedded),
    regions: allRegions,
    paragraphs: allParagraphs,
    has_text_layer: fullText.replace(/\s+/g, '').length > 0,
    is_scanned: isAllScanned && !acroFormFields.some((f) => f.is_text_field),
    is_mixed: isMixed,
    editable_status: editableStatus,
    recommendation: isAllScanned
      ? 'PDF ini terdeteksi sebagai dokumen hasil pindai (berbasis gambar). OCR dapat mengekstrak teksnya, namun untuk penyuntingan dengan preservasi tata letak penuh disarankan mengunggah berkas sumber DOCX.'
      : (hasIncompleteMapping
        ? 'PDF ini menggunakan font subset tanpa pemetaan ToUnicode lengkap. Penggantian teks otomatis ditolak demi menjaga keaslian dokumen; unggah berkas sumber DOCX.'
        : (hasAnySubsetFont
          ? 'PDF ini menggunakan font subset dengan pemetaan karakter. Penggantian otomatis dibatasi kecuali substitusi font kompatibel disetujui; disarankan mengunggah berkas sumber DOCX.'
          : 'PDF memiliki lapisan teks yang dapat diedit pada area aman (termasuk paragraf multi-baris dan latar berwarna/gradien) tanpa mengubah margin atau ukuran font.')),
  };

  return {
    ...inspectionBase,
    editing_strategy: selectPdfEditingStrategy(inspectionBase),
  };
}

// Automatic PDF template-preservation strategy selector:
// A. Editable PDF -> native_pdf_text_edit
// B. Fillable PDF -> fillable_acroform_edit
// C. Placeholder-based PDF -> placeholder_region_edit
// D. Suitable fixed-layout PDF -> optional_pdf_to_docx (opt-in / when native editing is constrained)
// E. Scanned or complex photographic PDF -> ocr_extract_only_preserve_original
export function selectPdfEditingStrategy(inspection, {
  allowOptionalPdfToDocx = false,
  libreOfficeAvailable = false,
} = {}) {
  if (!inspection || inspection.page_count === 0) {
    return {
      code: 'E',
      strategy: 'ocr_extract_only_preserve_original',
      native_editable: false,
      pdf_to_docx_eligible: false,
      preserve_original_pdf: true,
      reason: 'PDF kosong atau tidak dapat dibaca; berkas asli dipertahankan tanpa rekonstruksi teks polos.',
    };
  }

  // B. Fillable AcroForm PDF
  if (inspection.has_acroform && (inspection.acroform_fields || []).some((f) => f.is_text_field)) {
    return {
      code: 'B',
      strategy: 'fillable_acroform_edit',
      native_editable: true,
      pdf_to_docx_eligible: false,
      preserve_original_pdf: true,
      reason: 'PDF memiliki field formulir AcroForm aktif; pengisian dilakukan langsung pada field formulir asli.',
    };
  }

  // C. Placeholder-based PDF
  if (inspection.has_placeholders && !inspection.is_scanned && !inspection.has_incomplete_font_mapping) {
    return {
      code: 'C',
      strategy: 'placeholder_region_edit',
      native_editable: true,
      pdf_to_docx_eligible: false,
      preserve_original_pdf: true,
      reason: 'PDF berbasis placeholder terdeteksi; penggantian dilakukan khusus pada area placeholder yang ditetapkan.',
    };
  }

  const totalImages = (inspection.pages || []).reduce((sum, p) => sum + (p.image_count || 0), 0);
  const totalChars = (inspection.pages || []).reduce((sum, p) => sum + (p.char_count || 0), 0);
  const isComplexPhotographic = !inspection.is_scanned
    && totalImages >= Math.max(3, inspection.page_count * 2)
    && totalChars < inspection.page_count * 120;

  // E. Scanned, mixed-scanned, incomplete font mapping, or complex photographic PDF
  if (inspection.is_scanned || inspection.is_mixed || inspection.has_incomplete_font_mapping || isComplexPhotographic) {
    const reason = inspection.is_scanned
      ? 'PDF hasil pindai (berbasis gambar). Gunakan OCR hanya untuk ekstraksi teks; jangan memaksa penggantian latar belakang.'
      : (inspection.has_incomplete_font_mapping
        ? 'PDF memakai font subset tanpa pemetaan ToUnicode lengkap; penggantian otomatis ditolak demi menjaga integritas karakter.'
        : (isComplexPhotographic
          ? 'PDF memiliki dominasi elemen fotografis/gambar kompleks; berkas asli dipertahankan tanpa menimpa latar.'
          : 'PDF campuran halaman pindai dan teks; hindari penggantian otomatis pada halaman pindai dan pertahankan berkas asli.'));
    return {
      code: 'E',
      strategy: 'ocr_extract_only_preserve_original',
      native_editable: false,
      pdf_to_docx_eligible: false,
      preserve_original_pdf: true,
      reason,
    };
  }

  // D. Suitable fixed-layout PDF for optional PDF-to-DOCX investigation
  const isSuitableForPdfToDocx = inspection.has_text_layer
    && !inspection.is_scanned
    && !inspection.has_incomplete_font_mapping
    && totalImages <= inspection.page_count * 2;

  if (isSuitableForPdfToDocx && (allowOptionalPdfToDocx || inspection.has_subset_fonts)) {
    return {
      code: 'D',
      strategy: 'optional_pdf_to_docx',
      native_editable: !inspection.has_subset_fonts,
      pdf_to_docx_eligible: true,
      libreoffice_ready: Boolean(libreOfficeAvailable),
      preserve_original_pdf: true,
      reason: 'PDF fixed-layout layak diuji melalui alur opsional PDF-ke-DOCX dengan verifikasi struktur & visual; konversi tidak menjamin tata letak identik dan akan ditolak jika terjadi perbedaan signifikan.',
    };
  }

  // A. Standard editable PDF -> Native PDF text editing
  return {
    code: 'A',
    strategy: 'native_pdf_text_edit',
    native_editable: true,
    pdf_to_docx_eligible: isSuitableForPdfToDocx,
    preserve_original_pdf: true,
    reason: 'PDF memiliki lapisan teks standar yang aman; gunakan penyuntingan teks PDF native pada berkas asli.',
  };
}

export function evaluatePdfTextOverflow(replacements = []) {
  const overflowFlags = [];
  for (const r of replacements) {
    const origLen = String(r.original_text || r.snippet || '').length;
    const revLen = String(r.revised_text || r.suggestion || '').length;
    if (origLen > 0 && revLen > Math.ceil(origLen * 1.15) && revLen - origLen > 12) {
      overflowFlags.push({
        original_length: origLen,
        revised_length: revLen,
        delta: revLen - origLen,
        snippet: String(r.original_text || r.snippet || '').slice(0, 80),
        message: 'Teks revisi lebih panjang dari teks asli dan berisiko menyebabkan luapan (overflow) pada tata letak PDF tetap.',
      });
    }
  }
  return {
    has_overflow_risk: overflowFlags.length > 0,
    overflow_flags: overflowFlags,
  };
}

export async function renderPdfPageToCanvas(buffer, pageNumber = 1, scale = 1.0) {
  const loadingTask = pdfjsLib.getDocument({
    data: new Uint8Array(buffer),
    useSystemFonts: true,
    disableFontFace: true,
    verbosity: 0,
  });
  const doc = await loadingTask.promise;
  try {
    const page = await doc.getPage(pageNumber);
    const viewport = page.getViewport({ scale });
    const width = Math.max(1, Math.ceil(viewport.width));
    const height = Math.max(1, Math.ceil(viewport.height));
    const canvas = createCanvas(width, height);
    const ctx = canvas.getContext('2d');
    ctx.fillStyle = '#FFFFFF';
    ctx.fillRect(0, 0, width, height);
    await page.render({ canvasContext: ctx, viewport }).promise;
    return {
      width,
      height,
      imageData: ctx.getImageData(0, 0, width, height).data,
      pngBuffer: canvas.toBuffer('image/png'),
    };
  } finally {
    await loadingTask.destroy?.().catch(() => {});
  }
}

async function applyBackgroundPatchToPdfPage(pdfDoc, pdfPage, restoration, rect) {
  if (restoration.mode === 'solid_color') {
    const { r, g, b } = restoration.color;
    pdfPage.drawRectangle({
      x: rect.x,
      y: rect.y,
      width: rect.width,
      height: rect.height,
      color: rgb(r, g, b),
    });
    return;
  }
  if (restoration.mode === 'gradient_patch_png' && restoration.pngBuffer) {
    const img = await pdfDoc.embedPng(restoration.pngBuffer);
    pdfPage.drawImage(img, {
      x: rect.x,
      y: rect.y,
      width: rect.width,
      height: rect.height,
    });
  }
}

function drawAlignedLine(pdfPage, lineText, { x, y, width, font, fontSize, alignment, isLastLine }) {
  const clean = normalizeForPdfWinAnsi(lineText);
  const lineWidth = font.widthOfTextAtSize(clean, fontSize);
  let drawX = x;

  if (alignment === 'center') {
    drawX = x + Math.max(0, (width - lineWidth) / 2);
  } else if (alignment === 'right') {
    drawX = x + Math.max(0, width - lineWidth);
  } else if (alignment === 'justified' && !isLastLine) {
    const words = clean.split(/\s+/).filter(Boolean);
    if (words.length > 1) {
      const wordsWidth = words.reduce((sum, w) => sum + font.widthOfTextAtSize(w, fontSize), 0);
      const extraSpace = width - wordsWidth;
      if (extraSpace > 0 && extraSpace < width * 0.45) {
        const gap = extraSpace / (words.length - 1);
        let curX = x;
        for (const w of words) {
          pdfPage.drawText(w, { x: curX, y, size: fontSize, font, color: rgb(0.05, 0.05, 0.05) });
          curX += font.widthOfTextAtSize(w, fontSize) + gap;
        }
        return;
      }
    }
  }

  pdfPage.drawText(clean, { x: drawX, y, size: fontSize, font, color: rgb(0.05, 0.05, 0.05) });
}

// Build a full-page layout map of occupied zones (headers, footers, headings,
// paragraphs, tables/vector zones) and compute all available whitespace bands on a page.
export function buildPageLayoutMap(pageInfo, pageRegions) {
  const headerBottomY = pageInfo.height - 58;
  const footerTopY = 52;
  const occupied = [];

  for (const r of pageRegions) {
    occupied.push({
      bottom: Math.max(footerTopY, r.bbox.y - 4),
      top: Math.min(headerBottomY, r.bbox.y + r.bbox.height + 4),
    });
  }

  // Merge overlapping occupied vertical intervals
  occupied.sort((a, b) => a.bottom - b.bottom);
  const merged = [];
  for (const iv of occupied) {
    if (!merged.length || iv.bottom > merged[merged.length - 1].top) {
      merged.push({ ...iv });
    } else {
      merged[merged.length - 1].top = Math.max(merged[merged.length - 1].top, iv.top);
    }
  }

  // Compute free whitespace bands from top of page downward (descending PDF Y)
  const freeBands = [];
  let cursorTop = headerBottomY;
  for (let i = merged.length - 1; i >= 0; i--) {
    const iv = merged[i];
    if (cursorTop - iv.top >= 18) {
      freeBands.push({
        top: Math.round(cursorTop * 100) / 100,
        bottom: Math.round(iv.top * 100) / 100,
        height: Math.round((cursorTop - iv.top) * 100) / 100,
        position_label: i === merged.length - 1 ? 'top_of_page' : 'between_elements',
      });
    }
    cursorTop = Math.min(cursorTop, iv.bottom);
  }
  if (cursorTop - footerTopY >= 18) {
    freeBands.push({
      top: Math.round(cursorTop * 100) / 100,
      bottom: footerTopY,
      height: Math.round((cursorTop - footerTopY) * 100) / 100,
      position_label: merged.length === 0 ? 'full_page' : 'below_content',
    });
  }

  return {
    page: pageInfo.page,
    header_bottom_y: headerBottomY,
    footer_top_y: footerTopY,
    occupied_intervals: merged,
    free_bands: freeBands,
  };
}

// Plan controlled cross-page paragraph reflow across page p+1..N, scanning full-page
// available whitespace bands (top, below headings/tables/figures, or subsequent pages).
// Never overwrites headings, tables, figures, captions, headers, or footers.
export function planCrossPageReflow(targetPara, wrappedLines, inspection) {
  const maxLinesCurrent = Math.max(
    1,
    Math.floor((targetPara.available_height - targetPara.font_size * 1.2) / targetPara.line_spacing) + 1,
  );
  const currentLines = wrappedLines.slice(0, maxLinesCurrent);
  const overflowLines = wrappedLines.slice(maxLinesCurrent);

  if (!overflowLines.length) {
    return { needed: false, safe_to_reflow: true };
  }

  const overflowHeightNeeded = overflowLines.length * targetPara.line_spacing + targetPara.font_size;
  const candidatePages = inspection.pages.filter((p) => p.page > targetPara.page && !p.is_scanned);
  const constrainingPages = [];

  for (const pageInfo of candidatePages) {
    const pageRegions = inspection.regions.filter((r) => r.page === pageInfo.page);
    const layoutMap = buildPageLayoutMap(pageInfo, pageRegions);

    // Find the first free whitespace band on this page that safely fits overflowHeightNeeded
    const validBand = layoutMap.free_bands.find((b) => b.height >= overflowHeightNeeded + 12);
    if (validBand) {
      return {
        needed: true,
        safe_to_reflow: true,
        requires_user_approval: true,
        affected_pages: [targetPara.page, pageInfo.page],
        lines_on_current_page: currentLines.length,
        overflow_lines: overflowLines,
        current_lines: currentLines,
        continuation_page: pageInfo.page,
        continuation_band: validBand.position_label,
        continuation_start_y: Math.round((validBand.top - targetPara.font_size - 4) * 100) / 100,
        page_count_preserved: true,
        reason: `${overflowLines.length} baris lanjutan akan ditempatkan pada area kosong (${validBand.position_label}) di halaman ${pageInfo.page} tanpa menimpa heading, tabel, atau gambar.`,
      };
    }
    constrainingPages.push(pageInfo.page);
  }

  return {
    needed: true,
    safe_to_reflow: false,
    requires_user_approval: true,
    affected_pages: [targetPara.page, ...constrainingPages],
    constraining_pages: constrainingPages.length ? constrainingPages : [targetPara.page],
    lines_on_current_page: currentLines.length,
    overflow_lines: overflowLines,
    needed_height: Math.round(overflowHeightNeeded * 100) / 100,
    reason: constrainingPages.length
      ? `Halaman ${constrainingPages.join(', ')} terlalu padat dan tidak memiliki ruang kosong yang aman untuk menampung ${overflowLines.length} baris lanjutan. Unggah berkas DOCX sumber.`
      : 'Tidak ada halaman lanjutan yang dapat disunting untuk menampung luapan paragraf; unggah berkas DOCX sumber.',
  };
}

// Staged, safe PDF text replacement supporting:
// - Single-line AND multi-line paragraph replacement (preserving alignment & line spacing)
// - Controlled cross-page reflow with explicit user approval gate (allowCrossPageReflow)
// - Deeper subset font validation (rejects incomplete ToUnicode; never silently substitutes)
// - Complex background classification & restoration (solid color & gradient patches; optional preview gate)
export async function applyPdfEdits(originalBuffer, edits = [], {
  shortenRevision = null,
  allowCompatibleSubstitution = false,
  allowCrossPageReflow = false,
  allowOptionalRestorationPreview = false,
  backgroundSampleScale = 1.0,
} = {}) {
  const inspection = await inspectPdf(originalBuffer);
  const applied = [];
  const flaggedRegions = [];
  const pendingReflowPlans = [];

  if (!Array.isArray(edits) || edits.length === 0) {
    return {
      buffer: Buffer.from(originalBuffer),
      modified: false,
      applied_count: 0,
      flagged_count: 0,
      applied,
      flagged_regions: flaggedRegions,
      pending_reflow_plans: pendingReflowPlans,
      recommend_docx: false,
      inspection,
    };
  }

  const pdfDoc = await PDFDocument.load(new Uint8Array(originalBuffer), { ignoreEncryption: true });
  const pages = pdfDoc.getPages();
  const embeddedFontCache = new Map();
  const renderedPageCache = new Map();

  const getFont = async (fontName) => {
    const std = mapToStandardFont(fontName);
    if (!embeddedFontCache.has(std)) {
      embeddedFontCache.set(std, await pdfDoc.embedFont(std));
    }
    return embeddedFontCache.get(std);
  };

  const getRenderedPage = async (pageNum) => {
    if (!renderedPageCache.has(pageNum)) {
      renderedPageCache.set(pageNum, await renderPdfPageToCanvas(originalBuffer, pageNum, backgroundSampleScale));
    }
    return renderedPageCache.get(pageNum);
  };

  for (const edit of edits) {
    const snippet = String(edit.snippet || edit.original_text || '').trim();
    const initialSuggestion = String(edit.suggestion || edit.revised_text || '').trim();
    if (!snippet || !initialSuggestion || snippet === initialSuggestion) continue;

    // 0. Fillable AcroForm PDF fields: update matching text field natively without altering page design
    if (inspection.has_acroform) {
      let formMatched = false;
      try {
        const form = pdfDoc.getForm();
        for (const f of form.getFields()) {
          if (typeof f.getText !== 'function' || typeof f.setText !== 'function') continue;
          const curVal = String(f.getText() || '');
          if (curVal.includes(snippet) || (edit.field_name && f.getName() === edit.field_name)) {
            const updatedVal = curVal.includes(snippet) ? curVal.replace(snippet, initialSuggestion) : initialSuggestion;
            f.setText(normalizeForPdfWinAnsi(updatedVal));
            applied.push({
              region_id: `acroform:${f.getName()}`,
              field_name: f.getName(),
              mode: 'acroform_field',
              snippet: snippet.slice(0, 80),
              suggestion: initialSuggestion.slice(0, 80),
            });
            formMatched = true;
            break;
          }
        }
      } catch {
        // Continue to text-layer editing if AcroForm access fails
      }
      if (formMatched) continue;
    }

    // 1. Locate matching single line OR multi-line paragraph region
    const lineMatch = inspection.regions.find((r) => r.text.includes(snippet));
    const paraMatch = !lineMatch
      ? inspection.paragraphs.find((p) => p.text.includes(snippet))
      : null;

    const target = lineMatch || paraMatch;
    const isMultiLine = Boolean(paraMatch);

    if (!target) {
      flaggedRegions.push({
        snippet: snippet.slice(0, 80),
        reason: inspection.has_incomplete_font_mapping ? 'incomplete_tounicode_mapping' : 'region_not_found',
        message: inspection.has_incomplete_font_mapping
          ? 'Font subset tidak memiliki pemetaan ToUnicode lengkap sehingga teks tidak dapat dipetakan secara aman; unggah DOCX sumber.'
          : 'Teks tidak ditemukan sebagai blok aman pada PDF; disarankan menyunting berkas DOCX sumber.',
      });
      continue;
    }

    const pageInfo = inspection.pages.find((p) => p.page === target.page);
    if (pageInfo?.is_scanned) {
      flaggedRegions.push({
        region_id: target.region_id || target.paragraph_id,
        page: target.page,
        snippet: snippet.slice(0, 80),
        reason: 'scanned_page',
        message: 'Halaman hasil pindai tidak dapat disunting in-place tanpa merusak gambar asli. Unggah berkas DOCX sumber.',
      });
      continue;
    }

    // 2. Validate font & ToUnicode character mapping
    if (target.mapping_status === 'subset_incomplete_mapping') {
      flaggedRegions.push({
        region_id: target.region_id || target.paragraph_id,
        page: target.page,
        snippet: snippet.slice(0, 80),
        reason: 'incomplete_tounicode_mapping',
        message: 'Font subset tidak memiliki pemetaan ToUnicode lengkap. Penggantian ditolak demi mencegah kerusakan karakter; unggah DOCX sumber.',
      });
      continue;
    }

    let fontSubstituted = false;
    if (target.is_subset_font) {
      if (!allowCompatibleSubstitution) {
        flaggedRegions.push({
          region_id: target.region_id || target.paragraph_id,
          page: target.page,
          snippet: snippet.slice(0, 80),
          reason: 'subset_font_unsafe',
          message: 'Area teks memakai font subset tertanam. Substitusi font tidak dilakukan diam-diam; unggah berkas DOCX sumber.',
        });
        continue;
      }
      fontSubstituted = true;
    }

    // 3. Classify & evaluate background restoration BEFORE modifying
    const rendered = await getRenderedPage(target.page);
    const bgClass = classifyRegionBackground(rendered, target.bbox, target.page_height, backgroundSampleScale, {
      pageHasImages: (pageInfo?.image_count || 0) > 0,
      isScanned: Boolean(pageInfo?.is_scanned),
    });

    if (!bgClass.safe_to_restore) {
      const previewAttempt = buildBackgroundRestoration(bgClass, {
        widthPt: target.bbox.width,
        heightPt: target.bbox.height,
        allowOptionalPreview: allowOptionalRestorationPreview,
      });
      if (!previewAttempt.restorable) {
        flaggedRegions.push({
          region_id: target.region_id || target.paragraph_id,
          page: target.page,
          affected_page: target.page,
          affected_bbox: target.bbox,
          snippet: snippet.slice(0, 80),
          revised_text_separate: initialSuggestion,
          reason: 'complex_background_unsafe',
          background_type: bgClass.type,
          restoration_quality_score: previewAttempt.quality_score ?? null,
          recommendation: 'Unggah berkas sumber DOCX, PPTX, atau file desain asli untuk menyunting teks di atas latar kompleks.',
          message: `Latar belakang (${bgClass.type}) tidak dapat direkonstruksi tanpa risiko artefak visual. PDF asli dipertahankan; teks revisi tersedia terpisah.`,
        });
        continue;
      }
    }

    const font = await getFont(target.font_family || target.font_name);
    const pdfPage = pages[target.page - 1];

    if (!isMultiLine) {
      // Single-line safe replacement
      let targetSuggestion = initialSuggestion;
      let newLineText = target.text.replace(snippet, targetSuggestion);
      let cleanNewLine = normalizeForPdfWinAnsi(newLineText);
      let measuredWidth = font.widthOfTextAtSize(cleanNewLine, target.font_size);

      if (measuredWidth > target.available_width && typeof shortenRevision === 'function') {
        const shorter = await shortenRevision({
          original: snippet,
          revised: targetSuggestion,
          maxChars: Math.max(5, Math.floor(snippet.length * 0.95)),
        });
        if (typeof shorter === 'string' && shorter.trim()) {
          const cand = normalizeForPdfWinAnsi(target.text.replace(snippet, shorter.trim()));
          const candW = font.widthOfTextAtSize(cand, target.font_size);
          if (candW <= target.available_width) {
            targetSuggestion = shorter.trim();
            newLineText = target.text.replace(snippet, targetSuggestion);
            cleanNewLine = cand;
            measuredWidth = candW;
          }
        }
      }

      if (measuredWidth > target.available_width) {
        flaggedRegions.push({
          region_id: target.region_id,
          page: target.page,
          snippet: snippet.slice(0, 80),
          reason: 'text_overflow',
          measured_width: Math.round(measuredWidth * 100) / 100,
          available_width: target.available_width,
          message: 'Teks revisi melebihi lebar area asli (risiko overflow). Font tidak diperkecil otomatis; ringkas teks atau unggah DOCX sumber.',
        });
        continue;
      }

      const padX = 1;
      const padY = Math.max(2, target.font_size * 0.22);
      const patchRect = {
        x: Math.max(0, target.bbox.x - padX),
        y: Math.max(0, target.bbox.y - padY),
        width: Math.max(target.bbox.width, measuredWidth) + padX * 2,
        height: target.bbox.height + padY * 1.5,
      };
      const restoration = buildBackgroundRestoration(bgClass, {
        widthPt: patchRect.width,
        heightPt: patchRect.height,
      });
      await applyBackgroundPatchToPdfPage(pdfDoc, pdfPage, restoration, patchRect);

      pdfPage.drawText(cleanNewLine, {
        x: target.bbox.x,
        y: target.bbox.y,
        size: target.font_size,
        font,
        color: rgb(0.05, 0.05, 0.05),
      });

      target.text = newLineText;
      applied.push({
        region_id: target.region_id,
        page: target.page,
        mode: 'single_line',
        background_type: bgClass.type,
        restoration_mode: restoration.mode,
        font_substituted: fontSubstituted,
        font_size: target.font_size,
        bbox: target.bbox,
        snippet: snippet.slice(0, 80),
        suggestion: targetSuggestion.slice(0, 80),
      });
    } else {
      // Multi-line paragraph replacement preserving width, alignment, and line spacing
      let targetSuggestion = initialSuggestion;
      let newParaText = target.text.replace(snippet, targetSuggestion);
      let wrapped = wrapTextToWidth(normalizeForPdfWinAnsi(newParaText), font, target.font_size, target.bbox.width);
      let neededHeight = (wrapped.length - 1) * target.line_spacing + target.font_size * 1.2;

      if (neededHeight > target.available_height && typeof shortenRevision === 'function') {
        const shorter = await shortenRevision({
          original: snippet,
          revised: targetSuggestion,
          maxChars: Math.max(10, Math.floor(snippet.length * 0.9)),
        });
        if (typeof shorter === 'string' && shorter.trim()) {
          const candText = target.text.replace(snippet, shorter.trim());
          const candWrapped = wrapTextToWidth(normalizeForPdfWinAnsi(candText), font, target.font_size, target.bbox.width);
          const candH = (candWrapped.length - 1) * target.line_spacing + target.font_size * 1.2;
          if (candH <= target.available_height) {
            targetSuggestion = shorter.trim();
            newParaText = candText;
            wrapped = candWrapped;
            neededHeight = candH;
          }
        }
      }

      if (neededHeight > target.available_height) {
        const reflowPlan = planCrossPageReflow(target, wrapped, inspection);
        if (reflowPlan.safe_to_reflow && !allowCrossPageReflow) {
          pendingReflowPlans.push({
            region_id: target.paragraph_id,
            ...reflowPlan,
          });
          flaggedRegions.push({
            region_id: target.paragraph_id,
            page: target.page,
            affected_pages: reflowPlan.affected_pages,
            snippet: snippet.slice(0, 80),
            revised_text_separate: targetSuggestion,
            reason: 'cross_page_reflow_requires_approval',
            reflow_plan: reflowPlan,
            message: `Paragraf revisi memerlukan perpindahan ${reflowPlan.overflow_lines.length} baris ke halaman ${reflowPlan.continuation_page}. Diperlukan persetujuan eksplisit pengguna sebelum reflow diterapkan.`,
          });
          continue;
        }
        if (!reflowPlan.needed || !reflowPlan.safe_to_reflow) {
          flaggedRegions.push({
            region_id: target.paragraph_id,
            page: target.page,
            affected_page: target.page,
            affected_bbox: target.bbox,
            snippet: snippet.slice(0, 80),
            revised_text_separate: targetSuggestion,
            reason: 'paragraph_vertical_overflow',
            needed_height: Math.round(neededHeight * 100) / 100,
            available_height: target.available_height,
            recommendation: 'Unggah berkas sumber DOCX agar reflow antar-halaman tetap menjaga seluruh tata letak dokumen.',
            message: reflowPlan.reason || 'Paragraf revisi melebihi ruang vertikal yang tersedia (risiko tumpang tindih paragraf berikutnya).',
          });
          continue;
        }

        // Explicitly approved safe cross-page reflow on working copy!
        const padX = 2;
        const padY = Math.max(2, target.font_size * 0.25);
        const topBaselineY = target.lines[0].bbox.y;
        const patchRect = {
          x: Math.max(0, target.bbox.x - padX),
          y: Math.max(0, target.bbox.y - padY),
          width: target.bbox.width + padX * 2,
          height: target.bbox.height + padY * 2,
        };
        const restoration = buildBackgroundRestoration(bgClass, {
          widthPt: patchRect.width,
          heightPt: patchRect.height,
        });
        await applyBackgroundPatchToPdfPage(pdfDoc, pdfPage, restoration, patchRect);

        for (let i = 0; i < reflowPlan.current_lines.length; i++) {
          drawAlignedLine(pdfPage, reflowPlan.current_lines[i], {
            x: target.bbox.x,
            y: topBaselineY - i * target.line_spacing,
            width: target.bbox.width,
            font,
            fontSize: target.font_size,
            alignment: target.alignment,
            isLastLine: false,
          });
        }

        const nextPdfPage = pages[reflowPlan.continuation_page - 1];
        for (let j = 0; j < reflowPlan.overflow_lines.length; j++) {
          drawAlignedLine(nextPdfPage, reflowPlan.overflow_lines[j], {
            x: target.bbox.x,
            y: reflowPlan.continuation_start_y - j * target.line_spacing,
            width: target.bbox.width,
            font,
            fontSize: target.font_size,
            alignment: target.alignment,
            isLastLine: j === reflowPlan.overflow_lines.length - 1,
          });
        }

        target.text = newParaText;
        applied.push({
          region_id: target.paragraph_id,
          page: target.page,
          affected_pages: reflowPlan.affected_pages,
          mode: 'cross_page_reflow',
          lines_on_current_page: reflowPlan.current_lines.length,
          lines_on_next_page: reflowPlan.overflow_lines.length,
          alignment: target.alignment,
          line_spacing: target.line_spacing,
          background_type: bgClass.type,
          restoration_mode: restoration.mode,
          font_substituted: fontSubstituted,
          font_size: target.font_size,
          bbox: target.bbox,
          snippet: snippet.slice(0, 80),
          suggestion: targetSuggestion.slice(0, 80),
        });
        continue;
      }

      const padX = 2;
      const padY = Math.max(2, target.font_size * 0.25);
      const topBaselineY = target.lines[0].bbox.y;
      const lowestBaselineY = Math.min(target.bbox.y, topBaselineY - (wrapped.length - 1) * target.line_spacing);
      const patchRect = {
        x: Math.max(0, target.bbox.x - padX),
        y: Math.max(0, lowestBaselineY - padY),
        width: target.bbox.width + padX * 2,
        height: (topBaselineY + target.font_size - lowestBaselineY) + padY * 2,
      };

      const restoration = buildBackgroundRestoration(bgClass, {
        widthPt: patchRect.width,
        heightPt: patchRect.height,
      });
      await applyBackgroundPatchToPdfPage(pdfDoc, pdfPage, restoration, patchRect);

      for (let i = 0; i < wrapped.length; i++) {
        const lineY = topBaselineY - i * target.line_spacing;
        drawAlignedLine(pdfPage, wrapped[i], {
          x: target.bbox.x,
          y: lineY,
          width: target.bbox.width,
          font,
          fontSize: target.font_size,
          alignment: target.alignment,
          isLastLine: i === wrapped.length - 1,
        });
      }

      target.text = newParaText;
      applied.push({
        region_id: target.paragraph_id,
        page: target.page,
        mode: 'multi_line_paragraph',
        line_count: wrapped.length,
        alignment: target.alignment,
        line_spacing: target.line_spacing,
        background_type: bgClass.type,
        restoration_mode: restoration.mode,
        font_substituted: fontSubstituted,
        font_size: target.font_size,
        bbox: target.bbox,
        snippet: snippet.slice(0, 80),
        suggestion: targetSuggestion.slice(0, 80),
      });
    }
  }

  const outBuffer = applied.length > 0
    ? Buffer.from(await pdfDoc.save({ useObjectStreams: false }))
    : Buffer.from(originalBuffer);

  return {
    buffer: outBuffer,
    modified: applied.length > 0,
    applied_count: applied.length,
    flagged_count: flaggedRegions.length,
    applied,
    flagged_regions: flaggedRegions,
    pending_reflow_plans: pendingReflowPlans,
    recommend_docx: flaggedRegions.length > 0,
    inspection,
  };
}

export async function comparePdfVisually(originalBuffer, modifiedBuffer, { scale = 0.75, editedRegions = [] } = {}) {
  const origTask = pdfjsLib.getDocument({ data: new Uint8Array(originalBuffer), useSystemFonts: true, disableFontFace: true, verbosity: 0 });
  const modTask = pdfjsLib.getDocument({ data: new Uint8Array(modifiedBuffer), useSystemFonts: true, disableFontFace: true, verbosity: 0 });
  const origDoc = await origTask.promise;
  const modDoc = await modTask.promise;

  try {
    const pageCountMatch = origDoc.numPages === modDoc.numPages;
    const pagesToCompare = Math.min(origDoc.numPages, modDoc.numPages);
    const pageResults = [];
    const artifactIssues = [];

    for (let p = 1; p <= pagesToCompare; p++) {
      const a = await renderPdfPageToCanvas(originalBuffer, p, scale);
      const b = await renderPdfPageToCanvas(modifiedBuffer, p, scale);
      const dimensionsMatch = a.width === b.width && a.height === b.height;
      let changedPixels = 0;
      const totalPixels = a.width * a.height;

      if (dimensionsMatch) {
        for (let i = 0; i < a.imageData.length; i += 4) {
          const dr = Math.abs(a.imageData[i] - b.imageData[i]);
          const dg = Math.abs(a.imageData[i + 1] - b.imageData[i + 1]);
          const db = Math.abs(a.imageData[i + 2] - b.imageData[i + 2]);
          if (dr > 15 || dg > 15 || db > 15) changedPixels += 1;
        }
      } else {
        changedPixels = totalPixels;
      }

      const similarityPercent = totalPixels > 0
        ? Math.round(((totalPixels - changedPixels) / totalPixels) * 10000) / 100
        : 0;

      const pageEdits = editedRegions.filter((e) => e.page === p && e.bbox);
      let restorationCheck = { passed: true, artifact_count: 0, issues: [] };
      if (pageEdits.length > 0 && dimensionsMatch) {
        const pageObj = await origDoc.getPage(p);
        const vp1 = pageObj.getViewport({ scale: 1.0 });
        restorationCheck = validateBackgroundRestoration(a, b, pageEdits, vp1.height, scale);
        artifactIssues.push(...restorationCheck.issues);
      }

      pageResults.push({
        page: p,
        dimensions_match: dimensionsMatch,
        width: a.width,
        height: a.height,
        changed_pixels: changedPixels,
        total_pixels: totalPixels,
        visual_similarity_percent: similarityPercent,
        background_restoration_passed: restorationCheck.passed,
      });
    }

    const avgSimilarity = pageResults.length
      ? Math.round((pageResults.reduce((s, r) => s + r.visual_similarity_percent, 0) / pageResults.length) * 100) / 100
      : 0;

    return {
      compared: true,
      page_count_match: pageCountMatch,
      original_pages: origDoc.numPages,
      modified_pages: modDoc.numPages,
      average_visual_similarity_percent: avgSimilarity,
      white_patch_artifacts_detected: artifactIssues.some((i) => i.type === 'white_patch_artifact'),
      restoration_issues: artifactIssues,
      layout_preserved: pageCountMatch &&
        artifactIssues.length === 0 &&
        pageResults.every((r) => r.dimensions_match && r.visual_similarity_percent >= 85),
      pages: pageResults,
    };
  } finally {
    await origTask.destroy?.().catch(() => {});
    await modTask.destroy?.().catch(() => {});
  }
}
