// Comprehensive Regression Tests for:
// 1. Free Multi-Model AI Registry, Zero-Cost Enforcement, Rate-Limit Cooldowns,
//    Daily Quota Reset Recovery, Privacy Gating, and Error Handling.
// 2. Strict Original Document Template Preservation (DOCX complex fixtures,
//    PDF editable/AcroForm/scanned fail-closed, Structural Fingerprinting,
//    and End-to-End 3-Stage Pipeline).

import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import JSZip from 'jszip';
import { PDFDocument, StandardFonts, rgb } from 'pdf-lib';
import {
  callStructuredAi,
  reviseDocumentBlocksWithAi,
  validateBlockReplacementsWithAi,
  AiError,
  DEFAULT_OPENROUTER_PRIMARY_MODEL,
  DEFAULT_OPENROUTER_FALLBACK_1,
  DEFAULT_OPENROUTER_FALLBACK_2,
  DEFAULT_OPENROUTER_DYNAMIC_MODEL,
  OPTIONAL_OPENROUTER_NEMOTRON_MODEL,
  DEFAULT_GEMINI_MODEL,
} from '../src/services/aiProvider.js';
import {
  seedOpenRouterCatalogForTest,
  resetOpenRouterCatalogCache,
  getFreeModelRegistrySnapshot,
} from '../src/services/aiModelRegistry.js';
import {
  resetAiUsageForTest,
  recordRateLimitState,
  isProviderInCooldown,
  getAiUsageSnapshot,
} from '../src/services/aiQuota.js';
import {
  extractDocumentTemplateManifest,
  validateReplacementMap,
  computeDocxStructuralFingerprint,
  compareDocxStructuralFingerprints,
  executeTemplatePreservation,
} from '../src/services/templatePreservationEngine.js';

function sha256(buf) {
  return createHash('sha256').update(buf).digest('hex');
}

function okJson(model, contentObj) {
  return {
    ok: true,
    status: 200,
    headers: new Headers({ 'x-ratelimit-remaining-requests': '42' }),
    json: async () => ({
      model,
      choices: [{ finish_reason: 'stop', message: { content: JSON.stringify(contentObj) } }],
      usage: { prompt_tokens: 100, completion_tokens: 40, total_tokens: 140 },
    }),
  };
}

