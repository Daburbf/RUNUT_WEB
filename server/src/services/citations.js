// Citation and Bibliography Validation Engine
// Supports APA 7th, IEEE, and Harvard style detection, in-text <-> bibliography
// cross-checking, duplicate detection, bibliography protection, and multi-provider
// external verification (Crossref, OpenAlex, Unpaywall, Semantic Scholar, DOAJ)
// separating bibliographic metadata verification from full-text accessibility.
import { resolveAcademicSourceByDoi, SOURCE_STATUS } from './academicSources.js';

const BIB_HEADING_RE = /^(?:\s*)(daftar pustaka|referensi|kepustakaan|references|bibliography|works cited)\s*:?\s*$/im;
const DOI_RE = /\b(10\.\d{4,9}\/[-._;()/:A-Z0-9]+)\b/gi;
const URL_RE = /https?:\/\/[^\s)>\]]+/gi;
const YEAR_RE = /\b(19\d{2}|20[0-2]\d)[a-z]?\b/;

const APA_HARVARD_PAREN_RE = /\(([A-ZÀ-Þ][\p{L}'-]+(?:\s+(?:&|and|dan)\s+[A-ZÀ-Þ][\p{L}'-]+|\s+et\s+al\.?)?),\s*((?:19|20)\d{2}[a-z]?)(?:,\s*(?:p\.|pp\.|hlm\.)\s*\d+(?:-\d+)?)?\)/gu;
const APA_NARRATIVE_RE = /\b([A-ZÀ-Þ][\p{L}'-]+(?:\s+(?:&|and|dan)\s+[A-ZÀ-Þ][\p{L}'-]+|\s+et\s+al\.?)?)\s+\(((?:19|20)\d{2}[a-z]?)\)/gu;
const IEEE_CITE_RE = /\[(\d+(?:\s*[-–,]\s*\d+)*)\]/g;

export function findBibliographySection(text) {
  const source = String(text || '');
  const match = BIB_HEADING_RE.exec(source);
  if (!match) {
    return { found: false, start: -1, heading: null, body: '' };
  }
  const start = match.index;
  const bodyStart = match.index + match[0].length;
  return {
    found: true,
    start,
    heading: match[1].trim(),
    body: source.slice(bodyStart).trimStart(),
  };
}

export function detectCitationStyle(inTextMatches, bibEntries) {
  const ieeeCount = inTextMatches.filter((c) => c.format === 'ieee').length +
    bibEntries.filter((b) => /^\[\d+\]/.test(b.raw)).length;
  const authorYearCount = inTextMatches.filter((c) => c.format === 'author_year').length;

  if (ieeeCount > 0 && authorYearCount === 0) return 'IEEE';
  if (authorYearCount > 0 && ieeeCount === 0) {
    const hasAmpersand = inTextMatches.some((c) => c.raw.includes('&')) ||
      bibEntries.some((b) => b.raw.includes('&'));
    return hasAmpersand ? 'APA 7th' : 'Harvard';
  }
  if (ieeeCount > 0 && authorYearCount > 0) return 'mixed';
  return 'unknown';
}

