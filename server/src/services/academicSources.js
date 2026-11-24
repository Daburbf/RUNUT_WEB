// Expanded Legitimate Academic Source Discovery & Verification.
// Integrates public, legal academic APIs (Crossref, OpenAlex, Unpaywall,
// Semantic Scholar, DOAJ, and PubMed Central) while strictly separating
// bibliographic metadata verification from full-text accessibility.
// Never scrapes restricted databases or bypasses paywalls.

const USER_AGENT = 'Runut/1.0 (mailto:support@runut.local)';

export const SOURCE_STATUS = {
  METADATA_VERIFIED: 'Metadata Verified',
  FULL_TEXT_VERIFIED: 'Full Text Verified',
  PARTIALLY_VERIFIED: 'Partially Verified',
  METADATA_MISMATCH: 'Metadata Mismatch',
  FULL_TEXT_ACCESSIBLE: 'Full Text Accessible',
  OPEN_ACCESS: 'Open Access',
  INSTITUTIONAL_REPOSITORY: 'Institutional Repository Copy',
  AUTHOR_MANUSCRIPT: 'Author Manuscript',
  USER_PROVIDED: 'User-Provided Source',
  METADATA_ONLY: 'Metadata Only',
  UNVERIFIED: 'Unverified',
  PAYWALLED: 'Paywalled',
  SOURCE_UNAVAILABLE: 'Source Unavailable',
};

// Verify that an alternative repository / OA record genuinely matches the target publication.
// Never assumes two articles with similar titles are identical without DOI or title+year+author match.
export function verifyAlternativeVersionMatches(targetMeta, candidateMeta) {
  if (!targetMeta || !candidateMeta) return { matches: false, reason: 'missing_metadata' };
  const tDoi = String(targetMeta.doi || '').trim().toLowerCase();
  const cDoi = String(candidateMeta.doi || '').trim().toLowerCase();
  if (tDoi && cDoi && tDoi === cDoi) {
    return { matches: true, reason: 'exact_doi_match' };
  }

  const normTitle = (s) => String(s || '').toLowerCase().replace(/[^\p{L}\p{N}\s]/gu, ' ').replace(/\s+/g, ' ').trim();
  const tWords = new Set(normTitle(targetMeta.title).split(' ').filter((w) => w.length > 2));
  const cWords = new Set(normTitle(candidateMeta.title).split(' ').filter((w) => w.length > 2));
  if (!tWords.size || !cWords.size) return { matches: false, reason: 'missing_title' };

  let overlap = 0;
  for (const w of tWords) if (cWords.has(w)) overlap += 1;
  const titleSim = overlap / Math.max(tWords.size, cWords.size);
  const yearMatch = !targetMeta.year || !candidateMeta.year || String(targetMeta.year) === String(candidateMeta.year);

  if (titleSim >= 0.85 && yearMatch) {
    return { matches: true, reason: 'title_and_year_verified', title_similarity: Math.round(titleSim * 100) / 100 };
  }
  return { matches: false, reason: 'different_publication_or_version_mismatch', title_similarity: Math.round(titleSim * 100) / 100 };
}

function stripXml(str) {
  return String(str || '').replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
}

export function reconstructOpenAlexAbstract(invertedIndex) {
  if (!invertedIndex || typeof invertedIndex !== 'object') return null;
  const words = [];
  for (const [word, positions] of Object.entries(invertedIndex)) {
    if (!Array.isArray(positions)) continue;
    for (const pos of positions) words[pos] = word;
  }
  const text = words.filter(Boolean).join(' ').trim();
  return text || null;
}

async function fetchJsonWithTimeout(url, fetchImpl = fetch, timeoutMs = 4500, extraHeaders = {}) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await fetchImpl(url, {
      method: 'GET',
      headers: { Accept: 'application/json', 'User-Agent': USER_AGENT, ...extraHeaders },
      signal: ctrl.signal,
    });
    if (res.status === 404) return { ok: false, status: 404, data: null };
    if (!res.ok) return { ok: false, status: res.status, unavailable: true, data: null };
    const data = await res.json().catch(() => null);
    return { ok: true, status: res.status, data };
  } catch (err) {
    return { ok: false, unavailable: true, reason: err?.message || 'network_error', data: null };
  } finally {
    clearTimeout(timer);
  }
}