// Build a rich DOCX fixture containing logo/media, header, footer, page numbering,
// multiple sections, styles, numbering, mixed bold/italic runs, hyperlinks, tables
// with merged cells & header row, footnotes, endnotes, bookmarks, text box, margins,
// page borders, protected placeholder, citation, and bibliography.
async function buildComplexTemplateDocx() {
  const zip = new JSZip();

  zip.file('[Content_Types].xml', `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">
  <Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>
  <Default Extension="xml" ContentType="application/xml"/>
  <Default Extension="png" ContentType="image/png"/>
  <Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/>
  <Override PartName="/word/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.styles+xml"/>
  <Override PartName="/word/numbering.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.numbering+xml"/>
  <Override PartName="/word/settings.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.settings+xml"/>
  <Override PartName="/word/header1.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.header+xml"/>
  <Override PartName="/word/footer1.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.footer+xml"/>
  <Override PartName="/word/footnotes.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.footnotes+xml"/>
  <Override PartName="/word/endnotes.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.endnotes+xml"/>
</Types>`);

  zip.file('_rels/.rels', `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
  <Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/>
</Relationships>`);

  zip.file('word/_rels/document.xml.rels', `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
  <Relationship Id="rIdStyles" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/>
  <Relationship Id="rIdNum" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/numbering" Target="numbering.xml"/>
  <Relationship Id="rIdHeader" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/header" Target="header1.xml"/>
  <Relationship Id="rIdFooter" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/footer" Target="footer1.xml"/>
  <Relationship Id="rIdLogo" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/image" Target="media/logo.png"/>
  <Relationship Id="rIdLink1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/hyperlink" Target="https://example.org/report" TargetMode="External"/>
</Relationships>`);

  zip.file('word/styles.xml', `<?xml version="1.0" encoding="UTF-8"?><w:styles xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:style w:type="paragraph" w:styleId="Normal"><w:name w:val="Normal"/></w:style><w:style w:type="paragraph" w:styleId="Heading1"><w:name w:val="heading 1"/></w:style></w:styles>`);
  zip.file('word/numbering.xml', `<?xml version="1.0" encoding="UTF-8"?><w:numbering xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:abstractNum w:abstractNumId="0"><w:lvl w:ilvl="0"><w:numFmt w:val="decimal"/></w:lvl></w:abstractNum><w:num w:numId="1"><w:abstractNumId w:val="0"/></w:num></w:numbering>`);
  zip.file('word/settings.xml', `<?xml version="1.0" encoding="UTF-8"?><w:settings xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:zoom w:percent="100"/></w:settings>`);
  zip.file('word/theme/theme1.xml', `<?xml version="1.0" encoding="UTF-8"?><a:theme xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" name="CorporateTheme"/>`);
  zip.file('word/header1.xml', `<?xml version="1.0" encoding="UTF-8"?><w:hdr xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:p><w:r><w:t>CONFIDENTIAL REPORT HEADER - RUNUT</w:t></w:r></w:p></w:hdr>`);
  zip.file('word/footer1.xml', `<?xml version="1.0" encoding="UTF-8"?><w:ftr xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:p><w:r><w:t>Page </w:t></w:r><w:fldSimple w:instr="PAGE"/></w:p></w:ftr>`);
  zip.file('word/footnotes.xml', `<?xml version="1.0" encoding="UTF-8"?><w:footnotes xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:footnote w:id="1"><w:p><w:r><w:t>Footnote reference note.</w:t></w:r></w:p></w:footnote></w:footnotes>`);
  zip.file('word/endnotes.xml', `<?xml version="1.0" encoding="UTF-8"?><w:endnotes xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:endnote w:id="1"><w:p><w:r><w:t>Endnote reference note.</w:t></w:r></w:p></w:endnote></w:endnotes>`);
  // 1x1 PNG binary logo
  zip.file('word/media/logo.png', Buffer.from('89504e470d0a1a0a0000000d49484452000000010000000108060000001f15c4890000000a49444154789c63000100000500010d0a2db40000000049454e44ae426082', 'hex'));

  zip.file('word/document.xml', `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">
  <w:body>
    <w:p>
      <w:pPr><w:pStyle w:val="Heading1"/></w:pPr>
      <w:bookmarkStart w:id="0" w:name="IntroBookmark"/>
      <w:r><w:rPr><w:b/></w:rPr><w:t>1. Pendahuluan</w:t></w:r>
      <w:bookmarkEnd w:id="0"/>
    </w:p>
    <w:p>
      <w:pPr><w:pStyle w:val="Normal"/></w:pPr>
      <w:r><w:rPr><w:b/></w:rPr><w:t xml:space="preserve">Dalam era perkembangan teknologi saat ini, </w:t></w:r>
      <w:r><w:rPr><w:i/></w:rPr><w:t xml:space="preserve">laporan ini menyajikan analisis performa sistem </w:t></w:r>
      <w:r><w:t>(Siregar, 2024) dengan kode {{DOC_ID}}.</w:t></w:r>
    </w:p>
    <w:p>
      <w:pPr><w:numPr><w:ilvl w:val="0"/><w:numId w:val="1"/></w:numPr></w:pPr>
      <w:hyperlink r:id="rIdLink1"><w:r><w:t>Tautan referensi eksternal resmi</w:t></w:r></w:hyperlink>
    </w:p>
    <w:tbl>
      <w:tblPr><w:tblStyle w:val="TableGrid"/></w:tblPr>
      <w:tr>
        <w:trPr><w:tblHeader/></w:trPr>
        <w:tc><w:tcPr><w:gridSpan w:val="2"/></w:tcPr><w:p><w:r><w:t>Ringkasan Metrik</w:t></w:r></w:p></w:tc>
      </w:tr>
      <w:tr>
        <w:tc><w:p><w:r><w:t>Kecepatan</w:t></w:r></w:p></w:tc>
        <w:tc><w:p><w:r><w:t>Performa server meningkat sebesar 25% setelah optimasi basis data dilakukan secara bertahap.</w:t></w:r></w:p></w:tc>
      </w:tr>
    </w:tbl>
    <w:p>
      <w:pPr>
        <w:sectPr>
          <w:pgSz w:w="11906" w:h="16838"/>
          <w:pgMar w:top="1440" w:right="1440" w:bottom="1440" w:left="1440"/>
          <w:pgBorders><w:top w:val="single" w:sz="4"/></w:pgBorders>
        </w:sectPr>
      </w:pPr>
      <w:r><w:t>Bagian penutup dokumen sebelum daftar pustaka.</w:t></w:r>
    </w:p>
    <w:p>
      <w:pPr><w:pStyle w:val="Heading1"/></w:pPr>
      <w:r><w:t>Daftar Pustaka</w:t></w:r>
    </w:p>
    <w:p>
      <w:r><w:t>Siregar, A. (2024). Arsitektur Sistem Informasi Modern. Jakarta: Penerbit Ilmu.</w:t></w:r>
    </w:p>
    <w:sectPr>
      <w:headerReference w:type="default" r:id="rIdHeader"/>
      <w:footerReference w:type="default" r:id="rIdFooter"/>
      <w:pgSz w:w="11906" w:h="16838"/>
      <w:pgMar w:top="1440" w:right="1440" w:bottom="1440" w:left="1440"/>
    </w:sectPr>
  </w:body>
</w:document>`);

  return zip.generateAsync({ type: 'nodebuffer' });
}

