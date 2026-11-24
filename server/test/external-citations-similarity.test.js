import test from 'node:test';
import assert from 'node:assert/strict';
import { validateCitations } from '../src/services/citations.js';
import {
  analyzeSimilarity,
  fetchAccessibleExternalSources,
} from '../src/services/similarity.js';

function jsonRes(status, data) {
  return {
    ok: status >= 200 && status < 300,
    status,
    async json() { return data; },
  };
}

test('External Citation Verification: valid DOI, invalid DOI, unavailable DOI, year mismatch, author mismatch, duplicates, and missing references', async () => {
  const doc = [
    'Pendahuluan mengacu pada Santoso (2021), Rahman (2024), dan Wijaya (2020) serta sumber hilang Kusuma (2022).',
    '',
    'Daftar Pustaka',
    'Santoso, B. (2021). Natural Language Analysis. Journal of Computing, 10(2), 45-60. https://doi.org/10.1000/valid-doi',
    'Santoso, B. (2021). Natural Language Analysis. Journal of Computing, 10(2), 45-60. https://doi.org/10.1000/valid-doi',
    'Rahman, A. (2024). Deep Document Layout. IEEE Access, 5(1), 10-20. https://doi.org/10.1000/wrong-year',
    'Wijaya, C. (2020). Broken Reference Study. Tech Press. https://doi.org/10.1000/invalid-doi',
    'Putri, D. (2019). Offline Source Paper. Academic Press. https://doi.org/10.1000/offline-doi',
  ].join('\n');

  const mockFetch = async (url) => {
    if (url.includes('10.1000%2Fvalid-doi')) {
      return jsonRes(200, {
        message: {
          title: ['Natural Language Analysis'],
          author: [{ family: 'Santoso' }],
          published: { 'date-parts': [[2021]] },
          'container-title': ['Journal of Computing'],
          volume: '10',
          page: '45-60',
          URL: 'https://doi.org/10.1000/valid-doi',
          abstract: '<p>Natural language analysis improves academic writing consistency across Indonesian manuscripts.</p>',
        },
      });
    }
    if (url.includes('10.1000%2Fwrong-year')) {
      return jsonRes(200, {
        message: {
          title: ['Deep Document Layout'],
          author: [{ family: 'DifferentAuthor' }],
          published: { 'date-parts': [[2022]] }, // Year mismatch (entry says 2024) + Author mismatch!
          'container-title': ['IEEE Access'],
        },
      });
    }
    if (url.includes('10.1000%2Finvalid-doi')) {
      return jsonRes(404, {});
    }
    if (url.includes('10.1000%2Foffline-doi')) {
      throw new Error('ECONNREFUSED');
    }
    return jsonRes(404, {});
  };

  const report = await validateCitations(doc, { verifyExternal: true, fetchImpl: mockFetch });

  assert.equal(report.missing_references.length, 1);
  assert.match(report.missing_references[0].citation, /Kusuma/);
  assert.equal(report.duplicate_references.length, 1);
  assert.equal(report.unused_references.length, 1);
  assert.match(report.unused_references[0].entry, /Putri/);

  const validCheck = report.doi_checks.find((d) => d.doi === '10.1000/valid-doi');
  assert.equal(validCheck.status, 'verified');
  assert.ok(validCheck.verified_fields.includes('year'));
  assert.ok(validCheck.verified_fields.includes('author'));
  assert.ok(validCheck.abstract.includes('Natural language analysis'));

  const mismatchCheck = report.doi_checks.find((d) => d.doi === '10.1000/wrong-year');
  assert.equal(mismatchCheck.status, 'metadata_mismatch');
  assert.ok(mismatchCheck.mismatches.some((m) => m.field === 'year'));
  assert.ok(mismatchCheck.mismatches.some((m) => m.field === 'author'));

  const invalidCheck = report.doi_checks.find((d) => d.doi === '10.1000/invalid-doi');
  assert.equal(invalidCheck.status, 'invalid_doi');

  const offlineCheck = report.doi_checks.find((d) => d.doi === '10.1000/offline-doi');
  assert.equal(offlineCheck.status, 'source_unavailable');
});

test('External Similarity Analysis: fetches OpenAlex open-access abstracts and compares with user references honestly', async () => {
  const mockFetch = async (url) => {
    if (url.includes('api.openalex.org/works?search=')) {
      return jsonRes(200, {
        results: [
          {
            title: 'Open Access Study on Transformer Models',
            doi: 'https://doi.org/10.5555/oa.2024.01',
            open_access: { oa_url: 'https://example.org/oa-paper.pdf' },
            abstract_inverted_index: {
              Transformer: [0],
              architectures: [1],
              significantly: [2],
              improve: [3],
              academic: [4],
              document: [5],
              classification: [6],
              accuracy: [7],
              across: [8],
              multilingual: [9],
              corpora: [10],
            },
          },
        ],
      });
    }
    return jsonRes(404, {});
  };

  const docText = [
    'This study aims to evaluate document processing pipelines.',
    'Transformer architectures significantly improve academic document classification accuracy across multilingual corpora.',
    '"Transformer architectures significantly improve academic document classification accuracy across multilingual corpora" (Smith, 2024).',
  ].join('\n\n');

  const externalSources = await fetchAccessibleExternalSources(docText, { fetchImpl: mockFetch });
  assert.equal(externalSources.length, 1);
  assert.equal(externalSources[0].doi, '10.5555/oa.2024.01');
  assert.equal(externalSources[0].url, 'https://example.org/oa-paper.pdf');

  const simReport = analyzeSimilarity(docText, { externalSources });
  assert.equal(simReport.corpus_compared, 'accessible_external_sources');
  assert.equal(simReport.external_source_count, 1);
  assert.ok(simReport.corpus_similarity_percent > 0);
  assert.ok(simReport.calculation_method.includes('Persentase kalimat'));
  assert.match(simReport.scope_note, /OpenAlex\/Crossref/);
  assert.match(simReport.scope_note, /Turnitin|iThenticate/);

  const unattributed = simReport.findings.find((f) => f.category === 'unattributed_overlap');
  assert.ok(unattributed);
  assert.equal(unattributed.source_doi, '10.5555/oa.2024.01');
  assert.equal(unattributed.source_url, 'https://example.org/oa-paper.pdf');

  const quoted = simReport.findings.find((f) => f.category === 'direct_quotation');
  assert.ok(quoted);
  assert.equal(quoted.citation_status, 'properly_cited');
});
