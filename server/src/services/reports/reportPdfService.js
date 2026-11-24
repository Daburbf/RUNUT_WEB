// Professional Multi-Page PDF Analysis Report Generator.
// Generates a clean 12-section academic analysis report with color-coded highlights
// (Blue, Red, Orange, Yellow, Green, Gray), clickable source URLs, and clean numeric
// pagination. Contains ZERO RUNUT watermarks, logos, promotional footers, or creator branding.
import { PDFDocument, StandardFonts, rgb, PDFName, PDFString } from 'pdf-lib';

const PAGE_W = 595.28;
const PAGE_H = 841.89;
const MARGIN = 48;
const CONTENT_W = PAGE_W - MARGIN * 2;
const BOTTOM = 54;

const COLOR_MAP = {
  blue: { accent: rgb(0.145, 0.388, 0.922), bg: rgb(0.859, 0.918, 0.996) },
  red: { accent: rgb(0.863, 0.149, 0.149), bg: rgb(0.996, 0.886, 0.886) },
  orange: { accent: rgb(0.918, 0.345, 0.047), bg: rgb(1.0, 0.929, 0.835) },
  yellow: { accent: rgb(0.792, 0.541, 0.016), bg: rgb(0.996, 0.976, 0.765) },
  green: { accent: rgb(0.086, 0.639, 0.290), bg: rgb(0.863, 0.988, 0.906) },
  gray: { accent: rgb(0.420, 0.447, 0.502), bg: rgb(0.953, 0.957, 0.965) },
};

const clean = (s) => String(s ?? '')
  .replace(/[\u2018\u2019]/g, "'")
  .replace(/[\u201c\u201d]/g, '"')
  .replace(/[\u2013\u2014]/g, '-')
  .replace(/\u2026/g, '...')
  .replace(/[^\x09\x0A\x20-\xFF]/g, '?');

function wrapLines(text, font, size, maxWidth) {
  const out = [];
  for (const raw of clean(text).split('\n')) {
    const words = raw.split(/\s+/).filter(Boolean);
    if (!words.length) { out.push(''); continue; }
    let line = '';
    for (let w of words) {
      while (font.widthOfTextAtSize(w, size) > maxWidth) {
        if (line) { out.push(line); line = ''; }
        let cut = w.length;
        while (cut > 1 && font.widthOfTextAtSize(w.slice(0, cut), size) > maxWidth) cut -= 1;
        out.push(w.slice(0, cut));
        w = w.slice(cut);
      }
      if (!line) line = w;
      else if (font.widthOfTextAtSize(`${line} ${w}`, size) <= maxWidth) line += ` ${w}`;
      else { out.push(line); line = w; }
    }
    if (line) out.push(line);
  }
  return out;
}

function addLinkAnnotation(pdfDoc, page, rect, url) {
  try {
    const linkAnnot = pdfDoc.context.obj({
      Type: 'Annot',
      Subtype: 'Link',
      Rect: rect,
      Border: [0, 0, 0],
      A: {
        Type: 'Action',
        S: 'URI',
        URI: PDFString.of(url),
      },
    });
    const ref = pdfDoc.context.register(linkAnnot);
    const existing = page.node.lookup(PDFName.of('Annots'));
    if (existing && typeof existing.push === 'function') {
      existing.push(ref);
    } else {
      page.node.set(PDFName.of('Annots'), pdfDoc.context.obj([ref]));
    }
  } catch {
    // Ignore annotation errors on unusual URLs
  }
}