test('Model Selection 1: OpenRouter account-level daily quota exhaustion skips remaining OpenRouter variants and jumps to Gemini Free', async () => {
  resetAiUsageForTest();
  resetOpenRouterCatalogCache();

  const called = [];
  const fetchImpl = async (url, opts) => {
    const body = JSON.parse(opts.body);
    called.push({ url, model: body.model });
    if (url.includes('openrouter.ai')) {
      return {
        ok: false,
        status: 429,
        headers: new Headers({ 'Retry-After': '3600' }),
        text: async () => 'free-models-per-day daily limit exhausted',
      };
    }
    if (url.includes('generativelanguage.googleapis.com')) {
      return okJson(DEFAULT_GEMINI_MODEL, { issues: [] });
    }
    throw new Error(`Unexpected URL: ${url}`);
  };

  const res = await callStructuredAi(
    { systemPrompt: 'sys', userPrompt: 'usr', retryBaseDelayMs: 1, fetchImpl },
    {
      STRICT_FREE_AI_ONLY: 'true',
      AI_PROVIDER: 'openrouter',
      OPENROUTER_API_KEY: 'or-key',
      GEMINI_API_KEY: 'gem-key',
      AI_MAX_PROVIDER_ATTEMPTS: '5',
    },
  );

  assert.equal(res.provider, 'gemini');
  assert.equal(res.model, DEFAULT_GEMINI_MODEL);
  // Must NOT waste requests on ERNIE/Ling/openrouter/free once OpenRouter daily account quota is exhausted
  assert.equal(called.filter((c) => c.url.includes('openrouter.ai')).length, 1);
  assert.equal(called.filter((c) => c.url.includes('generativelanguage.googleapis.com')).length, 1);
});

test('Model Selection 2: OpenRouter Free Router fallback (Particle -> ERNIE -> Ling -> openrouter/free)', async () => {
  resetAiUsageForTest();
  resetOpenRouterCatalogCache();

  const modelsTried = [];
  const fetchImpl = async (url, opts) => {
    const body = JSON.parse(opts.body);
    modelsTried.push(body.model);
    if (body.model !== DEFAULT_OPENROUTER_DYNAMIC_MODEL) {
      return { ok: false, status: 503, headers: new Headers(), text: async () => 'model temporarily offline' };
    }
    return okJson(DEFAULT_OPENROUTER_DYNAMIC_MODEL, { ok: true });
  };

  const res = await callStructuredAi(
    { systemPrompt: 'sys', userPrompt: 'usr', retryBaseDelayMs: 1, fetchImpl },
    {
      STRICT_FREE_AI_ONLY: 'true',
      AI_PROVIDER: 'openrouter',
      OPENROUTER_API_KEY: 'or-key',
      AI_MAX_PROVIDER_ATTEMPTS: '4',
    },
  );

  assert.equal(res.model, DEFAULT_OPENROUTER_DYNAMIC_MODEL);
  assert.deepEqual(modelsTried, [
    DEFAULT_OPENROUTER_PRIMARY_MODEL,
    DEFAULT_OPENROUTER_FALLBACK_1,
    DEFAULT_OPENROUTER_FALLBACK_2,
    DEFAULT_OPENROUTER_DYNAMIC_MODEL,
  ]);
});