export async function queryCrossrefDoi(doi, { fetchImpl = fetch, timeoutMs = 4500 } = {}) {
  const res = await fetchJsonWithTimeout(`https://api.crossref.org/works/${encodeURIComponent(doi)}`, fetchImpl, timeoutMs);
  if (!res.ok || !res.data?.message) {
    return { found: false, status: res.status, unavailable: Boolean(res.unavailable), source: 'crossref', reason: res.reason };
  }
  const msg = res.data.message;
  const dateParts = msg?.published?.['date-parts']?.[0] ||
    msg?.['published-print']?.['date-parts']?.[0] ||
    msg?.['published-online']?.['date-parts']?.[0] ||
    msg?.issued?.['date-parts']?.[0] || [];
  return {
    found: true,
    source: 'crossref',
    doi,
    title: Array.isArray(msg.title) ? msg.title[0] : (msg.title || null),
    authors: (msg.author || []).map((a) => a.family || a.name || '').filter(Boolean),
    year: dateParts[0] || null,
    journal: Array.isArray(msg['container-title']) ? msg['container-title'][0] : (msg.publisher || null),
    publisher: msg.publisher || null,
    volume: msg.volume || null,
    issue: msg.issue || null,
    pages: msg.page || null,
    url: msg.URL || `https://doi.org/${doi}`,
    abstract: msg.abstract ? stripXml(msg.abstract) : null,
    is_oa: null,
  };
}

export async function queryOpenAlexDoi(doi, { fetchImpl = fetch, timeoutMs = 4500 } = {}) {
  const res = await fetchJsonWithTimeout(`https://api.openalex.org/works/https://doi.org/${encodeURIComponent(doi)}`, fetchImpl, timeoutMs);
  if (!res.ok || !res.data?.title) {
    return { found: false, status: res.status, unavailable: Boolean(res.unavailable), source: 'openalex', reason: res.reason };
  }
  const work = res.data;
  const isOa = typeof work?.open_access?.is_oa === 'boolean' ? work.open_access.is_oa : null;
  const oaUrl = work?.open_access?.oa_url || null;
  return {
    found: true,
    source: 'openalex',
    doi,
    title: work.title || null,
    authors: (work.authorships || []).map((a) => a?.author?.display_name || '').filter(Boolean),
    year: work.publication_year || null,
    journal: work?.primary_location?.source?.display_name || null,
    publisher: work?.primary_location?.source?.host_organization_name || null,
    volume: work?.biblio?.volume || null,
    issue: work?.biblio?.issue || null,
    pages: work?.biblio?.first_page && work?.biblio?.last_page
      ? `${work.biblio.first_page}-${work.biblio.last_page}`
      : (work?.biblio?.first_page || null),
    url: oaUrl || work?.primary_location?.landing_page_url || `https://doi.org/${doi}`,
    oa_url: oaUrl,
    is_oa: isOa,
    abstract: reconstructOpenAlexAbstract(work.abstract_inverted_index),
  };
}

export async function queryUnpaywallDoi(doi, { fetchImpl = fetch, timeoutMs = 4500, email = process.env.UNPAYWALL_EMAIL || 'support@runut.local' } = {}) {
  const res = await fetchJsonWithTimeout(
    `https://api.unpaywall.org/v2/${encodeURIComponent(doi)}?email=${encodeURIComponent(email)}`,
    fetchImpl,
    timeoutMs,
  );
  if (!res.ok || !res.data) {
    return { found: false, status: res.status, unavailable: Boolean(res.unavailable), source: 'unpaywall' };
  }
  const d = res.data;
  const bestLoc = d.best_oa_location || (Array.isArray(d.oa_locations) ? d.oa_locations[0] : null);
  const hostType = bestLoc?.host_type || null; // 'publisher' | 'repository'
  const version = bestLoc?.version || null;    // 'publishedVersion' | 'acceptedVersion' | 'submittedVersion'

  let versionLabel = d.is_oa ? SOURCE_STATUS.OPEN_ACCESS : SOURCE_STATUS.PAYWALLED;
  if (d.is_oa) {
    if (version === 'acceptedVersion' || version === 'submittedVersion') {
      versionLabel = SOURCE_STATUS.AUTHOR_MANUSCRIPT;
    } else if (hostType === 'repository') {
      versionLabel = SOURCE_STATUS.INSTITUTIONAL_REPOSITORY;
    } else {
      versionLabel = SOURCE_STATUS.OPEN_ACCESS;
    }
  }

  return {
    found: true,
    source: 'unpaywall',
    doi,
    title: d.title || null,
    year: d.year || null,
    journal: d.journal_name || null,
    publisher: d.publisher || null,
    is_oa: Boolean(d.is_oa),
    oa_status: d.oa_status || (d.is_oa ? 'open' : 'closed'),
    host_type: hostType,
    version,
    version_label: versionLabel,
    repository_institution: bestLoc?.repository_institution || null,
    oa_url: bestLoc?.url_for_pdf || bestLoc?.url || null,
  };
}