function parseBibliographyEntries(bibBody) {
  if (!bibBody || !bibBody.trim()) return [];
  const lines = bibBody.split(/\n+/).map((l) => l.trim()).filter(Boolean);
  const entries = [];
  for (let i = 0; i < lines.length; i++) {
    const raw = lines[i];
    if (raw.length < 12) continue;
    const ieeeNumMatch = raw.match(/^\[(\d+)\]\s*/);
    const yearMatch = raw.match(YEAR_RE);
    const doiMatches = raw.match(DOI_RE) || [];
    const urlMatches = raw.match(URL_RE) || [];
    const volIssueMatch = raw.match(/\b(\d+)\s*\((\d+)\)/);
    const pagesMatch = raw.match(/\b(\d+\s*[-–]\s*\d+)\b/);

    const cleanedForAuthor = raw.replace(/^\[\d+\]\s*/, '');
    const surnameMatch = cleanedForAuthor.match(/^([A-ZÀ-Þ][\p{L}'-]+)/u);

    const missingFields = [];
    if (!surnameMatch) missingFields.push('author');
    if (!yearMatch) missingFields.push('year');
    if (raw.length < 30) missingFields.push('title_or_venue');

    entries.push({
      index: i + 1,
      ieee_number: ieeeNumMatch ? Number(ieeeNumMatch[1]) : null,
      author_key: surnameMatch ? surnameMatch[1].toLowerCase() : null,
      year: yearMatch ? yearMatch[1] : null,
      volume: volIssueMatch ? volIssueMatch[1] : null,
      issue: volIssueMatch ? volIssueMatch[2] : null,
      pages: pagesMatch ? pagesMatch[1] : null,
      dois: doiMatches.map((d) => d.replace(/[.,;)]+$/, '')),
      urls: urlMatches.map((u) => u.replace(/[.,;)]+$/, '')),
      incomplete: missingFields.length > 0,
      missing_fields: missingFields,
      raw,
    });
  }
  return entries;
}

function extractInTextCitations(bodyText) {
  const citations = [];
  for (const m of bodyText.matchAll(APA_HARVARD_PAREN_RE)) {
    const authorPart = m[1].trim();
    const surname = authorPart.split(/[\s,&]/)[0].toLowerCase();
    citations.push({
      format: 'author_year',
      raw: m[0],
      author_key: surname,
      year: m[2],
      position: m.index,
    });
  }
  for (const m of bodyText.matchAll(APA_NARRATIVE_RE)) {
    const authorPart = m[1].trim();
    const surname = authorPart.split(/[\s,&]/)[0].toLowerCase();
    citations.push({
      format: 'author_year',
      raw: m[0],
      author_key: surname,
      year: m[2],
      position: m.index,
    });
  }
  for (const m of bodyText.matchAll(IEEE_CITE_RE)) {
    const nums = [];
    for (const part of m[1].split(',')) {
      const range = part.trim().match(/^(\d+)\s*[-–]\s*(\d+)$/);
      if (range) {
        const a = Number(range[1]);
        const b = Number(range[2]);
        for (let n = a; n <= Math.min(b, a + 50); n++) nums.push(n);
      } else {
        const n = Number(part.trim());
        if (Number.isInteger(n)) nums.push(n);
      }
    }
    citations.push({
      format: 'ieee',
      raw: m[0],
      numbers: nums,
      position: m.index,
    });
  }
  return citations;
}

function reconstructOpenAlexAbstract(invertedIndex) {
  if (!invertedIndex || typeof invertedIndex !== 'object') return null;
  const words = [];
  for (const [word, positions] of Object.entries(invertedIndex)) {
    if (!Array.isArray(positions)) continue;
    for (const pos of positions) {
      words[pos] = word;
    }
  }
  const text = words.filter(Boolean).join(' ').trim();
  return text || null;
}

function stripXmlTags(str) {
  return String(str || '').replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
}

function compareEntryWithMetadata(entry, meta) {
  const mismatches = [];
  const verifiedFields = [];

  if (meta.doi) verifiedFields.push('doi');

  // Compare publication year
  if (meta.year && entry.year) {
    if (String(meta.year) !== String(entry.year).slice(0, 4)) {
      mismatches.push({
        field: 'year',
        entry_value: entry.year,
        source_value: String(meta.year),
        message: `Tahun publikasi pada daftar pustaka (${entry.year}) tidak cocok dengan metadata sumber (${meta.year}).`,
      });
    } else {
      verifiedFields.push('year');
    }
  }

  // Compare primary author surname
  if (Array.isArray(meta.authors) && meta.authors.length > 0 && entry.author_key) {
    const lowerRaw = entry.raw.toLowerCase();
    const authorMatch = meta.authors.some((a) => {
      const family = String(a || '').trim().toLowerCase().split(/\s+/).pop();
      return family && (family === entry.author_key || lowerRaw.includes(family));
    });
    if (!authorMatch) {
      mismatches.push({
        field: 'author',
        entry_value: entry.author_key,
        source_value: meta.authors.slice(0, 3).join(', '),
        message: `Nama penulis pada daftar pustaka tidak cocok dengan metadata sumber (${meta.authors.slice(0, 3).join(', ')}).`,
      });
    } else {
      verifiedFields.push('author');
    }
  }

  // Compare title words overlap
  if (meta.title) {
    const titleWords = meta.title.toLowerCase().replace(/[^\p{L}\p{N}\s]/gu, ' ').split(/\s+/).filter((w) => w.length > 3);
    const rawLower = entry.raw.toLowerCase();
    const hitCount = titleWords.filter((w) => rawLower.includes(w)).length;
    if (titleWords.length >= 2 && hitCount / titleWords.length >= 0.4) {
      verifiedFields.push('title');
    } else if (titleWords.length >= 3 && hitCount === 0) {
      mismatches.push({
        field: 'title',
        entry_value: entry.raw.slice(0, 100),
        source_value: meta.title,
        message: `Judul pada daftar pustaka tidak cocok dengan judul DOI resmi ("${meta.title}").`,
      });
    }
  }

  if (meta.journal && entry.raw.toLowerCase().includes(meta.journal.toLowerCase().slice(0, 12))) {
    verifiedFields.push('journal');
  }
  if (meta.volume && entry.volume && String(meta.volume) === String(entry.volume)) {
    verifiedFields.push('volume');
  }
  if (meta.pages && entry.pages && entry.pages.replace(/\s+/g, '') === String(meta.pages).replace(/\s+/g, '')) {
    verifiedFields.push('pages');
  }

  let status = 'verified';
  if (mismatches.length > 0) status = 'metadata_mismatch';
  else if (verifiedFields.length < 3) status = 'partially_verified';

  return { status, verified_fields: verifiedFields, mismatches };
}

async function fetchCrossrefByDoi(doi, fetchImpl, timeoutMs) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await fetchImpl(`https://api.crossref.org/works/${encodeURIComponent(doi)}`, {
      method: 'GET',
      headers: { Accept: 'application/json', 'User-Agent': 'Runut/1.0 (mailto:support@runut.local)' },
      signal: ctrl.signal,
    });
    if (res.status === 404) return { found: false, status: 404, source: 'crossref' };
    if (!res.ok) return { found: false, unavailable: true, status: res.status, source: 'crossref' };
    const data = await res.json().catch(() => null);
    const msg = data?.message;
    if (!msg) return { found: false, unavailable: true, source: 'crossref' };

    const dateParts = msg?.published?.['date-parts']?.[0] ||
      msg?.['published-print']?.['date-parts']?.[0] ||
      msg?.['published-online']?.['date-parts']?.[0] ||
      msg?.issued?.['date-parts']?.[0] || [];
    const authors = (msg.author || []).map((a) => a.family || a.name || '').filter(Boolean);

    return {
      found: true,
      source: 'crossref',
      doi,
      title: Array.isArray(msg.title) ? msg.title[0] : (msg.title || null),
      authors,
      year: dateParts[0] || null,
      journal: Array.isArray(msg['container-title']) ? msg['container-title'][0] : (msg.publisher || null),
      volume: msg.volume || null,
      issue: msg.issue || null,
      pages: msg.page || null,
      url: msg.URL || `https://doi.org/${doi}`,
      abstract: msg.abstract ? stripXmlTags(msg.abstract) : null,
    };
  } catch (err) {
    return { found: false, unavailable: true, source: 'crossref', reason: err?.message || 'network_error' };
  } finally {
    clearTimeout(timer);
  }
}