test('Model Selection 3: Catalog price change (> 0) blocks model immediately under zero-cost policy', async () => {
  resetAiUsageForTest();
  seedOpenRouterCatalogForTest([
    { id: DEFAULT_OPENROUTER_PRIMARY_MODEL, pricing: { prompt: '0.0001', completion: '0.0002' } },
  ]);

  await assert.rejects(
    () => callStructuredAi(
      { systemPrompt: 'sys', userPrompt: 'usr', fetchImpl: async () => { throw new Error('must not call network'); } },
      { STRICT_FREE_AI_ONLY: 'true', AI_PROVIDER: 'openrouter', OPENROUTER_API_KEY: 'or-key' },
    ),
    (err) => err instanceof AiError && err.code === 'AI_PRICE_CHANGED_BLOCKED' && err.status === 503,
  );
  resetOpenRouterCatalogCache();
});

test('Model Selection 4: Cooldown recovery automatically re-enables provider once quota reset timestamp passes', () => {
  resetAiUsageForTest();
  const baseNow = Date.parse('2026-11-25T10:00:00.000Z');
  recordRateLimitState({
    provider: 'gemini',
    model: DEFAULT_GEMINI_MODEL,
    headers: new Headers({ 'Retry-After': '60' }),
    rateLimitType: 'rate_limit',
    nowMs: baseNow,
  });

  assert.equal(isProviderInCooldown('gemini', DEFAULT_GEMINI_MODEL, baseNow + 30_000).inCooldown, true);
  assert.equal(isProviderInCooldown('gemini', DEFAULT_GEMINI_MODEL, baseNow + 65_000).inCooldown, false);
});

test('Model Selection 5: Truncated output (finish_reason=length) & invalid JSON trigger failover to next free model', async () => {
  resetAiUsageForTest();
  resetOpenRouterCatalogCache();

  const tried = [];
  const fetchImpl = async (_url, opts) => {
    const body = JSON.parse(opts.body);
    tried.push(body.model);
    if (body.model === DEFAULT_OPENROUTER_PRIMARY_MODEL) {
      return {
        ok: true,
        status: 200,
        headers: new Headers(),
        json: async () => ({ choices: [{ finish_reason: 'length', message: { content: '{"partial":' } }] }),
      };
    }
    if (body.model === DEFAULT_OPENROUTER_FALLBACK_1) {
      return {
        ok: true,
        status: 200,
        headers: new Headers(),
        json: async () => ({ choices: [{ finish_reason: 'stop', message: { content: 'NOT JSON AT ALL' } }] }),
      };
    }
    return okJson(DEFAULT_OPENROUTER_FALLBACK_2, { recovered: true });
  };

  const res = await callStructuredAi(
    { systemPrompt: 'sys', userPrompt: 'usr', retryBaseDelayMs: 1, fetchImpl },
    { STRICT_FREE_AI_ONLY: 'true', AI_PROVIDER: 'openrouter', OPENROUTER_API_KEY: 'or-key', AI_MAX_PROVIDER_ATTEMPTS: '4' },
  );

  assert.equal(res.model, DEFAULT_OPENROUTER_FALLBACK_2);
  assert.deepEqual(res.parsed, { recovered: true });
  assert.equal(tried.length, 3);
});