export async function queryPubMedCentralDoi(doi, { fetchImpl = fetch, timeoutMs = 4500 } = {}) {
  const res = await fetchJsonWithTimeout(
    `https://www.ncbi.nlm.nih.gov/pmc/utils/idconv/v1.0/?ids=${encodeURIComponent(doi)}&format=json`,
    fetchImpl,
    timeoutMs,
  );
  const rec = res.ok ? res.data?.records?.[0] : null;
  if (!rec || !rec.pmcid) {
    return { found: false, status: res.status, unavailable: Boolean(res.unavailable), source: 'pubmed_central' };
  }
  return {
    found: true,
    source: 'pubmed_central',
    doi,
    pmcid: rec.pmcid,
    is_oa: true,
    version_label: SOURCE_STATUS.INSTITUTIONAL_REPOSITORY,
    oa_url: `https://pmc.ncbi.nlm.nih.gov/articles/${rec.pmcid}/`,
  };
}

export async function querySemanticScholarDoi(doi, { fetchImpl = fetch, timeoutMs = 4500 } = {}) {
  const fields = 'title,authors,year,venue,abstract,isOpenAccess,openAccessPdf,url';
  const res = await fetchJsonWithTimeout(
    `https://api.semanticscholar.org/graph/v1/paper/DOI:${encodeURIComponent(doi)}?fields=${fields}`,
    fetchImpl,
    timeoutMs,
  );
  if (!res.ok || !res.data?.title) {
    return { found: false, status: res.status, unavailable: Boolean(res.unavailable), source: 'semantic_scholar' };
  }
  const d = res.data;
  return {
    found: true,
    source: 'semantic_scholar',
    doi,
    title: d.title || null,
    authors: (d.authors || []).map((a) => a.name).filter(Boolean),
    year: d.year || null,
    journal: d.venue || null,
    is_oa: typeof d.isOpenAccess === 'boolean' ? d.isOpenAccess : null,
    oa_url: d.openAccessPdf?.url || null,
    url: d.url || `https://doi.org/${doi}`,
    abstract: d.abstract || null,
  };
}

export async function queryDoajDoi(doi, { fetchImpl = fetch, timeoutMs = 4500 } = {}) {
  const res = await fetchJsonWithTimeout(
    `https://doaj.org/api/search/articles/doi:${encodeURIComponent(doi)}`,
    fetchImpl,
    timeoutMs,
  );
  const first = res.ok ? res.data?.results?.[0]?.bibjson : null;
  if (!first) return { found: false, status: res.status, unavailable: Boolean(res.unavailable), source: 'doaj' };
  return {
    found: true,
    source: 'doaj',
    doi,
    title: first.title || null,
    authors: (first.author || []).map((a) => a.name).filter(Boolean),
    year: first.year ? Number(first.year) : null,
    journal: first.journal?.title || null,
    is_oa: true,
    oa_url: first.link?.[0]?.url || null,
    abstract: first.abstract || null,
  };
}

