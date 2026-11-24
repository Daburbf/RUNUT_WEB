// Originality and Multi-Source Text Similarity Engine
// Compares document body against:
//   1. User-uploaded / provided reference documents
//   2. Accessible URLs extracted anywhere in the document (HTML, TXT, PDF)
//   3. Cited academic sources (Crossref, OpenAlex, Unpaywall, Semantic Scholar, DOAJ, PMC)
//   4. Independently discovered public academic sources (not limited to bibliography)
// Separates lexical similarity from semantic similarity, protects bibliography & direct
// quotations, and never fabricates similarity scores or claims Turnitin equivalence.
import { extractDocumentUrls, fetchAndExtractSource } from './sourceFetcher.js';

const WORD_RE = /[\p{L}\p{N}]+(?:['’-][\p{L}\p{N}]+)*/gu;

const COMMON_ACADEMIC_EXPRESSIONS = new Set([
  'penelitian ini bertujuan untuk',
  'berdasarkan hasil penelitian',
  'hasil penelitian menunjukkan bahwa',
  'metode penelitian yang digunakan',
  'dapat disimpulkan bahwa',
  'dalam penelitian ini',
  'this study aims to',
  'based on the results',
  'the results show that',
  'in this study',
  'significant difference between',
  'statistically significant difference between',
  'data were analyzed using',
]);

function normalizeText(str) {
  return String(str || '')
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s]/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function tokenize(str) {
  return (String(str || '').toLowerCase().match(WORD_RE) || []);
}

function buildNgrams(words, n) {
  const grams = [];
  for (let i = 0; i + n <= words.length; i++) {
    grams.push(words.slice(i, i + n).join(' '));
  }
  return grams;
}

function jaccard(setA, setB) {
  if (!setA.size || !setB.size) return 0;
  let intersection = 0;
  for (const item of setA) {
    if (setB.has(item)) intersection += 1;
  }
  const union = setA.size + setB.size - intersection;
  return union ? intersection / union : 0;
}

function containment(targetSet, refSet) {
  if (!targetSet.size || !refSet.size) return 0;
  let hits = 0;
  for (const item of targetSet) {
    if (refSet.has(item)) hits += 1;
  }
  return hits / targetSet.size;
}

function cosineOverlap(wordsA, wordsB) {
  if (!wordsA.length || !wordsB.length) return 0;
  const freqA = new Map();
  const freqB = new Map();
  for (const w of wordsA) freqA.set(w, (freqA.get(w) || 0) + 1);
  for (const w of wordsB) freqB.set(w, (freqB.get(w) || 0) + 1);
  let dot = 0;
  let magA = 0;
  let magB = 0;
  for (const [w, a] of freqA) {
    magA += a * a;
    if (freqB.has(w)) dot += a * freqB.get(w);
  }
  for (const [, b] of freqB) magB += b * b;
  return magA && magB ? dot / (Math.sqrt(magA) * Math.sqrt(magB)) : 0;
}

function isInsideQuotes(text, startIdx, endIdx) {
  const before = text.slice(0, startIdx);
  const after = text.slice(endIdx);
  const dblBefore = (before.match(/["“]/g) || []).length;
  const dblAfter = (after.match(/["”]/g) || []).length;
  if (dblBefore % 2 === 1 && dblAfter >= 1) return true;
  const snippet = text.slice(startIdx, endIdx).trim();
  if (/^["“].*["”]$/.test(snippet)) return true;
  const quotedMatch = snippet.match(/["“]([^"”]+)["”]/);
  return Boolean(quotedMatch && quotedMatch[1].length >= snippet.length * 0.55);
}

function hasNearbyCitation(text, startIdx, endIdx) {
  const sameLineTail = text.slice(endIdx, Math.min(text.length, endIdx + 45)).split('\n')[0] || '';
  const window = text.slice(startIdx, endIdx) + sameLineTail;
  return /\([A-Z][\p{L}\s.&,-]+,\s*\d{4}[a-z]?\)/u.test(window) ||
    /\[\d+(?:[\s,-]+\d+)*\]/.test(window) ||
    /\b(?:menurut|according to|et al\.)\b/i.test(window);
}

function splitSentencesWithOffsets(text) {
  const out = [];
  const re = /[^.!?\n…]+[.!?…]*/g;
  let m;
  while ((m = re.exec(text)) !== null) {
    const raw = m[0];
    const lead = raw.length - raw.trimStart().length;
    const trimmed = raw.trim();
    if (trimmed.length >= 20) {
      out.push({
        text: trimmed,
        start: m.index + lead,
        end: m.index + lead + trimmed.length,
        normalized: normalizeText(trimmed),
        words: tokenize(trimmed),
      });
    }
  }
  return out;
}

function splitParagraphsWithOffsets(text) {
  const out = [];
  let pos = 0;
  for (const part of String(text || '').split(/\n\s*\n/)) {
    const at = text.indexOf(part, pos);
    const trimmed = part.trim();
    if (trimmed.length >= 30) {
      out.push({
        text: trimmed,
        start: at,
        end: at + part.length,
        normalized: normalizeText(trimmed),
        words: tokenize(trimmed),
      });
    }
    pos = at + part.length;
  }
  return out;
}

function reconstructInvertedAbstract(inv) {
  if (!inv || typeof inv !== 'object') return '';
  const arr = [];
  for (const [w, positions] of Object.entries(inv)) {
    if (!Array.isArray(positions)) continue;
    for (const p of positions) arr[p] = w;
  }
  return arr.filter(Boolean).join(' ').trim();
}

function findLongestCommonPhrase(wordsA, wordsB) {
  if (!wordsA.length || !wordsB.length) return '';
  let bestLen = 0;
  let bestEnd = 0;
  const dp = new Array(wordsB.length + 1).fill(0);
  for (let i = 1; i <= wordsA.length; i++) {
    for (let j = wordsB.length; j >= 1; j--) {
      if (wordsA[i - 1] === wordsB[j - 1]) {
        dp[j] = dp[j - 1] + 1;
        if (dp[j] > bestLen) {
          bestLen = dp[j];
          bestEnd = i;
        }
      } else {
        dp[j] = 0;
      }
    }
  }
  return bestLen >= 4 ? wordsA.slice(bestEnd - bestLen, bestEnd).join(' ') : '';
}

function classifyFindingLabel({ category, similarityMethod, score, quoted }) {
  if (quoted) return 'Properly Cited Quotation';
  if (category === 'repeated_phrase') return 'Repeated Text';
  if (similarityMethod === 'semantic_similarity') return 'Semantic Similarity';
  if (score >= 0.92 || similarityMethod === 'normalized_text_comparison') return 'Exact Match';
  if (category === 'close_paraphrase') return 'Possible Patchwriting';
  if (score >= 0.5) return 'Close Textual Match';
  return 'Semantic Similarity';
}

// Discover and fetch multi-source comparison corpus:
// 1. All accessible URLs present anywhere in the document (SSRF-protected)
// 2. Cited academic abstracts from citation verification
// 3. Independently discovered public academic sources (OpenAlex + Semantic Scholar) using distinctive body phrases
export async function discoverMultiSources(text, {
  citationSources = [],
  fetchImpl = fetch,
  timeoutMs = 5000,
  maxDocumentUrls = 5,
  maxOpenAlexWorks = 3,
} = {}) {
  const sources = [];
  const seenKeys = new Set();
  const urlLog = [];
  let documentUrlCount = 0;
  let independentCount = 0;
  let paywalledCount = 0;

  const addSource = (item) => {
    const key = item.doi || item.url || item.title;
    if (!key || seenKeys.has(key)) return false;
    seenKeys.add(key);
    sources.push(item);
    return true;
  };

  // 1. Add cited academic sources already verified
  for (const s of (Array.isArray(citationSources) ? citationSources : [])) {
    if (s && s.text && s.text.length > 25) {
      addSource({
        title: s.title || s.doi || 'Cited Academic Source',
        author: s.author || null,
        year: s.year || null,
        url: s.url || (s.doi ? `https://doi.org/${s.doi}` : null),
        doi: s.doi || null,
        source_type: s.source_type || 'cited_source_abstract',
        accessibility_status: s.accessibility_status || 'Open Access',
        text: s.text,
      });
    }
  }

  // 2. Extract and safely fetch all URLs present anywhere in the document (in-text, footnotes, tables, bibliography)
  const docUrls = extractDocumentUrls(text).slice(0, maxDocumentUrls);
  for (const entry of docUrls) {
    if (entry.doi && seenKeys.has(entry.doi)) continue;
    const fetched = await fetchAndExtractSource(entry.url, { fetchImpl, timeoutMs });
    urlLog.push({
      url: entry.url,
      ok: fetched.ok,
      accessibility_status: fetched.accessibility_status,
      code: fetched.code || null,
    });
    if (fetched.accessibility_status === 'Paywalled') {
      paywalledCount += 1;
      continue;
    }
    if (fetched.ok && fetched.text && fetched.text.length >= 40) {
      if (addSource({
        title: fetched.title || entry.url,
        author: fetched.author || null,
        year: fetched.year || null,
        url: fetched.url || entry.url,
        doi: entry.doi || null,
        source_type: 'document_url',
        accessibility_status: fetched.accessibility_status,
        text: fetched.text,
      })) {
        documentUrlCount += 1;
      }
    }
  }

  // 3. Independent public source discovery via OpenAlex & Semantic Scholar (NOT restricted to user bibliography)
  const words = tokenize(text).filter((w) => w.length > 4).slice(0, 8);
  if (words.length >= 3) {
    const query = words.join(' ');
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), timeoutMs);
    try {
      const res = await fetchImpl(
        `https://api.openalex.org/works?search=${encodeURIComponent(query)}&per-page=${maxOpenAlexWorks}&filter=has_abstract:true`,
        {
          method: 'GET',
          headers: { Accept: 'application/json', 'User-Agent': 'Runut/1.0 (mailto:support@runut.local)' },
          signal: ctrl.signal,
        },
      );
      if (res.ok) {
        const data = await res.json().catch(() => null);
        for (const work of (data?.results || [])) {
          const abstract = reconstructInvertedAbstract(work.abstract_inverted_index);
          if (!abstract || abstract.length < 40) continue;
          const doi = work.doi ? String(work.doi).replace(/^https?:\/\/doi\.org\//i, '') : null;
          const url = work?.open_access?.oa_url || work?.primary_location?.landing_page_url || work.doi || null;
          const authors = (work.authorships || []).map((a) => a?.author?.display_name).filter(Boolean).join(', ') || null;
          if (addSource({
            title: work.title || 'OpenAlex Open-Access Publication',
            author: authors,
            year: work.publication_year || null,
            url,
            doi,
            source_type: 'independently_discovered',
            accessibility_status: work?.open_access?.is_oa ? 'Open Access' : 'Metadata Only',
            text: abstract,
          })) {
            independentCount += 1;
          }
        }
      }
    } catch {
      // Network unavailable — gracefully continue
    } finally {
      clearTimeout(timer);
    }

    // Also query Semantic Scholar public paper search independently
    const s2Ctrl = new AbortController();
    const s2Timer = setTimeout(() => s2Ctrl.abort(), timeoutMs);
    try {
      const s2Res = await fetchImpl(
        `https://api.semanticscholar.org/graph/v1/paper/search?query=${encodeURIComponent(query)}&limit=2&fields=title,authors,year,abstract,url,externalIds,isOpenAccess,openAccessPdf`,
        {
          method: 'GET',
          headers: { Accept: 'application/json', 'User-Agent': 'Runut/1.0 (mailto:support@runut.local)' },
          signal: s2Ctrl.signal,
        },
      );
      if (s2Res.ok) {
        const s2Data = await s2Res.json().catch(() => null);
        for (const p of (s2Data?.data || [])) {
          if (!p?.abstract || p.abstract.length < 40) continue;
          const doi = p.externalIds?.DOI || null;
          const url = p.openAccessPdf?.url || p.url || (doi ? `https://doi.org/${doi}` : null);
          const authors = (p.authors || []).map((a) => a.name).filter(Boolean).join(', ') || null;
          if (addSource({
            title: p.title || 'Semantic Scholar Paper',
            author: authors,
            year: p.year || null,
            url,
            doi,
            source_type: 'independently_discovered',
            accessibility_status: p.isOpenAccess ? 'Open Access' : 'Metadata Only',
            text: p.abstract,
          })) {
            independentCount += 1;
          }
        }
      }
    } catch {
      // Graceful fallback
    } finally {
      clearTimeout(s2Timer);
    }
  }

  return {
    sources,
    url_fetch_log: urlLog,
    document_url_count: documentUrlCount,
    independent_count: independentCount,
    paywalled_count: paywalledCount,
  };
}

// Backward-compatible wrapper
export async function fetchAccessibleExternalSources(text, opts = {}) {
  const out = await discoverMultiSources(text, opts);
  return out.sources;
}

export function analyzeSimilarity(text, {
  referenceTexts = [],
  externalSources = [],
  bibliographyStart = -1,
} = {}) {
  const sourceText = String(text || '');
  const bodyText = bibliographyStart > 0 ? sourceText.slice(0, bibliographyStart) : sourceText;
  const sentences = splitSentencesWithOffsets(bodyText);
  const paragraphs = splitParagraphsWithOffsets(bodyText);
  const findings = [];
  const seenKeys = new Set();

  const pushFinding = (item) => {
    const key = `${item.category}:${item.similarity_method}:${normalizeText(item.original_passage).slice(0, 60)}`;
    if (seenKeys.has(key)) return;
    seenKeys.add(key);
    findings.push(item);
  };

  // 1. Internal repeated sentences
  const sentenceMap = new Map();
  for (const s of sentences) {
    if (s.words.length < 6) continue;
    const prev = sentenceMap.get(s.normalized);
    if (prev) {
      pushFinding({
        original_passage: s.text,
        matching_passage: prev.text,
        source_title: 'Internal document repetition',
        source_info: 'Internal document repetition',
        source_url: null,
        source_doi: null,
        matching_phrase: s.text,
        similarity_method: 'repeated_sentence',
        category: 'repeated_phrase',
        citation_status: isInsideQuotes(bodyText, s.start, s.end) ? 'direct_quotation' : 'internal_repetition',
        explanation: 'Kalimat ini muncul berulang secara identik di bagian lain dokumen.',
        suggested_correction: 'Pertahankan hanya di satu bagian atau rangkum secara berbeda bila konteksnya berbeda.',
        recommended_correction: 'Pertahankan hanya di satu bagian atau rangkum secara berbeda bila konteksnya berbeda.',
      });
    } else {
      sentenceMap.set(s.normalized, s);
    }
  }

  // 2. Internal repeated paragraphs
  const paraMap = new Map();
  for (const p of paragraphs) {
    if (p.words.length < 12) continue;
    const prev = paraMap.get(p.normalized);
    if (prev) {
      pushFinding({
        original_passage: p.text.slice(0, 300),
        matching_passage: prev.text.slice(0, 300),
        source_title: 'Internal document repetition',
        source_info: 'Internal document repetition',
        source_url: null,
        source_doi: null,
        matching_phrase: p.text.slice(0, 140),
        similarity_method: 'repeated_paragraph',
        category: 'repeated_phrase',
        citation_status: 'internal_repetition',
        explanation: 'Paragraf ini terduplikasi dengan isi yang sama di bagian lain dokumen.',
        suggested_correction: 'Hapus duplikasi atau bedakan fokus pembahasannya.',
        recommended_correction: 'Hapus duplikasi atau bedakan fokus pembahasannya.',
      });
    } else {
      paraMap.set(p.normalized, p);
    }
  }

  // 3. Internal repeated 5-gram phrases (excluding common academic expressions)
  const docWords = tokenize(bodyText);
  const fiveGrams = buildNgrams(docWords, 5);
  const gramCounts = new Map();
  for (const g of fiveGrams) {
    gramCounts.set(g, (gramCounts.get(g) || 0) + 1);
  }
  for (const [phrase, count] of gramCounts) {
    if (count < 2) continue;
    if (COMMON_ACADEMIC_EXPRESSIONS.has(phrase)) continue;
    pushFinding({
      original_passage: phrase,
      matching_passage: phrase,
      source_title: `Internal document (${count}x)`,
      source_info: `Internal document (${count}x)`,
      source_url: null,
      source_doi: null,
      matching_phrase: phrase,
      similarity_method: 'exact_phrase_matching',
      category: 'repeated_phrase',
      citation_status: 'internal_repetition',
      explanation: `Frasa 5 kata "${phrase}" berulang ${count} kali di dalam dokumen.`,
      suggested_correction: 'Variasikan pengungkapan frasa ini bila bukan istilah teknis baku.',
      recommended_correction: 'Variasikan pengungkapan frasa ini bila bukan istilah teknis baku.',
    });
    if (findings.length >= 25) break;
  }

  // 4. Compare against combined corpus: user-provided references + accessible external sources
  const combinedSources = [
    ...(Array.isArray(referenceTexts) ? referenceTexts.map((r) => ({ ...r, source_type: r.source_type || 'user_reference' })) : []),
    ...(Array.isArray(externalSources) ? externalSources.map((r) => ({ ...r, source_type: r.source_type || 'external_source' })) : []),
  ];

  const normalizedRefs = combinedSources
    .filter((r) => r && typeof r.text === 'string' && r.text.trim().length > 20)
    .map((r, idx) => {
      const refSentences = splitSentencesWithOffsets(r.text);
      const refWords = tokenize(r.text);
      const ref3Grams = new Set(buildNgrams(refWords, 3));
      const ref5Grams = new Set(buildNgrams(refWords, 5));
      return {
        label: r.title || r.source || `Reference #${idx + 1}`,
        author: r.author || null,
        year: r.year || null,
        url: r.url || null,
        doi: r.doi || null,
        source_type: r.source_type,
        accessibility_status: r.accessibility_status || (r.source_type === 'user_reference' ? 'User-Provided Source' : 'Open Access'),
        text: r.text,
        normalized: normalizeText(r.text),
        words: refWords,
        sentences: refSentences,
        grams3: ref3Grams,
        grams5: ref5Grams,
      };
    });

  let matchedSentenceCount = 0;

  if (normalizedRefs.length > 0) {
    for (const s of sentences) {
      if (s.words.length < 5) continue;
      if (COMMON_ACADEMIC_EXPRESSIONS.has(s.normalized)) continue;

      const quoted = isInsideQuotes(bodyText, s.start, s.end);
      const cited = hasNearbyCitation(bodyText, s.start, s.end);
      const s3Grams = new Set(buildNgrams(s.words, 3));
      const s5Grams = new Set(buildNgrams(s.words, 5));

      let bestMatch = null;
      for (const ref of normalizedRefs) {
        if (ref.normalized.includes(s.normalized) && s.normalized.length >= 25) {
          bestMatch = {
            ref,
            method: 'normalized_text_comparison',
            score: 1,
            matchingPassage: s.text,
          };
          break;
        }

        const overlap5 = containment(s5Grams, ref.grams5);
        const overlap3 = containment(s3Grams, ref.grams3);
        const jacc3 = jaccard(s3Grams, ref.grams3);
        const lcp = findLongestCommonPhrase(s.words, ref.words);

        let bestRefSent = null;
        let bestCosine = 0;
        for (const rs of ref.sentences) {
          const cos = cosineOverlap(s.words, rs.words);
          if (cos > bestCosine) {
            bestCosine = cos;
            bestRefSent = rs.text;
          }
        }

        const isLexical = overlap5 >= 0.35 || overlap3 >= 0.5 || lcp.split(' ').filter(Boolean).length >= 6;
        const isSemanticOnly = !isLexical && bestCosine >= 0.58;

        if (isLexical || isSemanticOnly) {
          const method = isLexical
            ? (lcp.split(' ').filter(Boolean).length >= 6 && overlap5 < 0.35 ? 'longest_common_phrase' : 'ngram_similarity')
            : 'semantic_similarity';
          const score = isLexical ? Math.max(overlap5, overlap3, jacc3) : bestCosine;
          if (!bestMatch || score > bestMatch.score) {
            bestMatch = {
              ref,
              method,
              isSemanticOnly,
              longestCommonPhrase: lcp || s.text.slice(0, 140),
              score,
              matchingPassage: bestRefSent || ref.text.slice(0, 240),
            };
          }
        }
      }

      if (bestMatch) {
        if (!bestMatch.isSemanticOnly) {
          matchedSentenceCount += 1;
        }
        let category = bestMatch.isSemanticOnly ? 'semantic_similarity' : 'unattributed_overlap';
        let citationStatus = bestMatch.isSemanticOnly
          ? (cited ? 'properly_cited' : 'review_attribution')
          : 'missing_citation';
        let suggestion = bestMatch.isSemanticOnly
          ? 'Konsep serupa dengan sumber ini tanpa penyalinan kata persis; pastikan atribusi sitasi bila gagasan berasal dari sumber tersebut.'
          : 'Pahami gagasan inti sumber, susun ulang dengan struktur kalimat sendiri tanpa mengubah fakta/istilah teknis, dan tambahkan sitasi ke sumber asli.';

        if (quoted) {
          category = 'direct_quotation';
          citationStatus = cited ? 'properly_cited' : 'quote_missing_citation';
          suggestion = cited
            ? 'Kutipan langsung sudah bertanda kutip dan bersitasi; pertahankan apa adanya tanpa diubah.'
            : 'Kutipan langsung terdeteksi; pastikan sitasi sumber dan nomor halaman dicantumkan.';
        } else if (cited && !bestMatch.isSemanticOnly) {
          category = bestMatch.score >= 0.75 ? 'close_paraphrase' : 'properly_cited';
          citationStatus = 'properly_cited';
          suggestion = bestMatch.score >= 0.75
            ? 'Susunan kata masih terlalu dekat dengan sumber (indikasi patchwriting). Susun ulang dengan struktur kalimat sendiri sambil mempertahankan sitasi asli.'
            : 'Parafrase bersitasi memadai; pertahankan sitasi.';
        }

        const findingClass = classifyFindingLabel({
          category,
          similarityMethod: bestMatch.method,
          score: bestMatch.score,
          quoted,
        });

        pushFinding({
          original_passage: s.text,
          matching_passage: bestMatch.matchingPassage,
          source_title: bestMatch.ref.label,
          source_author: bestMatch.ref.author,
          source_year: bestMatch.ref.year,
          source_info: bestMatch.ref.label,
          source_url: bestMatch.ref.url,
          source_doi: bestMatch.ref.doi,
          source_type: bestMatch.ref.source_type,
          source_accessibility_status: bestMatch.ref.accessibility_status,
          matching_phrase: bestMatch.longestCommonPhrase || s.text.slice(0, 140),
          similarity_method: bestMatch.method,
          similarity_dimension: bestMatch.isSemanticOnly ? 'semantic' : 'lexical',
          classification: findingClass,
          category,
          citation_status: citationStatus,
          similarity_ratio: Math.round(bestMatch.score * 100) / 100,
          explanation: `Terdeteksi ${findingClass} (${bestMatch.method}, rasio ${Math.round(bestMatch.score * 100)}%) terhadap "${bestMatch.ref.label}" (${bestMatch.ref.accessibility_status}).`,
          suggested_correction: suggestion,
          recommended_correction: suggestion,
        });
      }
    }
  }

  const userRefCount = normalizedRefs.filter((r) => r.source_type === 'user_reference').length;
  const documentUrlCount = normalizedRefs.filter((r) => r.source_type === 'document_url').length;
  const independentCount = normalizedRefs.filter((r) => r.source_type === 'independently_discovered').length;
  const externalCount = normalizedRefs.filter((r) => r.source_type !== 'user_reference').length;
  const fullTextAccessibleCount = normalizedRefs.filter((r) =>
    r.accessibility_status === 'Full Text Accessible' || r.accessibility_status === 'User-Provided Source',
  ).length;
  const metadataOnlyCount = normalizedRefs.filter((r) => r.accessibility_status === 'Metadata Only').length;

  const corpusCompared = externalCount > 0 && userRefCount > 0
    ? 'user_references_and_external_sources'
    : (externalCount > 0 ? 'accessible_external_sources' : (userRefCount > 0 ? 'user_references' : 'internal_only'));

  const corpusSimilarityPercent = normalizedRefs.length > 0 && sentences.length > 0
    ? Math.round((matchedSentenceCount / sentences.length) * 100)
    : null;

  const lexicalFindings = findings.filter((f) => f.similarity_dimension !== 'semantic');
  const semanticFindings = findings.filter((f) => f.similarity_dimension === 'semantic');

  return {
    corpus_compared: corpusCompared,
    reference_count: userRefCount,
    external_source_count: externalCount,
    total_sources_compared: normalizedRefs.length,
    corpus_similarity_percent: corpusSimilarityPercent,
    corpus_coverage: {
      sources_checked: normalizedRefs.length,
      full_text_accessible_sources: fullTextAccessibleCount,
      metadata_only_sources: metadataOnlyCount,
      user_provided_references: userRefCount,
      document_url_sources: documentUrlCount,
      independently_discovered_sources: independentCount,
      comparison_methods: [
        'exact_phrase_matching',
        'normalized_text_comparison',
        'ngram_similarity',
        'longest_common_phrase',
        'repeated_sentence',
        'repeated_paragraph',
        'semantic_similarity',
      ],
      checked_at: new Date().toISOString(),
    },
    calculation_method: normalizedRefs.length > 0
      ? `Persentase kalimat tubuh teks (di luar daftar pustaka) dengan kecocokan leksikal terhadap ${normalizedRefs.length} sumber pembanding (${matchedSentenceCount}/${sentences.length} kalimat). Kemiripan semantik dilaporkan terpisah.`
      : 'Tidak ada korpus eksternal yang tersedia; persentase kemiripan eksternal tidak dihitung.',
    scope_note: normalizedRefs.length > 0
      ? `Perbandingan dilakukan terhadap ${userRefCount} referensi pengguna, ${documentUrlCount} URL dokumen yang dapat diakses, dan ${independentCount} sumber publik yang ditemukan independen (OpenAlex/Crossref/Semantic Scholar). Tidak mencakup seluruh internet maupun basis data berbayar seperti Turnitin atau iThenticate.`
      : 'Tidak ada sumber referensi eksternal yang dapat diakses; analisis kemiripan terbatas pada pengulangan internal dokumen dan tidak mengklaim skor Turnitin/iThenticate.',
    summary: {
      total_findings: findings.length,
      lexical_matches: lexicalFindings.length,
      semantic_matches: semanticFindings.length,
      direct_quotations: findings.filter((f) => f.category === 'direct_quotation').length,
      properly_cited: findings.filter((f) => f.category === 'properly_cited').length,
      close_paraphrases: findings.filter((f) => f.category === 'close_paraphrase').length,
      unattributed_overlaps: findings.filter((f) => f.category === 'unattributed_overlap').length,
      repeated_phrases: findings.filter((f) => f.category === 'repeated_phrase').length,
    },
    lexical_findings: lexicalFindings,
    semantic_findings: semanticFindings,
    findings,
  };
}