test('Model Selection 6: Privacy gating blocks confidential documents from Nemotron & unconsented Gemini Free', async () => {
  resetAiUsageForTest();
  resetOpenRouterCatalogCache();

  // Confidential document with ONLY Gemini configured & no user consent -> blocked
  await assert.rejects(
    () => callStructuredAi(
      {
        systemPrompt: 'sys',
        userPrompt: 'usr',
        confidential: true,
        userConsentForFreeTier: false,
        fetchImpl: async () => { throw new Error('must not call network'); },
      },
      { STRICT_FREE_AI_ONLY: 'true', AI_PROVIDER: 'gemini', GEMINI_API_KEY: 'gem-key' },
    ),
    (err) => err instanceof AiError && err.code === 'AI_PRIVACY_NO_ELIGIBLE_PROVIDER' && err.status === 503,
  );

  // Nemotron is disabled by default and blocked for confidential documents even if enabled
  const snapshot = getFreeModelRegistrySnapshot({ ENABLE_NEMOTRON_FREE: 'false', ENABLE_GROQ_FREE: 'false' });
  assert.equal(snapshot.nemotron_enabled, false);
  assert.equal(snapshot.groq_enabled, false);
  assert.ok(snapshot.deprecated_models_blocked.some((d) => d.model === 'llama-3.3-70b-versatile'));

  await assert.rejects(
    () => callStructuredAi(
      {
        systemPrompt: 'sys',
        userPrompt: 'usr',
        confidential: true,
        fetchImpl: async () => { throw new Error('must not call network'); },
      },
      {
        STRICT_FREE_AI_ONLY: 'true',
        AI_PROVIDER: 'openrouter',
        OPENROUTER_API_KEY: 'or-key',
        OPENROUTER_PRIMARY_MODEL: OPTIONAL_OPENROUTER_NEMOTRON_MODEL,
        AI_FAILOVER_ENABLED: 'false',
      },
    ),
    (err) => err instanceof AiError && err.code === 'AI_PRIVACY_NO_ELIGIBLE_PROVIDER',
  );

  // Dynamic openrouter/free router must ALSO be blocked for confidential documents
  await assert.rejects(
    () => callStructuredAi(
      {
        systemPrompt: 'sys',
        userPrompt: 'usr',
        confidential: true,
        fetchImpl: async () => { throw new Error('must not call network'); },
      },
      {
        STRICT_FREE_AI_ONLY: 'true',
        AI_PROVIDER: 'openrouter',
        OPENROUTER_API_KEY: 'or-key',
        OPENROUTER_PRIMARY_MODEL: DEFAULT_OPENROUTER_DYNAMIC_MODEL,
        AI_FAILOVER_ENABLED: 'false',
      },
    ),
    (err) => err instanceof AiError && err.code === 'AI_PRIVACY_NO_ELIGIBLE_PROVIDER',
  );
});