export async function generateAnalysisReportPdf(report) {
  const doc = await PDFDocument.create();
  doc.setTitle(clean(`Document Analysis Report - ${report.document_info.title}`));

  const regular = await doc.embedFont(StandardFonts.Helvetica);
  const bold = await doc.embedFont(StandardFonts.HelveticaBold);

  const pages = [];
  let page = doc.addPage([PAGE_W, PAGE_H]);
  pages.push(page);
  let y = PAGE_H - MARGIN;

  const ensureSpace = (needed) => {
    if (y - needed < BOTTOM) {
      page = doc.addPage([PAGE_W, PAGE_H]);
      pages.push(page);
      y = PAGE_H - MARGIN;
    }
  };

  const drawHeading = (title) => {
    ensureSpace(34);
    y -= 10;
    page.drawRectangle({ x: MARGIN, y: y - 4, width: CONTENT_W, height: 1.5, color: rgb(0.1, 0.1, 0.1) });
    page.drawText(clean(title), { x: MARGIN, y: y + 4, size: 12, font: bold, color: rgb(0.08, 0.08, 0.08) });
    y -= 18;
  };

  const drawParagraph = (text, { size = 9.5, font = regular, color = rgb(0.15, 0.15, 0.15), indent = 0, lead = 14 } = {}) => {
    const lines = wrapLines(text, font, size, CONTENT_W - indent);
    for (const line of lines) {
      ensureSpace(lead + 4);
      if (line) {
        page.drawText(line, { x: MARGIN + indent, y, size, font, color });
      }
      y -= lead;
    }
  };

  const drawKeyValueRows = (rows) => {
    for (const [k, v] of rows) {
      ensureSpace(16);
      page.drawText(clean(`${k}:`), { x: MARGIN, y, size: 9.5, font: bold, color: rgb(0.15, 0.15, 0.15) });
      const valLines = wrapLines(String(v ?? '-'), regular, 9.5, CONTENT_W - 155);
      for (let i = 0; i < valLines.length; i++) {
        if (i > 0) ensureSpace(14);
        page.drawText(valLines[i], { x: MARGIN + 155, y, size: 9.5, font: regular, color: rgb(0.2, 0.2, 0.2) });
        if (i < valLines.length - 1) y -= 13;
      }
      y -= 15;
    }
  };

  // ---- 1. COVER PAGE ----
  y = PAGE_H - 130;
  page.drawRectangle({ x: MARGIN, y: y + 36, width: 48, height: 4, color: rgb(0.145, 0.388, 0.922) });
  page.drawText('DOCUMENT ANALYSIS REPORT', { x: MARGIN, y, size: 22, font: bold, color: rgb(0.07, 0.07, 0.07) });
  y -= 28;
  drawParagraph(report.document_info.title, { size: 14, font: bold, color: rgb(0.2, 0.2, 0.2), lead: 20 });
  y -= 16;
  drawKeyValueRows([
    ['Filename', report.document_info.filename],
    ['Document Type', report.document_info.document_type],
    ['Language', report.document_info.document_language],
    ['Pages Analyzed', report.document_info.page_count],
    ['Words Analyzed', report.document_info.word_count],
    ['Paragraphs Analyzed', report.document_info.paragraph_count],
    ['Analysis Date', String(report.document_info.analysis_date).slice(0, 19).replace('T', ' ')],
    ['Analysis Status', report.document_info.analysis_status],
  ]);

  // Color Legend on Cover Page
  y -= 14;
  drawHeading('Highlight Color Legend');
  for (const item of report.highlight_legend) {
    const palette = COLOR_MAP[item.color] || COLOR_MAP.gray;
    ensureSpace(26);
    page.drawRectangle({ x: MARGIN, y: y - 4, width: 12, height: 12, color: palette.accent });
    page.drawText(clean(item.label), { x: MARGIN + 18, y: y - 1, size: 9.5, font: bold, color: rgb(0.1, 0.1, 0.1) });
    y -= 13;
    drawParagraph(item.description, { size: 8.5, indent: 18, color: rgb(0.3, 0.3, 0.3), lead: 12 });
    y -= 4;
  }

  // Start Page 2 for detailed sections
  page = doc.addPage([PAGE_W, PAGE_H]);
  pages.push(page);
  y = PAGE_H - MARGIN;

  // ---- 2. ANALYSIS OVERVIEW ----
  drawHeading('1. Analysis Overview');
  drawKeyValueRows([
    ['AI-Style Writing Indicators', report.analysis_overview.ai_style_indicators_count],
    ['Text Similarity Findings', report.analysis_overview.text_similarity_findings_count],
    ['Citation Integrity Findings', report.analysis_overview.citation_integrity_findings_count],
    ['Bibliography Entries', report.analysis_overview.bibliography_entries_count],
    ['Repeated Passages', report.analysis_overview.repeated_passages_count],
    ['Writing Quality Issues', report.analysis_overview.writing_quality_issues_count],
  ]);

  // ---- 3. SIMILARITY SUMMARY ----
  drawHeading('2. Similarity Summary');
  drawKeyValueRows([
    ['Textual Similarity (%)', report.similarity_overview.measurable ? `${report.similarity_overview.overall_similarity_percent}%` : 'Not calculated (no external corpus)'],
    ['Matching Passages', report.similarity_overview.matching_passages],
    ['Exact Matches', report.similarity_overview.exact_matches],
    ['Close Textual Matches', report.similarity_overview.close_textual_matches],
    ['Potential Patchwriting', report.similarity_overview.potential_patchwriting],
    ['Properly Cited Matches', report.similarity_overview.properly_cited_matches],
    ['Sources Compared', report.similarity_overview.sources_compared],
    ['Full-Text Accessible Sources', report.similarity_overview.full_text_accessible_sources],
    ['Metadata-Only Sources', report.similarity_overview.metadata_only_sources],
    ['User-Provided References', report.similarity_overview.user_provided_references],
  ]);
  drawParagraph(`Method: ${report.similarity_overview.calculation_method}`, { size: 8.5, color: rgb(0.3, 0.3, 0.3), lead: 12 });
  drawParagraph(`Scope: ${report.similarity_overview.scope_note}`, { size: 8.5, color: rgb(0.3, 0.3, 0.3), lead: 12 });

  // ---- 4. AI-STYLE WRITING INDICATORS ----
  drawHeading('3. AI-Style Writing Indicator Overview');
  drawKeyValueRows([
    ['Flagged Passages', report.ai_indicator_overview.flagged_passages],
    ['Flagged Words', report.ai_indicator_overview.flagged_words],
    ['Share of Analyzed Text', `${report.ai_indicator_overview.flagged_text_percent}%`],
    ['Indicator Categories', report.ai_indicator_overview.categories.join(', ') || 'None'],
    ['Observed Severity', report.ai_indicator_overview.severity],
  ]);
  drawParagraph(`Important Notice: ${report.ai_indicator_overview.disclaimer}`, { size: 8.5, font: bold, color: rgb(0.145, 0.388, 0.922), lead: 12 });

  // ---- 5. HIGHLIGHTED PASSAGE DETAILS ----
  drawHeading(`4. Detailed Highlighted Passages (${report.findings.length})`);
  if (!report.findings.length) {
    drawParagraph('No flagged passages were identified in this analysis.', { size: 9.5 });
  }
  for (const f of report.findings) {
    const palette = COLOR_MAP[f.highlight_color] || COLOR_MAP.gray;
    const origLines = wrapLines(f.original_text || '', regular, 9, CONTENT_W - 20);
    const boxH = Math.max(20, origLines.length * 12 + 10);
    ensureSpace(boxH + 62);

    // Header line with Finding ID, Category, Page, Paragraph
    page.drawRectangle({ x: MARGIN, y: y - 3, width: 8, height: 10, color: palette.accent });
    page.drawText(
      clean(`${f.finding_id} | ${f.category} | Color: ${f.highlight_color.toUpperCase()} | Page ${f.page} (${f.paragraph_id}) | Severity: ${f.severity}`),
      { x: MARGIN + 12, y: y - 1, size: 8.5, font: bold, color: palette.accent },
    );
    y -= 15;

    // Color-shaded passage box
    page.drawRectangle({ x: MARGIN + 4, y: y - boxH + 10, width: CONTENT_W - 4, height: boxH, color: palette.bg });
    page.drawRectangle({ x: MARGIN + 4, y: y - boxH + 10, width: 3, height: boxH, color: palette.accent });
    let ty = y;
    for (const line of origLines) {
      page.drawText(line, { x: MARGIN + 12, y: ty, size: 9, font: regular, color: rgb(0.08, 0.08, 0.08) });
      ty -= 12;
    }
    y = y - boxH + 2;

    drawParagraph(`Reason: ${f.reason}`, { size: 8.5, indent: 8, lead: 12 });
    if (f.matched_text) {
      drawParagraph(`Matched Source Text: ${String(f.matched_text).slice(0, 280)}`, { size: 8.5, indent: 8, color: rgb(0.3, 0.3, 0.3), lead: 12 });
    }
    if (f.source?.title) {
      drawParagraph(`Source: ${f.source.title} (${f.source.access_status || 'unknown'})`, { size: 8.5, indent: 8, font: bold, lead: 12 });
    }
    if (f.source?.url) {
      ensureSpace(14);
      const urlText = clean(`URL: ${f.source.url}`);
      page.drawText(urlText.slice(0, 95), { x: MARGIN + 8, y, size: 8.5, font: regular, color: rgb(0.145, 0.388, 0.922) });
      addLinkAnnotation(doc, page, [MARGIN + 8, y - 2, MARGIN + CONTENT_W - 8, y + 10], f.source.url);
      y -= 13;
    }
    if (f.recommendation) {
      drawParagraph(`Recommendation: ${f.recommendation}`, { size: 8.5, indent: 8, color: rgb(0.2, 0.2, 0.2), lead: 12 });
    }
    y -= 6;
  }

  // ---- 6. SOURCE COMPARISON ----
  drawHeading(`5. Comparison Sources (${report.sources_compared.length})`);
  if (!report.sources_compared.length) {
    drawParagraph('No external sources matched document passages.', { size: 9 });
  } else {
    for (const s of report.sources_compared) {
      drawParagraph(`- ${s.title}${s.author ? ` | ${s.author}` : ''}${s.year ? ` (${s.year})` : ''} | Status: ${s.access_status || 'unknown'} | Matches: ${s.match_count}`, { size: 8.5, font: bold, lead: 13 });
      if (s.url) {
        ensureSpace(14);
        page.drawText(clean(`  ${s.url}`).slice(0, 95), { x: MARGIN + 8, y, size: 8, font: regular, color: rgb(0.145, 0.388, 0.922) });
        addLinkAnnotation(doc, page, [MARGIN + 8, y - 2, MARGIN + CONTENT_W - 8, y + 10], s.url);
        y -= 12;
      }
    }
  }

  // ---- 7. CITATION & BIBLIOGRAPHY REVIEW ----
  drawHeading('6. Citation Validation & Bibliography Review');
  drawKeyValueRows([
    ['Detected Citation Style', report.citation_and_bibliography.detected_style],
    ['In-Text Citations', report.citation_and_bibliography.in_text_count],
    ['Bibliography Entries', report.citation_and_bibliography.bibliography_count],
    ['Missing References', report.citation_and_bibliography.missing_references.length],
    ['Unused Bibliography Entries', report.citation_and_bibliography.unused_references.length],
    ['Duplicate References', report.citation_and_bibliography.duplicate_references.length],
    ['Metadata Mismatches', report.citation_and_bibliography.metadata_mismatches.length],
  ]);

  // ---- 8. WRITING QUALITY RECOMMENDATIONS ----
  drawHeading('7. Writing Quality Recommendations');
  drawKeyValueRows([
    ['Total Writing Findings', report.writing_quality_summary.total_issues],
    ['Applied / Rejected / Pending', `${report.writing_quality_summary.applied_count} / ${report.writing_quality_summary.rejected_count} / ${report.writing_quality_summary.pending_count}`],
  ]);

  // ---- 9. METHODOLOGY & LIMITATIONS ----
  drawHeading('8. Analysis Methodology & Verification Limitations');
  for (const m of report.methodology) drawParagraph(`- ${m}`, { size: 8.5, lead: 12 });
  y -= 4;
  for (const l of report.limitations) drawParagraph(`- ${l}`, { size: 8.5, color: rgb(0.3, 0.3, 0.3), lead: 12 });

  // Clean numeric page numbers ONLY (NO RUNUT watermark or promotional footer!)
  const totalPages = pages.length;
  for (let i = 0; i < totalPages; i++) {
    pages[i].drawText(`${i + 1} / ${totalPages}`, {
      x: PAGE_W / 2 - 14,
      y: 26,
      size: 8,
      font: regular,
      color: rgb(0.45, 0.45, 0.45),
    });
  }

  return Buffer.from(await doc.save({ useObjectStreams: false }));
}
