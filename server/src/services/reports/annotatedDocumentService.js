// Optional Annotated Copy Generator for Original DOCX and PDF Documents.
// Creates a separate annotated working copy with color-coded highlights while
// preserving original formatting, layout, tables, images, headers, and footers,
// and NEVER modifying the original uploaded file.
import JSZip from 'jszip';
import { DOMParser, XMLSerializer } from '@xmldom/xmldom';
import { PDFDocument, rgb } from 'pdf-lib';
import { inspectPdf } from '../pdfEditor.js';

const W_NS = 'http://schemas.openxmlformats.org/wordprocessingml/2006/main';

const DOCX_HIGHLIGHT_VAL = {
  blue: 'cyan',
  red: 'red',
  orange: 'darkYellow',
  yellow: 'yellow',
  green: 'green',
  gray: 'lightGray',
};

const PDF_HIGHLIGHT_RGB = {
  blue: rgb(0.145, 0.388, 0.922),
  red: rgb(0.863, 0.149, 0.149),
  orange: rgb(0.918, 0.345, 0.047),
  yellow: rgb(0.95, 0.78, 0.05),
  green: rgb(0.086, 0.639, 0.290),
  gray: rgb(0.55, 0.58, 0.62),
};

export async function annotateOriginalDocx(originalBuffer, findings = []) {
  const zip = await JSZip.loadAsync(originalBuffer);
  const docFile = zip.file('word/document.xml');
  if (!docFile) {
    return { ok: false, reason: 'Invalid DOCX archive: word/document.xml not found.' };
  }

  const xmlStr = await docFile.async('string');
  const parser = new DOMParser();
  const doc = parser.parseFromString(xmlStr, 'application/xml');
  const paragraphs = doc.getElementsByTagNameNS(W_NS, 'p');

  let annotatedCount = 0;

  for (let i = 0; i < paragraphs.length; i++) {
    const p = paragraphs[i];
    const tNodes = p.getElementsByTagNameNS(W_NS, 't');
    let pText = '';
    for (let j = 0; j < tNodes.length; j++) pText += tNodes[j].textContent || '';
    const lowerP = pText.toLowerCase();
    if (!lowerP.trim()) continue;

    const match = findings.find((f) => {
      const needle = String(f.original_text || '').trim().toLowerCase().slice(0, 60);
      return needle.length >= 6 && lowerP.includes(needle);
    });
    if (!match) continue;

    const hlVal = DOCX_HIGHLIGHT_VAL[match.highlight_color] || 'yellow';
    const runs = p.getElementsByTagNameNS(W_NS, 'r');
    for (let rIdx = 0; rIdx < runs.length; rIdx++) {
      const r = runs[rIdx];
      let rPr = r.getElementsByTagNameNS(W_NS, 'rPr')[0];
      if (!rPr) {
        rPr = doc.createElementNS(W_NS, 'w:rPr');
        r.insertBefore(rPr, r.firstChild);
      }
      if (!rPr.getElementsByTagNameNS(W_NS, 'highlight').length) {
        const hl = doc.createElementNS(W_NS, 'w:highlight');
        hl.setAttribute('w:val', hlVal);
        rPr.appendChild(hl);
      }
    }
    annotatedCount += 1;
  }

  const serializer = new XMLSerializer();
  zip.file('word/document.xml', serializer.serializeToString(doc));
  const outBuf = await zip.generateAsync({ type: 'nodebuffer', compression: 'DEFLATE' });

  return {
    ok: true,
    format: 'docx',
    mime: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    annotated_count: annotatedCount,
    buffer: outBuf,
  };
}

export async function annotateOriginalPdf(originalBuffer, findings = []) {
  const inspection = await inspectPdf(originalBuffer);
  if (inspection.is_scanned && !inspection.regions.length) {
    return {
      ok: false,
      reason: 'PDF hasil pindai tidak memiliki koordinat teks native untuk anotasi highlight; gunakan Laporan Analisis PDF terpisah.',
    };
  }

  const pdfDoc = await PDFDocument.load(new Uint8Array(originalBuffer), { ignoreEncryption: true });
  const pages = pdfDoc.getPages();
  let annotatedCount = 0;

  for (const f of findings) {
    const needle = String(f.original_text || '').trim().toLowerCase().slice(0, 60);
    if (needle.length < 5) continue;

    const region = inspection.regions.find((r) => r.text.toLowerCase().includes(needle)) ||
      inspection.paragraphs.find((p) => p.text.toLowerCase().includes(needle));
    if (!region) continue;

    const pdfPage = pages[region.page - 1];
    if (!pdfPage) continue;

    const color = PDF_HIGHLIGHT_RGB[f.highlight_color] || PDF_HIGHLIGHT_RGB.yellow;
    // Non-destructive translucent highlight overlay — preserves original text selectability, images, and layout!
    pdfPage.drawRectangle({
      x: Math.max(0, region.bbox.x - 1),
      y: Math.max(0, region.bbox.y - 2),
      width: region.bbox.width + 2,
      height: region.bbox.height + 4,
      color,
      opacity: 0.24,
    });
    annotatedCount += 1;
  }

  const outBuf = Buffer.from(await pdfDoc.save({ useObjectStreams: false }));
  return {
    ok: true,
    format: 'pdf',
    mime: 'application/pdf',
    annotated_count: annotatedCount,
    buffer: outBuf,
  };
}
