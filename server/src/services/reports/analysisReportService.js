// Unified Analysis Report Service.
// Builds a structured, verifiable Turnitin-style analysis report directly from
// stored RUNUT analysis results without making additional AI calls or fabricating scores.
import { detectSlopPatterns } from '../prompts/antiAiSlop.js';

export const HIGHLIGHT_LEGEND = [
  {
    color: 'blue',
    hex: '#2563EB',
    bgHex: '#DBEAFE',
    label: 'AI-Style Pattern Indicators',
    description: 'Formulaic, repetitive, or generic writing patterns. Writing-pattern indicators only — not proof of AI authorship.',
  },
  {
    color: 'red',
    hex: '#DC2626',
    bgHex: '#FEE2E2',
    label: 'Exact or Strong Unattributed Matches',
    description: 'Passages closely or exactly matching an accessible source without clear citation attribution.',
  },
  {
    color: 'orange',
    hex: '#EA580C',
    bgHex: '#FFEDD5',
    label: 'Citation & Reference Issues',
    description: 'Missing bibliography entries, inconsistent author-year metadata, invalid/unverified DOIs, or style mismatches.',
  },
  {
    color: 'yellow',
    hex: '#CA8A04',
    bgHex: '#FEF9C3',
    label: 'General Similarity & Repeated Text',
    description: 'General textual overlap, close paraphrases, or repeated sentences/paragraphs.',
  },
  {
    color: 'green',
    hex: '#16A34A',
    bgHex: '#DCFCE7',
    label: 'Properly Cited Matches',
    description: 'Source-derived quotations or passages with appropriate attribution.',
  },
  {
    color: 'gray',
    hex: '#6B7280',
    bgHex: '#F3F4F6',
    label: 'Common Expressions & Excluded Content',
    description: 'Standard academic terminology, headings, or bibliography entries excluded from similarity overlap.',
  },
];

const AI_INDICATOR_CATEGORIES = new Set([
  'formality',
  'transition',
  'uniform_structure',
  'sentence_pattern',
  'repetition',
]);

function splitParagraphs(text) {
  const parts = [];
  let pos = 0;
  let idx = 0;
  for (const raw of String(text || '').split(/\n+/)) {
    const at = text.indexOf(raw, pos);
    const trimmed = raw.trim();
    if (trimmed) {
      idx += 1;
      parts.push({
        paragraph_id: `paragraph_${String(idx).padStart(3, '0')}`,
        start: at,
        end: at + raw.length,
        text: trimmed,
        page: Math.max(1, Math.ceil((at + 1) / 2200)),
      });
    }
    pos = at + raw.length;
  }
  return parts;
}

function locateParagraph(paragraphs, needle, charPos = -1) {
  if (charPos >= 0) {
    const byPos = paragraphs.find((p) => charPos >= p.start && charPos <= p.end);
    if (byPos) return byPos;
  }
  const clean = String(needle || '').trim().toLowerCase();
  if (clean) {
    const byText = paragraphs.find((p) => p.text.toLowerCase().includes(clean.slice(0, 60)));
    if (byText) return byText;
  }
  return paragraphs[0] || { paragraph_id: 'paragraph_001', page: 1 };
}

function countWords(text) {
  return (String(text || '').match(/[\p{L}\p{N}]+/gu) || []).length;
}