test('DOCX Template Preservation + End-to-End 3-Stage Pipeline (Particle -> ERNIE -> Ling -> Validate -> Apply)', async () => {
  resetAiUsageForTest();
  resetOpenRouterCatalogCache();

  const origBuf = await buildComplexTemplateDocx();
  const origSha = sha256(origBuf);

  // 1. Extract manifest
  const manifest = await extractDocumentTemplateManifest(origBuf, { documentId: 'doc-e2e', format: 'docx' });
  const editableBlocks = manifest.blocks.filter((b) => b.editable);
  const protectedBlocks = manifest.blocks.filter((b) => !b.editable);

  assert.ok(editableBlocks.length >= 2);
  assert.ok(protectedBlocks.some((b) => b.protection_reason === 'bibliography'), 'Bibliography must be protected');
  assert.ok(protectedBlocks.some((b) => b.protection_reason === 'table_header'), 'Table header row must be protected');

  const targetBlock = editableBlocks.find((b) => b.original_text.includes('Dalam era perkembangan teknologi'));
  assert.ok(targetBlock, 'Editable body paragraph with citation and placeholder must be found');

  // 2. Stage A: Simulate Particle 429 -> ERNIE 503 -> Ling 200 OK
  const stageAModels = [];
  const stageAFetch = async (_url, opts) => {
    const body = JSON.parse(opts.body);
    stageAModels.push(body.model);
    if (body.model === DEFAULT_OPENROUTER_PRIMARY_MODEL) {
      return { ok: false, status: 503, headers: new Headers(), text: async () => 'particle overloaded' };
    }
    if (body.model === DEFAULT_OPENROUTER_FALLBACK_1) {
      return { ok: false, status: 503, headers: new Headers(), text: async () => 'ernie unavailable' };
    }
    return okJson(DEFAULT_OPENROUTER_FALLBACK_2, {
      document_id: 'doc-e2e',
      language: 'id',
      replacements: [{
        block_id: targetBlock.block_id,
        revised_text: 'Saat ini, laporan ini menyajikan analisis performa sistem (Siregar, 2024) dengan kode {{DOC_ID}}.',
      }],
    });
  };

  const env = {
    STRICT_FREE_AI_ONLY: 'true',
    AI_PROVIDER: 'openrouter',
    OPENROUTER_API_KEY: 'or-key',
    GEMINI_API_KEY: 'gem-key',
    AI_MAX_PROVIDER_ATTEMPTS: '5',
  };

  const stageA = await reviseDocumentBlocksWithAi({
    documentId: 'doc-e2e',
    language: 'id',
    blocks: [targetBlock],
    fetchImpl: stageAFetch,
    retryBaseDelayMs: 1,
  }, env);

  assert.equal(stageA.model, DEFAULT_OPENROUTER_FALLBACK_2);
  assert.deepEqual(stageAModels, [
    DEFAULT_OPENROUTER_PRIMARY_MODEL,
    DEFAULT_OPENROUTER_FALLBACK_1,
    DEFAULT_OPENROUTER_FALLBACK_2,
  ]);

  // 3. Stage B: Gemini validates replacement map
  const stageBFetch = async (url) => {
    assert.match(url, /generativelanguage\.googleapis\.com/);
    return okJson(DEFAULT_GEMINI_MODEL, {
      valid: true,
      missing_block_ids: [],
      duplicate_block_ids: [],
      unknown_block_ids: [],
      issues: [],
    });
  };
  const stageB = await validateBlockReplacementsWithAi({
    documentId: 'doc-e2e',
    manifestBlocks: [targetBlock],
    replacements: stageA.replacements,
    fetchImpl: stageBFetch,
    retryBaseDelayMs: 1,
  }, env);
  assert.equal(stageB.provider, 'gemini');
  assert.equal(stageB.validation.valid, true);

  // 4. Stage C: Deterministic Template Engine applies edits & verifies full structural fingerprint
  const result = await executeTemplatePreservation({
    originalBuffer: origBuf,
    format: 'docx',
    documentId: 'doc-e2e',
    replacements: stageA.replacements,
  });

  assert.equal(result.ok, true);
  assert.equal(result.applied_count, 1);
  assert.equal(result.original_immutable_verified, true);
  assert.equal(sha256(origBuf), origSha, 'Original uploaded buffer MUST remain immutable');
  assert.notEqual(result.output_sha256, result.original_sha256, 'Output hash differs because text was revised');
  assert.equal(result.fingerprint_comparison.verified, true);
  assert.equal(result.fingerprint_comparison.checks.images_media_preserved, true);
  assert.equal(result.fingerprint_comparison.checks.headers_footers_preserved, true);
  assert.equal(result.fingerprint_comparison.checks.styles_preserved, true);
  assert.equal(result.fingerprint_comparison.checks.numbering_preserved, true);
  assert.equal(result.fingerprint_comparison.checks.table_dimensions_preserved, true);
  assert.equal(result.fingerprint_comparison.checks.table_cell_merges_preserved, true);
  assert.equal(result.fingerprint_comparison.checks.paragraph_properties_preserved, true);
  assert.equal(result.fingerprint_comparison.checks.run_properties_preserved, true);
  assert.equal(result.fingerprint_comparison.checks.xml_hierarchy_preserved, true);
  assert.equal(result.fingerprint_comparison.checks.notes_comments_preserved, true);
  assert.equal(result.fingerprint_comparison.checks.relationships_preserved, true);
  assert.equal(result.fingerprint_comparison.checks.sectPr_page_layout_preserved, true);
  assert.equal(result.fingerprint_comparison.checks.bookmarks_preserved, true);
  assert.equal(result.fingerprint_comparison.checks.hyperlinks_preserved, true);

  // Verify revised text actually exists in output DOCX
  const outZip = await JSZip.loadAsync(result.buffer);
  const outXml = await outZip.file('word/document.xml').async('string');
  assert.ok(outXml.includes('Saat ini,'));
  assert.ok(outXml.includes('{{DOC_ID}}'));
  assert.ok(outXml.includes('(Siregar, 2024)'));
  assert.ok(outXml.includes('Siregar, A. (2024). Arsitektur Sistem Informasi Modern.'));

  // Usage snapshot tracks requests without secrets
  const usage = getAiUsageSnapshot();
  assert.ok(usage.totals.requests >= 4);
  assert.ok(!JSON.stringify(usage).includes('or-key'));
  assert.ok(!JSON.stringify(usage).includes('gem-key'));
});