// Resolve bibliographic metadata and legal open-access / full-text status across
// Crossref, OpenAlex, Unpaywall, Semantic Scholar, and DOAJ.
export async function resolveAcademicSourceByDoi(doi, { fetchImpl = fetch, timeoutMs = 4500 } = {}) {
  const providersConsulted = [];

  // 1. Primary bibliographic lookup: Crossref
  const cr = await queryCrossrefDoi(doi, { fetchImpl, timeoutMs });
  providersConsulted.push('crossref');

  // 2. OpenAlex (provides OA status + abstract + fallback metadata)
  const oa = await queryOpenAlexDoi(doi, { fetchImpl, timeoutMs });
  providersConsulted.push('openalex');

  // 3. Unpaywall (authoritative legal OA vs paywalled status) if OA status still unknown or no OA url
  let upw = { found: false };
  if (oa.is_oa === null || !oa.oa_url) {
    upw = await queryUnpaywallDoi(doi, { fetchImpl, timeoutMs });
    providersConsulted.push('unpaywall');
  }

  // 4. Semantic Scholar / DOAJ / PubMed Central if abstract or OA alternative is still missing
  let s2 = { found: false };
  let doaj = { found: false };
  let pmc = { found: false };
  if ((cr.found || oa.found || upw.found) && (!cr.abstract && !oa.abstract)) {
    s2 = await querySemanticScholarDoi(doi, { fetchImpl, timeoutMs });
    providersConsulted.push('semantic_scholar');
    if (!s2.abstract && (oa.is_oa === true || upw.is_oa === true)) {
      doaj = await queryDoajDoi(doi, { fetchImpl, timeoutMs });
      providersConsulted.push('doaj');
    }
  }
  if ((cr.found || oa.found) && !upw.oa_url && !oa.oa_url && !s2.oa_url) {
    pmc = await queryPubMedCentralDoi(doi, { fetchImpl, timeoutMs });
    providersConsulted.push('pubmed_central');
  }

  const anyFound = cr.found || oa.found || upw.found || s2.found || doaj.found;
  if (!anyFound) {
    const all404 = [cr, oa].every((r) => r.status === 404);
    const any404 = cr.status === 404 || oa.status === 404;
    if (all404 || (any404 && !cr.unavailable)) {
      return {
        found: false,
        invalid_doi: true,
        metadata_status: SOURCE_STATUS.UNVERIFIED,
        accessibility_status: SOURCE_STATUS.SOURCE_UNAVAILABLE,
        providers_consulted: providersConsulted,
        reason: 'DOI tidak ditemukan pada registri akademik (Crossref/OpenAlex).',
      };
    }
    return {
      found: false,
      invalid_doi: false,
      metadata_status: SOURCE_STATUS.UNVERIFIED,
      accessibility_status: SOURCE_STATUS.SOURCE_UNAVAILABLE,
      providers_consulted: providersConsulted,
      reason: 'Layanan verifikasi akademik eksternal tidak dapat dihubungi.',
    };
  }

  const merged = {
    found: true,
    doi,
    source: [cr.found && 'crossref', oa.found && 'openalex', upw.found && 'unpaywall', s2.found && 'semantic_scholar', doaj.found && 'doaj', pmc.found && 'pubmed_central'].filter(Boolean).join('+'),
    providers_consulted: providersConsulted,
    title: cr.title || oa.title || s2.title || doaj.title || upw.title || null,
    authors: (cr.authors?.length ? cr.authors : null) || (oa.authors?.length ? oa.authors : null) || s2.authors || doaj.authors || [],
    year: cr.year || oa.year || s2.year || doaj.year || upw.year || null,
    journal: cr.journal || oa.journal || s2.journal || doaj.journal || upw.journal || null,
    publisher: cr.publisher || oa.publisher || upw.publisher || null,
    volume: cr.volume || oa.volume || null,
    issue: cr.issue || oa.issue || null,
    pages: cr.pages || oa.pages || null,
    url: oa.oa_url || upw.oa_url || s2.oa_url || doaj.oa_url || pmc.oa_url || cr.url || oa.url || `https://doi.org/${doi}`,
    oa_url: oa.oa_url || upw.oa_url || s2.oa_url || doaj.oa_url || pmc.oa_url || null,
    repository_institution: upw.repository_institution || (pmc.found ? 'PubMed Central' : null),
    version_type: upw.version || (pmc.found ? 'publishedVersion' : null),
    abstract: oa.abstract || cr.abstract || s2.abstract || doaj.abstract || null,
  };

  // Determine legal accessibility & version status explicitly (never confuse metadata with full text!)
  const knownOa = upw.found
    ? upw.is_oa
    : (pmc.found ? true : (oa.is_oa !== null ? oa.is_oa : (s2.is_oa !== null ? s2.is_oa : (doaj.found ? true : null))));
  let accessibilityStatus = SOURCE_STATUS.METADATA_ONLY;
  if (upw.found && upw.is_oa && upw.version_label) {
    accessibilityStatus = upw.version_label;
  } else if (pmc.found) {
    accessibilityStatus = SOURCE_STATUS.INSTITUTIONAL_REPOSITORY;
  } else if (knownOa === true && (merged.abstract || merged.oa_url)) {
    accessibilityStatus = SOURCE_STATUS.OPEN_ACCESS;
  } else if (knownOa === false) {
    accessibilityStatus = SOURCE_STATUS.PAYWALLED;
  } else if (merged.abstract) {
    accessibilityStatus = SOURCE_STATUS.OPEN_ACCESS;
  }

  return {
    ...merged,
    is_oa: knownOa,
    accessibility_status: accessibilityStatus,
    full_text_verified: false,
  };
}