export function buildAnalysisReport({ document, analysis, issues = [] }) {
  const originalText = String(document?.original_text || '');
  const stats = analysis?.stats || {};
  const docMeta = stats.document_metadata || {};
  const simReport = stats.similarity_report || null;
  const citeReport = stats.citation_report || null;
  const ocrReport = stats.ocr_report || null;
  const language = stats.document_language || 'id';
  const paragraphs = splitParagraphs(originalText);

  const findings = [];
  let seq = 0;
  const nextId = () => `F-${String(++seq).padStart(3, '0')}`;

  // 1. Blue: AI-Style Pattern Indicators (from verified writing issues + deterministic slop detector)
  const seenAiKeys = new Set();
  for (const issue of issues) {
    if (!AI_INDICATOR_CATEGORIES.has(issue.category)) continue;
    const para = locateParagraph(paragraphs, issue.snippet, issue.start_pos);
    const key = `${para.paragraph_id}:${String(issue.snippet || '').slice(0, 40).toLowerCase()}`;
    if (seenAiKeys.has(key)) continue;
    seenAiKeys.add(key);

    findings.push({
      finding_id: nextId(),
      category: 'AI_STYLE_INDICATOR',
      indicator_type: issue.category,
      severity: issue.needs_manual_review ? 'high' : 'medium',
      page: para.page,
      paragraph_id: para.paragraph_id,
      original_text: issue.snippet || '',
      matched_text: null,
      highlight_color: 'blue',
      reason: issue.explanation || 'Formulaic or repetitive writing pattern detected.',
      recommendation: issue.suggestion || 'Revise for clearer, more natural expression.',
      source: null,
      citation_status: null,
      confidence: 'medium',
      note: 'Writing-pattern indicator only — not proof of AI authorship.',
    });
  }

  const slopHits = detectSlopPatterns(originalText, language);
  for (const hit of slopHits) {
    if (!hit.positions?.length) continue;
    const pos = hit.positions[0];
    const para = locateParagraph(paragraphs, hit.phrase, pos);
    const key = `${para.paragraph_id}:${hit.phrase.slice(0, 40).toLowerCase()}`;
    if (seenAiKeys.has(key)) continue;
    seenAiKeys.add(key);

    findings.push({
      finding_id: nextId(),
      category: 'AI_STYLE_INDICATOR',
      indicator_type: 'generic_expression',
      severity: hit.count >= 2 ? 'high' : 'medium',
      page: para.page,
      paragraph_id: para.paragraph_id,
      original_text: hit.phrase,
      matched_text: null,
      highlight_color: 'blue',
      reason: `Generic formulaic expression "${hit.phrase}" appears ${hit.count}x.`,
      recommendation: 'Start directly with the specific subject or concrete evidence.',
      source: null,
      citation_status: null,
      confidence: 'medium',
      note: 'Writing-pattern indicator only — not proof of AI authorship.',
    });
  }

  // 2. Red / Yellow / Green / Gray: Similarity Findings
  for (const sim of (simReport?.findings || [])) {
    const para = locateParagraph(paragraphs, sim.original_passage);
    let highlightColor = 'yellow';
    let category = 'TEXT_SIMILARITY';
    let severity = 'medium';

    if (sim.category === 'direct_quotation' && sim.citation_status === 'properly_cited') {
      highlightColor = 'green';
      category = 'PROPERLY_CITED_MATCH';
      severity = 'low';
    } else if (sim.category === 'properly_cited') {
      highlightColor = 'green';
      category = 'PROPERLY_CITED_MATCH';
      severity = 'low';
    } else if (sim.category === 'unattributed_overlap' || sim.classification === 'Exact Match') {
      highlightColor = 'red';
      category = 'TEXT_SIMILARITY';
      severity = 'high';
    } else if (sim.category === 'common_academic_expression') {
      highlightColor = 'gray';
      category = 'EXCLUDED_CONTENT';
      severity = 'low';
    } else {
      highlightColor = 'yellow';
      category = 'TEXT_SIMILARITY';
      severity = 'medium';
    }

    findings.push({
      finding_id: nextId(),
      category,
      classification: sim.classification || sim.category,
      severity,
      page: para.page,
      paragraph_id: para.paragraph_id,
      original_text: sim.original_passage || '',
      matched_text: sim.matching_passage || sim.matching_phrase || null,
      similarity_method: sim.similarity_method || 'exact_phrase_matching',
      similarity_dimension: sim.similarity_dimension || 'lexical',
      highlight_color: highlightColor,
      reason: sim.explanation || 'Textual overlap detected against comparison corpus.',
      recommendation: sim.recommended_correction || sim.suggested_correction || 'Review source attribution and paraphrase naturally.',
      source: sim.source_title || sim.source_url || sim.source_doi
        ? {
            title: sim.source_title || sim.source_info || 'Comparison Source',
            author: sim.source_author || null,
            year: sim.source_year || null,
            url: sim.source_url || null,
            doi: sim.source_doi || null,
            access_status: sim.source_accessibility_status || 'unknown',
          }
        : null,
      citation_status: sim.citation_status || 'citation_not_detected',
    });
  }

  // 3. Orange: Citation & Bibliography Issues
  for (const miss of (citeReport?.missing_references || [])) {
    const para = locateParagraph(paragraphs, miss.citation, miss.position ?? -1);
    findings.push({
      finding_id: nextId(),
      category: 'CITATION_ISSUE',
      severity: 'high',
      page: para.page,
      paragraph_id: para.paragraph_id,
      original_text: miss.citation,
      matched_text: null,
      highlight_color: 'orange',
      reason: miss.reason || 'In-text citation has no matching bibliography entry.',
      recommendation: 'Add the complete reference entry to the bibliography or verify author spelling and year.',
      source: null,
      citation_status: 'missing_bibliography_entry',
    });
  }

  for (const mismatch of (citeReport?.metadata_mismatches || [])) {
    const textRef = mismatch.citation || mismatch.doi || mismatch.entry_value || '';
    const para = locateParagraph(paragraphs, textRef);
    findings.push({
      finding_id: nextId(),
      category: 'CITATION_ISSUE',
      severity: 'high',
      page: para.page,
      paragraph_id: para.paragraph_id,
      original_text: textRef,
      matched_text: mismatch.source_value || null,
      highlight_color: 'orange',
      reason: mismatch.message || 'Citation metadata mismatch detected.',
      recommendation: 'Verify publication year, author name, and title against the official source record.',
      source: mismatch.doi ? { title: mismatch.doi, doi: mismatch.doi, url: `https://doi.org/${mismatch.doi}`, access_status: 'Metadata Mismatch' } : null,
      citation_status: 'metadata_mismatch',
    });
  }

  for (const doiCheck of (citeReport?.doi_checks || [])) {
    if (doiCheck.status === 'invalid_doi') {
      const para = locateParagraph(paragraphs, doiCheck.doi);
      findings.push({
        finding_id: nextId(),
        category: 'CITATION_ISSUE',
        severity: 'high',
        page: para.page,
        paragraph_id: para.paragraph_id,
        original_text: doiCheck.doi,
        matched_text: null,
        highlight_color: 'orange',
        reason: doiCheck.reason || 'DOI could not be resolved in Crossref or OpenAlex.',
        recommendation: 'Verify the DOI string against the publisher page.',
        source: { title: doiCheck.doi, doi: doiCheck.doi, url: null, access_status: 'Source Unavailable' },
        citation_status: 'invalid_doi',
      });
    }
  }

  // 4. Gray: Excluded Bibliography Section marker (if detected)
  if (citeReport?.bibliography_found && citeReport.bibliography_start >= 0) {
    const bibPara = locateParagraph(paragraphs, 'Daftar Pustaka', citeReport.bibliography_start);
    findings.push({
      finding_id: nextId(),
      category: 'EXCLUDED_CONTENT',
      severity: 'low',
      page: bibPara.page,
      paragraph_id: bibPara.paragraph_id,
      original_text: bibPara.text.slice(0, 140),
      matched_text: null,
      highlight_color: 'gray',
      reason: 'Bibliography section is protected and excluded from similarity calculations.',
      recommendation: 'No rewrite required; bibliography layout is preserved.',
      source: null,
      citation_status: 'bibliography_protected',
    });
  }

  // Compute AI-style writing indicator overview from real flagged passages (NO fabricated probability!)
  const aiFindings = findings.filter((f) => f.category === 'AI_STYLE_INDICATOR');
  const totalWords = stats.word_count || document?.word_count || countWords(originalText);
  const flaggedAiWords = aiFindings.reduce((acc, f) => acc + countWords(f.original_text), 0);
  const flaggedAiPercent = totalWords > 0 ? Math.min(100, Math.round((flaggedAiWords / totalWords) * 1000) / 10) : 0;

  const simFindings = findings.filter((f) => f.category === 'TEXT_SIMILARITY' || f.category === 'PROPERLY_CITED_MATCH');
  const citeFindings = findings.filter((f) => f.category === 'CITATION_ISSUE');

  // Collect distinct sources compared
  const sourcesMap = new Map();
  for (const f of simFindings) {
    if (!f.source) continue;
    const key = f.source.doi || f.source.url || f.source.title;
    if (!sourcesMap.has(key)) {
      sourcesMap.set(key, { ...f.source, match_count: 1 });
    } else {
      sourcesMap.get(key).match_count += 1;
    }
  }

  return {
    report_type: 'document_analysis_report',
    generated_at: new Date().toISOString(),
    document_info: {
      document_id: document?.id || null,
      title: document?.title || 'Untitled Document',
      filename: document?.file_name || `${document?.title || 'document'}.txt`,
      document_type: stats.document_type || 'general_writing',
      document_language: language,
      page_count: docMeta.page_count || Math.max(1, paragraphs[paragraphs.length - 1]?.page || 1),
      word_count: totalWords,
      paragraph_count: paragraphs.length || stats.paragraph_count || 0,
      analysis_date: analysis?.created_at || document?.updated_at || new Date().toISOString(),
      analysis_status: analysis?.ai_status || 'ok',
      original_format: docMeta.format || 'text',
    },
    highlight_legend: HIGHLIGHT_LEGEND,
    analysis_overview: {
      ai_style_indicators_count: aiFindings.length,
      text_similarity_findings_count: simFindings.length,
      citation_integrity_findings_count: citeFindings.length,
      bibliography_entries_count: citeReport?.bibliography_count || 0,
      repeated_passages_count: simReport?.summary?.repeated_phrases || 0,
      writing_quality_issues_count: issues.length,
    },
    similarity_overview: {
      measurable: simReport?.corpus_similarity_percent !== null && simReport?.corpus_similarity_percent !== undefined,
      overall_similarity_percent: simReport?.corpus_similarity_percent ?? null,
      corpus_compared: simReport?.corpus_compared || 'internal_only',
      calculation_method: simReport?.calculation_method || 'No external corpus provided; external similarity percentage not calculated.',
      scope_note: simReport?.scope_note || 'Comparison limited to available sources. Not equivalent to Turnitin or iThenticate.',
      matching_passages: simFindings.length,
      exact_matches: findings.filter((f) => f.classification === 'Exact Match').length,
      close_textual_matches: findings.filter((f) => f.classification === 'Close Textual Match').length,
      potential_patchwriting: findings.filter((f) => f.classification === 'Possible Patchwriting' || f.category === 'close_paraphrase').length,
      properly_cited_matches: findings.filter((f) => f.category === 'PROPERLY_CITED_MATCH').length,
      sources_compared: simReport?.corpus_coverage?.sources_checked ?? sourcesMap.size,
      full_text_accessible_sources: simReport?.corpus_coverage?.full_text_accessible_sources ?? 0,
      metadata_only_sources: simReport?.corpus_coverage?.metadata_only_sources ?? 0,
      user_provided_references: simReport?.corpus_coverage?.user_provided_references ?? (simReport?.reference_count || 0),
    },
    ai_indicator_overview: {
      disclaimer: 'These indicators highlight formulaic, repetitive, or generic writing patterns. They are editorial pattern indicators, NOT proof of AI authorship and NOT an AI-authorship probability score.',
      flagged_passages: aiFindings.length,
      flagged_words: flaggedAiWords,
      flagged_text_percent: flaggedAiPercent,
      categories: [...new Set(aiFindings.map((f) => f.indicator_type).filter(Boolean))],
      severity: aiFindings.some((f) => f.severity === 'high') ? 'high' : (aiFindings.length > 0 ? 'medium' : 'none'),
    },
    sources_compared: [...sourcesMap.values()],
    citation_and_bibliography: {
      detected_style: citeReport?.detected_style || 'unknown',
      bibliography_found: Boolean(citeReport?.bibliography_found),
      in_text_count: citeReport?.in_text_count || 0,
      bibliography_count: citeReport?.bibliography_count || 0,
      missing_references: citeReport?.missing_references || [],
      unused_references: citeReport?.unused_references || [],
      duplicate_references: citeReport?.duplicate_references || [],
      incomplete_references: citeReport?.incomplete_references || [],
      metadata_mismatches: citeReport?.metadata_mismatches || [],
      formatting_issues: citeReport?.formatting_issues || [],
      doi_checks: citeReport?.doi_checks || [],
    },
    writing_quality_summary: {
      total_issues: issues.length,
      applied_count: issues.filter((i) => i.decision === 'applied').length,
      rejected_count: issues.filter((i) => i.decision === 'rejected').length,
      pending_count: issues.filter((i) => (i.decision || 'active') === 'active').length,
      recommendations: issues.slice(0, 40).map((i) => ({
        category: i.category,
        snippet: i.snippet,
        explanation: i.explanation,
        suggestion: i.suggestion,
        needs_manual_review: Boolean(i.needs_manual_review),
      })),
    },
    ocr_summary: ocrReport ? {
      ocr_applied: Boolean(ocrReport.ocr_applied),
      language: ocrReport.language,
      average_confidence: ocrReport.average_confidence,
      needs_user_verification: Boolean(ocrReport.needs_user_verification),
      uncertain_segments_count: ocrReport.uncertain_segments?.length || 0,
    } : null,
    findings,
    methodology: [
      'Writing quality and AI-style pattern indicators are evaluated using deterministic stylistic rules (Anti-AI-Slop, Humanize Text, Academic Writer) combined with structured AI review.',
      'Text similarity is evaluated using exact phrase matching, normalized text comparison, N-gram overlap, longest common phrase detection, repeated passage detection, and separate semantic similarity.',
      'Citation and bibliography checks cross-reference in-text markers against bibliography entries and optionally verify DOIs via Crossref, OpenAlex, Unpaywall, Semantic Scholar, DOAJ, and PubMed Central.',
    ],
    limitations: [
      'AI-style writing indicators do not prove whether a human or an AI model authored a passage.',
      'Similarity percentages are computed strictly against accessible comparison sources (user-uploaded references, accessible document URLs, and legal open-access repositories) and do not represent Turnitin, iThenticate, or subscription-only databases.',
      'Paywalled articles without a legal open-access copy are verified at the metadata level only.',
    ],
  };
}