async function fetchOpenAlexByDoi(doi, fetchImpl, timeoutMs) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await fetchImpl(`https://api.openalex.org/works/https://doi.org/${encodeURIComponent(doi)}`, {
      method: 'GET',
      headers: { Accept: 'application/json', 'User-Agent': 'Runut/1.0 (mailto:support@runut.local)' },
      signal: ctrl.signal,
    });
    if (res.status === 404) return { found: false, status: 404, source: 'openalex' };
    if (!res.ok) return { found: false, unavailable: true, status: res.status, source: 'openalex' };
    const work = await res.json().catch(() => null);
    if (!work || !work.title) return { found: false, unavailable: true, source: 'openalex' };

    const authors = (work.authorships || []).map((a) => a?.author?.display_name || '').filter(Boolean);
    const abstract = reconstructOpenAlexAbstract(work.abstract_inverted_index);

    return {
      found: true,
      source: 'openalex',
      doi,
      title: work.title || null,
      authors,
      year: work.publication_year || null,
      journal: work?.primary_location?.source?.display_name || null,
      volume: work?.biblio?.volume || null,
      issue: work?.biblio?.issue || null,
      pages: work?.biblio?.first_page && work?.biblio?.last_page
        ? `${work.biblio.first_page}-${work.biblio.last_page}`
        : (work?.biblio?.first_page || null),
      url: work?.open_access?.oa_url || work?.primary_location?.landing_page_url || `https://doi.org/${doi}`,
      abstract,
    };
  } catch (err) {
    return { found: false, unavailable: true, source: 'openalex', reason: err?.message || 'network_error' };
  } finally {
    clearTimeout(timer);
  }
}