test('DOCX Template Preservation: rejects missing placeholder, missing citation, and overflowing text (with 1 repair retry)', async () => {
  const origBuf = await buildComplexTemplateDocx();
  const manifest = await extractDocumentTemplateManifest(origBuf, { documentId: 'doc-val', format: 'docx' });
  const target = manifest.blocks.find((b) => b.original_text.includes('{{DOC_ID}}'));

  const badCheck = validateReplacementMap(manifest, [
    { block_id: target.block_id, revised_text: 'Teks tanpa placeholder dan sitasi.' },
  ]);
  assert.equal(badCheck.valid, false);
  assert.equal(badCheck.rejected_blocks[0].reason, 'missing_protected_placeholder');

  // Overflow text triggers repair retry once; if still overflowing, rejects edit & preserves original
  let repairCalls = 0;
  const overflowRes = await executeTemplatePreservation({
    originalBuffer: origBuf,
    format: 'docx',
    documentId: 'doc-overflow',
    maxGrowthRatio: 1.15,
    maxRepairAttempts: 1,
    replacements: [{
      block_id: target.block_id,
      revised_text: `${target.original_text} `.repeat(5),
    }],
    repairOverflowFn: async (overflowBlocks) => {
      repairCalls += 1;
      return overflowBlocks.map((b) => ({ block_id: b.block_id, revised_text: b.revised_text }));
    },
  });

  assert.equal(repairCalls, 1);
  assert.equal(overflowRes.ok, true);
  assert.equal(overflowRes.applied_count, 0, 'Still-overflowing edit must be rejected to protect template');
  assert.equal(overflowRes.overflow_rejected_blocks.length, 1);
});

test('PDF Template Preservation: scanned PDF fails closed and preserves original immutable buffer', async () => {
  const pdfDoc = await PDFDocument.create();
  const page = pdfDoc.addPage([595, 842]);
  // Draw an image-only page (no text layer -> scanned PDF)
  const pngBytes = Buffer.from('89504e470d0a1a0a0000000d49484452000000010000000108060000001f15c4890000000a49444154789c63000100000500010d0a2db40000000049454e44ae426082', 'hex');
  const img = await pdfDoc.embedPng(pngBytes);
  page.drawImage(img, { x: 50, y: 50, width: 495, height: 742 });
  const scannedPdf = Buffer.from(await pdfDoc.save());
  const origHash = sha256(scannedPdf);

  const res = await executeTemplatePreservation({
    originalBuffer: scannedPdf,
    format: 'pdf',
    documentId: 'doc-scanned',
    issueEdits: [{ snippet: 'anything', suggestion: 'revised' }],
  });

  assert.equal(res.ok, false);
  assert.equal(res.code, 'SCANNED_PDF_UNSUPPORTED_FOR_NATIVE_EDIT');
  assert.equal(sha256(res.buffer), origHash, 'Scanned PDF original must be preserved untouched');
});

test('PDF Template Preservation: editable PDF preserves original when AcroForm/native text is inspected', async () => {
  const pdfDoc = await PDFDocument.create();
  const page = pdfDoc.addPage([595, 842]);
  const font = await pdfDoc.embedFont(StandardFonts.Helvetica);
  page.drawText('Laporan evaluasi sistem informasi tahunan.', { x: 50, y: 750, size: 12, font, color: rgb(0, 0, 0) });
  const form = pdfDoc.getForm();
  const field = form.createTextField('report_summary');
  field.setText('Ringkasan awal');
  field.addToPage(page, { x: 50, y: 680, width: 300, height: 24 });
  const editablePdf = Buffer.from(await pdfDoc.save());

  const manifest = await extractDocumentTemplateManifest(editablePdf, { documentId: 'doc-pdf-form', format: 'pdf' });
  assert.equal(manifest.source_format, 'pdf');
  assert.equal(manifest.is_scanned, false);
  assert.ok(manifest.acroform_fields.some((f) => f.name === 'report_summary'));
});
