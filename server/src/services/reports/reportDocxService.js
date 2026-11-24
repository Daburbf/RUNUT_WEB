// Professional DOCX Analysis Report Generator.
// Generates a clean, color-coded Word (.docx) analysis report with zero RUNUT
// watermarks, promotional logos, or RUNUT creator metadata.
import { Document, Packer, Paragraph, TextRun, HeadingLevel, ShadingType } from 'docx';

const DOCX_HIGHLIGHT_MAP = {
  blue: { shading: 'DBEAFE', color: '1D4ED8' },
  red: { shading: 'FEE2E2', color: 'B91C1C' },
  orange: { shading: 'FFEDD5', color: 'C2410C' },
  yellow: { shading: 'FEF9C3', color: 'A16207' },
  green: { shading: 'DCFCE7', color: '15803D' },
  gray: { shading: 'F3F4F6', color: '4B5563' },
};

export async function generateAnalysisReportDocx(report) {
  const children = [];

  const h1 = (text) => new Paragraph({ text, heading: HeadingLevel.HEADING_1, spacing: { before: 240, after: 120 } });
  const h2 = (text) => new Paragraph({ text, heading: HeadingLevel.HEADING_2, spacing: { before: 200, after: 80 } });
  const kv = (label, value) => new Paragraph({
    spacing: { after: 60 },
    children: [
      new TextRun({ text: `${label}: `, bold: true, size: 20 }),
      new TextRun({ text: String(value ?? '-'), size: 20 }),
    ],
  });

  // 1. Cover & Document Info
  children.push(h1('Document Analysis Report'));
  children.push(new Paragraph({ children: [new TextRun({ text: report.document_info.title, bold: true, size: 28 })], spacing: { after: 160 } }));
  children.push(kv('Filename', report.document_info.filename));
  children.push(kv('Document Type', report.document_info.document_type));
  children.push(kv('Language', report.document_info.document_language));
  children.push(kv('Pages Analyzed', report.document_info.page_count));
  children.push(kv('Words Analyzed', report.document_info.word_count));
  children.push(kv('Paragraphs Analyzed', report.document_info.paragraph_count));
  children.push(kv('Analysis Date', report.document_info.analysis_date));

  // 2. Color Legend
  children.push(h2('Highlight Color Legend'));
  for (const item of report.highlight_legend) {
    const style = DOCX_HIGHLIGHT_MAP[item.color] || DOCX_HIGHLIGHT_MAP.gray;
    children.push(new Paragraph({
      spacing: { after: 60 },
      shading: { type: ShadingType.CLEAR, fill: style.shading },
      children: [
        new TextRun({ text: `[${item.color.toUpperCase()}] ${item.label}: `, bold: true, color: style.color, size: 19 }),
        new TextRun({ text: item.description, size: 19 }),
      ],
    }));
  }

  // 3. Analysis Overview & Similarity Summary
  children.push(h2('Analysis Overview'));
  children.push(kv('AI-Style Writing Indicators', report.analysis_overview.ai_style_indicators_count));
  children.push(kv('Text Similarity Findings', report.analysis_overview.text_similarity_findings_count));
  children.push(kv('Citation Integrity Findings', report.analysis_overview.citation_integrity_findings_count));
  children.push(kv('Bibliography Entries', report.analysis_overview.bibliography_entries_count));
  children.push(kv('Writing Quality Issues', report.analysis_overview.writing_quality_issues_count));

  children.push(h2('Similarity Summary'));
  children.push(kv('Textual Similarity', report.similarity_overview.measurable ? `${report.similarity_overview.overall_similarity_percent}%` : 'Not calculated (no external corpus)'));
  children.push(kv('Matching Passages', report.similarity_overview.matching_passages));
  children.push(kv('Sources Compared', report.similarity_overview.sources_compared));
  children.push(kv('Method', report.similarity_overview.calculation_method));
  children.push(kv('Scope', report.similarity_overview.scope_note));

  // 4. AI-Style Writing Indicators
  children.push(h2('AI-Style Writing Indicators'));
  children.push(kv('Flagged Passages', report.ai_indicator_overview.flagged_passages));
  children.push(kv('Flagged Words', report.ai_indicator_overview.flagged_words));
  children.push(kv('Share of Analyzed Text', `${report.ai_indicator_overview.flagged_text_percent}%`));
  children.push(new Paragraph({
    spacing: { after: 100 },
    children: [new TextRun({ text: `Notice: ${report.ai_indicator_overview.disclaimer}`, italics: true, color: '1D4ED8', size: 19 })],
  }));

  // 5. Detailed Highlighted Passages
  children.push(h2(`Detailed Highlighted Passages (${report.findings.length})`));
  for (const f of report.findings) {
    const style = DOCX_HIGHLIGHT_MAP[f.highlight_color] || DOCX_HIGHLIGHT_MAP.gray;
    children.push(new Paragraph({
      spacing: { before: 120, after: 40 },
      children: [
        new TextRun({
          text: `${f.finding_id} | ${f.category} | ${f.highlight_color.toUpperCase()} | Page ${f.page} (${f.paragraph_id})`,
          bold: true,
          color: style.color,
          size: 19,
        }),
      ],
    }));
    children.push(new Paragraph({
      spacing: { after: 60 },
      shading: { type: ShadingType.CLEAR, fill: style.shading },
      children: [new TextRun({ text: f.original_text || '-', size: 20 })],
    }));
    children.push(kv('Reason', f.reason));
    if (f.matched_text) children.push(kv('Matched Source Text', f.matched_text));
    if (f.source?.title) children.push(kv('Source', `${f.source.title}${f.source.url ? ` (${f.source.url})` : ''}`));
    if (f.recommendation) children.push(kv('Recommendation', f.recommendation));
  }

  // 6. Citation & Bibliography Review
  children.push(h2('Citation Validation & Bibliography Review'));
  children.push(kv('Detected Style', report.citation_and_bibliography.detected_style));
  children.push(kv('Missing References', report.citation_and_bibliography.missing_references.length));
  children.push(kv('Unused References', report.citation_and_bibliography.unused_references.length));
  children.push(kv('Duplicate References', report.citation_and_bibliography.duplicate_references.length));
  children.push(kv('Metadata Mismatches', report.citation_and_bibliography.metadata_mismatches.length));

  // 7. Methodology & Limitations
  children.push(h2('Methodology & Verification Limitations'));
  for (const m of report.methodology) {
    children.push(new Paragraph({ children: [new TextRun({ text: `- ${m}`, size: 19 })], spacing: { after: 40 } }));
  }
  for (const l of report.limitations) {
    children.push(new Paragraph({ children: [new TextRun({ text: `- ${l}`, size: 19, italics: true })], spacing: { after: 40 } }));
  }

  const doc = new Document({
    title: `Document Analysis Report - ${report.document_info.title}`,
    sections: [{ children }],
  });

  return Packer.toBuffer(doc);
}