export async function verifyDoiMetadata(doi, entry, { fetchImpl = fetch, timeoutMs = 4500 } = {}) {
  const resolved = await resolveAcademicSourceByDoi(doi, { fetchImpl, timeoutMs });

  if (!resolved.found) {
    return {
      doi,
      status: resolved.invalid_doi ? 'invalid_doi' : 'source_unavailable',
      metadata_status: resolved.metadata_status,
      accessibility_status: resolved.accessibility_status,
      providers_consulted: resolved.providers_consulted,
      source: resolved.providers_consulted.join('+'),
      title: null,
      mismatches: [],
      verified_fields: [],
      reason: resolved.reason,
    };
  }

  const comparison = compareEntryWithMetadata(entry, resolved);
  const metadataStatusLabel = comparison.status === 'verified'
    ? SOURCE_STATUS.METADATA_VERIFIED
    : (comparison.status === 'metadata_mismatch'
      ? SOURCE_STATUS.METADATA_MISMATCH
      : SOURCE_STATUS.PARTIALLY_VERIFIED);

  return {
    doi,
    status: comparison.status,
    metadata_status: metadataStatusLabel,
    accessibility_status: resolved.accessibility_status,
    providers_consulted: resolved.providers_consulted,
    source: resolved.source,
    title: resolved.title,
    authors: resolved.authors,
    year: resolved.year,
    journal: resolved.journal,
    publisher: resolved.publisher || null,
    url: resolved.url,
    oa_url: resolved.oa_url || null,
    repository_institution: resolved.repository_institution || null,
    version_type: resolved.version_type || null,
    is_oa: resolved.is_oa,
    full_text_verified: Boolean(resolved.full_text_verified),
    abstract: resolved.abstract || null,
    verified_fields: comparison.verified_fields,
    mismatches: comparison.mismatches,
    claim_support_note: resolved.abstract
      ? `Metadata terverifikasi (${metadataStatusLabel}) dan abstrak terbuka berhasil diakses (${resolved.accessibility_status}).`
      : (resolved.accessibility_status === SOURCE_STATUS.PAYWALLED
        ? 'Metadata DOI terverifikasi, tetapi teks penuh berada di balik paywall (Paywalled) dan tidak diakses oleh RUNUT.'
        : 'Metadata DOI terverifikasi (Metadata Only), namun teks penuh tidak tersedia sehingga dukungan klaim perlu diperiksa manual.'),
  };
}

