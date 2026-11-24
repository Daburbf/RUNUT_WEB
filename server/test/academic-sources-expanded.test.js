import test from 'node:test';
import assert from 'node:assert/strict';
import { validateCitations } from '../src/services/citations.js';
import { analyzeSimilarity } from '../src/services/similarity.js';
import { SOURCE_STATUS } from '../src/services/academicSources.js';

function jsonRes(status, data) {
  return {
    ok: status >= 200 && status < 300,
    status,
    async json() { return data; },
  };
}

test('Expanded Academic Sources: distinguishes Open Access, Paywalled, Metadata Only, Invalid DOI, and Source Unavailable', async () => {
  const doc = [
    'Penelitian ini mengacu pada Santoso (2022), Wijaya (2023), Rahman (2021), Putri (2020), dan Kusuma (2019).',
    '',
    'Daftar Pustaka',
    'Santoso, B. (2022). Open Access NLP Study. Open Journal, 4(1), 1-15. https://doi.org/10.1000/oa-paper',
    'Wijaya, A. (2023). Subscription Only Paper. Closed Journal, 8(2), 20-35. https://doi.org/10.1000/paywalled-paper',
    'Rahman, C. (2021). Semantic Scholar Abstract Study. AI Review, 3(1), 10-18. https://doi.org/10.1000/s2-paper',
    'Putri, D. (2020). Invalid DOI Entry. Journal X. https://doi.org/10.1000/does-not-exist',
    'Kusuma, E. (2019). Network Down Entry. Journal Y. https://doi.org/10.1000/network-down',
  ].join('\n');

  const mockFetch = async (url) => {
    // 1. Open Access paper (Crossref + OpenAlex OA + abstract)
    if (url.includes('oa-paper')) {
      if (url.includes('crossref.org')) {
        return jsonRes(200, {
          message: {
            title: ['Open Access NLP Study'],
            author: [{ family: 'Santoso' }],
            published: { 'date-parts': [[2022]] },
            'container-title': ['Open Journal'],
          },
        });
      }
      if (url.includes('openalex.org')) {
        return jsonRes(200, {
          title: 'Open Access NLP Study',
          publication_year: 2022,
          open_access: { is_oa: true, oa_url: 'https://openjournal.org/paper.pdf' },
          abstract_inverted_index: { Open: [0], access: [1], academic: [2], writing: [3], corpus: [4], study: [5] },
        });
      }
      return jsonRes(404, {});
    }

    // 2. Paywalled paper (Crossref metadata exists, Unpaywall reports is_oa: false)
    if (url.includes('paywalled-paper')) {
      if (url.includes('crossref.org')) {
        return jsonRes(200, {
          message: {
            title: ['Subscription Only Paper'],
            author: [{ family: 'Wijaya' }],
            published: { 'date-parts': [[2023]] },
            'container-title': ['Closed Journal'],
          },
        });
      }
      if (url.includes('unpaywall.org')) {
        return jsonRes(200, { title: 'Subscription Only Paper', is_oa: false, oa_status: 'closed' });
      }
      return jsonRes(404, {});
    }

    // 3. Semantic Scholar fallback provides abstract when Crossref/OpenAlex lack it
    if (url.includes('s2-paper')) {
      if (url.includes('crossref.org')) {
        return jsonRes(200, {
          message: {
            title: ['Semantic Scholar Abstract Study'],
            author: [{ family: 'Rahman' }],
            published: { 'date-parts': [[2021]] },
          },
        });
      }
      if (url.includes('semanticscholar.org')) {
        return jsonRes(200, {
          title: 'Semantic Scholar Abstract Study',
          authors: [{ name: 'C. Rahman' }],
          year: 2021,
          isOpenAccess: true,
          openAccessPdf: { url: 'https://s2.org/paper.pdf' },
          abstract: 'Semantic Scholar provides legal open access abstracts for academic verification.',
        });
      }
      return jsonRes(404, {});
    }

    // 4. Invalid DOI
    if (url.includes('does-not-exist')) {
      return jsonRes(404, {});
    }

    // 5. Network down
    if (url.includes('network-down')) {
      throw new Error('ECONNREFUSED');
    }

    return jsonRes(404, {});
  };

  const report = await validateCitations(doc, { verifyExternal: true, fetchImpl: mockFetch });

  const oa = report.doi_checks.find((d) => d.doi === '10.1000/oa-paper');
  assert.equal(oa.metadata_status, SOURCE_STATUS.METADATA_VERIFIED);
  assert.equal(oa.accessibility_status, SOURCE_STATUS.OPEN_ACCESS);
  assert.equal(oa.oa_url, 'https://openjournal.org/paper.pdf');

  const paywalled = report.doi_checks.find((d) => d.doi === '10.1000/paywalled-paper');
  assert.equal(paywalled.metadata_status, SOURCE_STATUS.METADATA_VERIFIED);
  assert.equal(paywalled.accessibility_status, SOURCE_STATUS.PAYWALLED);
  assert.match(paywalled.claim_support_note, /paywall/i);

  const s2 = report.doi_checks.find((d) => d.doi === '10.1000/s2-paper');
  assert.equal(s2.accessibility_status, SOURCE_STATUS.OPEN_ACCESS);
  assert.ok(s2.abstract.includes('Semantic Scholar'));

  const invalid = report.doi_checks.find((d) => d.doi === '10.1000/does-not-exist');
  assert.equal(invalid.status, 'invalid_doi');
  assert.equal(invalid.metadata_status, SOURCE_STATUS.UNVERIFIED);

  const offline = report.doi_checks.find((d) => d.doi === '10.1000/network-down');
  assert.equal(offline.status, 'source_unavailable');
  assert.equal(offline.accessibility_status, SOURCE_STATUS.SOURCE_UNAVAILABLE);

  // Similarity check using user-provided source + accessible external abstract
  const sim = analyzeSimilarity(
    'Semantic Scholar provides legal open access abstracts for academic verification.\n\n"Open access academic writing corpus study" (Santoso, 2022).',
    {
      referenceTexts: [{ title: 'User Ref', author: 'Author X', year: 2024, text: 'Some unrelated user reference content for testing corpus.' }],
      externalSources: report.accessible_sources,
    },
  );
  const match = sim.findings.find((f) => f.source_doi === '10.1000/s2-paper');
  assert.ok(match);
  assert.equal(match.source_accessibility_status, SOURCE_STATUS.OPEN_ACCESS);
  assert.equal(match.citation_status, 'missing_citation');
});