export async function validateCitations(text, { verifyExternal = false, fetchImpl = fetch, timeoutMs = 4500 } = {}) {
  const source = String(text || '');
  const bib = findBibliographySection(source);
  const bodyText = bib.found ? source.slice(0, bib.start) : source;

  const inText = extractInTextCitations(bodyText);
  const bibEntries = parseBibliographyEntries(bib.body);
  const detectedStyle = detectCitationStyle(inText, bibEntries);

  const missingReferences = [];
  const unusedReferences = [];
  const duplicateReferences = [];
  const incompleteReferences = [];
  const metadataMismatches = [];
  const formattingIssues = [];
  const doiChecks = [];

  if (detectedStyle === 'mixed') {
    formattingIssues.push({
      type: 'mixed_citation_style',
      message: 'Dokumen mencampurkan gaya sitasi author-year (APA/Harvard) dan numerik (IEEE). Gunakan satu gaya sitasi secara konsisten.',
    });
  }

  const seenEntries = new Map();
  for (const entry of bibEntries) {
    if (entry.incomplete) {
      incompleteReferences.push({
        index: entry.index,
        entry: entry.raw,
        missing_fields: entry.missing_fields,
      });
    }
    const norm = entry.raw.toLowerCase().replace(/\s+/g, ' ').trim();
    if (seenEntries.has(norm)) {
      duplicateReferences.push({
        entry: entry.raw,
        first_index: seenEntries.get(norm),
        duplicate_index: entry.index,
      });
    } else {
      seenEntries.set(norm, entry.index);
    }
  }

  const matchedBibIndices = new Set();

  for (const cite of inText) {
    if (cite.format === 'ieee') {
      for (const num of cite.numbers) {
        const found = bibEntries.find((e) => e.ieee_number === num || e.index === num);
        if (!found) {
          missingReferences.push({ citation: `[${num}]`, position: cite.position, reason: 'Nomor sitasi tidak ditemukan di daftar pustaka.' });
        } else {
          matchedBibIndices.add(found.index);
        }
      }
    } else if (cite.format === 'author_year') {
      const exactMatches = bibEntries.filter((e) =>
        e.author_key === cite.author_key && (!cite.year || !e.year || e.year === cite.year),
      );
      if (exactMatches.length > 0) {
        for (const m of exactMatches) matchedBibIndices.add(m.index);
      } else if (bib.found) {
        // Check if author exists with a DIFFERENT year -> year mismatch!
        const sameAuthorDiffYear = bibEntries.find((e) => e.author_key === cite.author_key && e.year && cite.year && e.year !== cite.year);
        if (sameAuthorDiffYear) {
          matchedBibIndices.add(sameAuthorDiffYear.index);
          metadataMismatches.push({
            type: 'in_text_year_mismatch',
            citation: cite.raw,
            bibliography_entry: sameAuthorDiffYear.raw,
            message: `Tahun sitasi dalam teks (${cite.year}) berbeda dengan tahun di daftar pustaka (${sameAuthorDiffYear.year}).`,
          });
        } else {
          missingReferences.push({ citation: cite.raw, position: cite.position, reason: 'Sitasi dalam teks belum memiliki entri yang cocok di daftar pustaka.' });
        }
      }
    }
  }

  for (const entry of bibEntries) {
    if (!matchedBibIndices.has(entry.index)) {
      unusedReferences.push({ index: entry.index, entry: entry.raw });
    }
  }

  const verifiedAbstractSources = [];

  for (const entry of bibEntries) {
    for (const doi of entry.dois) {
      if (verifyExternal) {
        const check = await verifyDoiMetadata(doi, entry, { fetchImpl, timeoutMs });
        doiChecks.push(check);
        if (check.mismatches?.length) {
          for (const m of check.mismatches) {
            metadataMismatches.push({
              type: 'doi_metadata_mismatch',
              doi,
              field: m.field,
              entry_value: m.entry_value,
              source_value: m.source_value,
              message: m.message,
            });
          }
        }
        if (check.abstract) {
          verifiedAbstractSources.push({
            title: check.title || doi,
            author: Array.isArray(check.authors) ? check.authors.join(', ') : null,
            year: check.year || null,
            doi,
            url: check.oa_url || check.url || `https://doi.org/${doi}`,
            source_type: 'external_academic_abstract',
            accessibility_status: check.accessibility_status || SOURCE_STATUS.OPEN_ACCESS,
            text: check.abstract,
          });
        }
      } else {
        doiChecks.push({
          doi,
          status: 'unverified',
          metadata_status: SOURCE_STATUS.UNVERIFIED,
          accessibility_status: SOURCE_STATUS.UNVERIFIED,
          source: 'offline',
          verified_fields: [],
          mismatches: [],
          reason: 'Verifikasi eksternal tidak dijalankan; aktifkan verify_citations untuk memeriksa metadata DOI via Crossref/OpenAlex/Unpaywall/Semantic Scholar/DOAJ.',
        });
      }
    }
  }

  return {
    detected_style: detectedStyle,
    bibliography_found: bib.found,
    bibliography_protected: true,
    bibliography_start: bib.start,
    in_text_count: inText.length,
    bibliography_count: bibEntries.length,
    missing_references: missingReferences,
    unused_references: unusedReferences,
    duplicate_references: duplicateReferences,
    incomplete_references: incompleteReferences,
    metadata_mismatches: metadataMismatches,
    formatting_issues: formattingIssues,
    doi_checks: doiChecks,
    accessible_sources: verifiedAbstractSources,
  };
}
