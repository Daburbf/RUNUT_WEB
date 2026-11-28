import test, { beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import {
  analyzeWithProvider,
  getProviderInfo,
  AiError,
  DEFAULT_OPENROUTER_MODEL,
} from '../src/services/aiProvider.js';
import {
  getAiUsageSnapshot,
  resetAiUsageForTest,
  fetchOpenRouterAccountLimits,
} from '../src/services/aiQuota.js';

const SAMPLE_TEXT = 'Dalam era perkembangan teknologi saat ini, penulisan akademik memerlukan kejelasan dan ketepatan argumen yang kuat berdasarkan bukti empiris.';

function mockResponse(status, body, headers = {}) {
  const map = new Map(Object.entries(headers).map(([k, v]) => [k.toLowerCase(), String(v)]));
  return {
    ok: status >= 200 && status < 300,
    status,
    headers: { get: (k) => map.get(String(k).toLowerCase()) ?? null },
    async json() { return typeof body === 'string' ? JSON.parse(body) : body; },
    async text() { return typeof body === 'string' ? body : JSON.stringify(body); },
  };
}

function validAiPayload(text, providerNote = 'ok') {
  const snippet = 'Dalam era perkembangan teknologi saat ini';
  const start = text.indexOf(snippet);
  return {
    choices: [{
      message: {
        content: JSON.stringify({
          document_language: 'id',
          document_type: 'academic_report',
          editing_mode: 'academic_revision',
          issues: [{
            type: 'formality',
            start,
            end: start + snippet.length,
            text: snippet,
            explanation: `Frasa pembuka generik (${providerNote}).`,
            suggestion: 'Saat ini',
            needs_review: false,
          }],
          preservation_checks: {
            meaning_preserved: true,
            citations_preserved: true,
            numbers_preserved: true,
            technical_terms_preserved: true,
          },
        }),
      },
    }],
    usage: { prompt_tokens: 120, completion_tokens: 45, total_tokens: 165 },
  };
}

const baseEnv = {
  AI_PROVIDER: 'openrouter',
  OPENROUTER_API_KEY: 'sk-or-test-key',
  OPENROUTER_BASE_URL: 'https://openrouter.ai/api/v1',
  OPENROUTER_MODEL: DEFAULT_OPENROUTER_MODEL,
  GEMINI_API_KEY: 'gm-test-key',
  GEMINI_MODEL: 'gemini-3.1-flash-lite',
  AI_TIMEOUT_MS: '5000',
};

beforeEach(() => {
  resetAiUsageForTest();
});

test('AI Provider: OpenRouter Particle-1 Free successful request & usage tracking', async () => {
  resetAiUsageForTest();
  const info = getProviderInfo(baseEnv);
  assert.equal(info.provider, 'openrouter');
  assert.equal(info.model, 'particle-ai/particle-1:free');
  assert.equal(info.configured, true);
  assert.equal(info.fallback.configured, true);

  const fetchImpl = async (url) => {
    assert.ok(url.includes('openrouter.ai/api/v1/chat/completions'));
    return mockResponse(200, validAiPayload(SAMPLE_TEXT, 'openrouter'));
  };

  const out = await analyzeWithProvider(SAMPLE_TEXT, { fetchImpl, retryBaseDelayMs: 1 }, baseEnv);
  assert.equal(out.provider, 'openrouter');
  assert.equal(out.model, 'particle-ai/particle-1:free');
  assert.equal(out.fallbackUsed, false);
  assert.equal(out.parsed.issues.length, 1);

  const usage = getAiUsageSnapshot();
  assert.equal(usage.totals.requests, 1);
  assert.equal(usage.totals.successes, 1);
  assert.equal(usage.totals.fallback_activations, 0);
  assert.equal(usage.by_provider.openrouter.totalTokens, 165);
});

test('AI Provider: OpenRouter HTTP 429 triggers automatic Gemini fallback', async () => {
  resetAiUsageForTest();
  let calls = [];
  const fetchImpl = async (url) => {
    calls.push(url);
    if (url.includes('openrouter.ai')) {
      return mockResponse(429, { error: { message: 'Rate limit exceeded' } }, { 'Retry-After': '0' });
    }
    return mockResponse(200, validAiPayload(SAMPLE_TEXT, 'gemini-fallback'));
  };

  const out = await analyzeWithProvider(SAMPLE_TEXT, { fetchImpl, retryBaseDelayMs: 1 }, baseEnv);
  assert.equal(out.provider, 'gemini');
  assert.equal(out.fallbackUsed, true);
  assert.equal(out.primaryError.code, 'AI_RATE_LIMIT');
  assert.ok(calls.some((u) => u.includes('generativelanguage.googleapis.com')));
  assert.equal(getAiUsageSnapshot().totals.fallback_activations, 1);
});

test('AI Provider: OpenRouter quota exhaustion (402) immediately falls back to Gemini without retry loop', async () => {
  resetAiUsageForTest();
  let openrouterHits = 0;
  const fetchImpl = async (url) => {
    if (url.includes('openrouter.ai')) {
      openrouterHits += 1;
      return mockResponse(402, { error: { message: 'Insufficient credits / daily quota exhausted' } });
    }
    return mockResponse(200, validAiPayload(SAMPLE_TEXT, 'gemini-fallback'));
  };

  const out = await analyzeWithProvider(SAMPLE_TEXT, { fetchImpl, retryBaseDelayMs: 1 }, baseEnv);
  assert.equal(openrouterHits, 1);
  assert.equal(out.provider, 'gemini');
  assert.equal(out.fallbackUsed, true);
  assert.equal(out.primaryError.code, 'AI_QUOTA_EXHAUSTED');
});

test('AI Provider: OpenRouter HTTP 503 triggers Gemini fallback', async () => {
  const fetchImpl = async (url) => {
    if (url.includes('openrouter.ai')) return mockResponse(503, 'Service Unavailable');
    return mockResponse(200, validAiPayload(SAMPLE_TEXT, 'gemini-503'));
  };

  const out = await analyzeWithProvider(SAMPLE_TEXT, { fetchImpl, retryBaseDelayMs: 1 }, baseEnv);
  assert.equal(out.provider, 'gemini');
  assert.equal(out.fallbackUsed, true);
});

test('AI Provider: Gemini primary HTTP 503 automatically falls back to secondary Gemini free-tier model', async () => {
  resetAiUsageForTest();
  const geminiOnlyEnv = {
    AI_PROVIDER: 'gemini',
    GEMINI_API_KEY: 'gm-test-key',
    GEMINI_CONTENT_MODEL: 'gemini-3.1-flash-lite',
    AI_TIMEOUT_MS: '5000',
  };
  const info = getProviderInfo(geminiOnlyEnv);
  assert.equal(info.provider, 'gemini');
  assert.equal(info.model, 'gemini-3.1-flash-lite');
  assert.equal(info.fallback.configured, true);
  assert.equal(info.fallback.model, 'gemini-3-flash-preview');

  const triedModels = [];
  const fetchImpl = async (url, opts) => {
    if (String(url).endsWith('/models')) {
      return mockResponse(200, {
        data: [
          { id: 'models/gemini-3.1-flash-lite' },
          { id: 'models/gemini-3-flash-preview' },
        ],
      });
    }
    const body = JSON.parse(opts.body);
    triedModels.push(body.model);
    if (body.model === 'gemini-3.1-flash-lite') {
      return mockResponse(503, { error: { code: 503, message: 'This model is currently experiencing high demand.', status: 'UNAVAILABLE' } });
    }
    return mockResponse(200, validAiPayload(SAMPLE_TEXT, body.model));
  };

  const out = await analyzeWithProvider(SAMPLE_TEXT, { fetchImpl, retryBaseDelayMs: 1 }, geminiOnlyEnv);
  assert.equal(out.provider, 'gemini');
  assert.equal(out.model, 'gemini-3-flash-preview');
  assert.equal(out.fallbackUsed, true);
  assert.ok(triedModels.includes('gemini-3.1-flash-lite'));
  assert.ok(triedModels.includes('gemini-3-flash-preview'));
});

test('AI Provider: OpenRouter timeout (AbortError) triggers Gemini fallback', async () => {
  const fetchImpl = async (url) => {
    if (url.includes('openrouter.ai')) {
      const err = new Error('The operation was aborted');
      err.name = 'AbortError';
      throw err;
    }
    return mockResponse(200, validAiPayload(SAMPLE_TEXT, 'gemini-timeout'));
  };

  const out = await analyzeWithProvider(SAMPLE_TEXT, { fetchImpl, retryBaseDelayMs: 1 }, baseEnv);
  assert.equal(out.provider, 'gemini');
  assert.equal(out.fallbackUsed, true);
  assert.equal(out.primaryError.code, 'AI_TIMEOUT');
});

test('AI Provider: Both providers unavailable returns clear error', async () => {
  const fetchImpl = async () => mockResponse(503, 'Down');
  await assert.rejects(
    () => analyzeWithProvider(SAMPLE_TEXT, { fetchImpl, retryBaseDelayMs: 1 }, baseEnv),
    (err) => err instanceof AiError && /cadangan/i.test(err.message),
  );
});

test('AI Provider: Invalid API key (401) does not retry indefinitely', async () => {
  let hits = 0;
  const fetchImpl = async () => {
    hits += 1;
    return mockResponse(401, { error: 'Invalid API key' });
  };

  await assert.rejects(
    () => analyzeWithProvider(SAMPLE_TEXT, { fetchImpl, retryBaseDelayMs: 1 }, { ...baseEnv, GEMINI_API_KEY: '' }),
    (err) => err instanceof AiError && err.code === 'AI_AUTH_401',
  );
  assert.equal(hits, 1);
});

test('AI Provider: Malformed JSON is rejected with AI_BAD_JSON', async () => {
  const fetchImpl = async () => mockResponse(200, {
    choices: [{ message: { content: 'not valid json {{{' } }],
  });

  await assert.rejects(
    () => analyzeWithProvider(SAMPLE_TEXT, { fetchImpl, retryBaseDelayMs: 1 }, { ...baseEnv, GEMINI_API_KEY: '' }),
    (err) => err instanceof AiError && err.code === 'AI_BAD_JSON',
  );
});

test('AI Provider: Long AI response with multiple issues parses cleanly', async () => {
  const longText = `${SAMPLE_TEXT} `.repeat(20);
  const fetchImpl = async () => mockResponse(200, validAiPayload(longText, 'long'));
  const out = await analyzeWithProvider(longText, { fetchImpl, retryBaseDelayMs: 1 }, baseEnv);
  assert.equal(out.provider, 'openrouter');
  assert.ok(out.parsed.issues.length >= 1);
});

test('Quota Monitor: OpenRouter /key endpoint retrieves account limits and handles unavailability gracefully', async () => {
  const okRes = await fetchOpenRouterAccountLimits({
    apiKey: 'sk-or-test',
    fetchImpl: async () => mockResponse(200, {
      data: { label: 'prod-key', limit: 10, limit_remaining: 8.5, usage_daily: 0.25, is_free_tier: true },
    }),
  });
  assert.equal(okRes.available, true);
  assert.equal(okRes.scope, 'account');
  assert.equal(okRes.limit_remaining, 8.5);

  const missingKey = await fetchOpenRouterAccountLimits({ apiKey: '' });
  assert.equal(missingKey.available, false);
  assert.equal(missingKey.scope, 'account');

  const offline = await fetchOpenRouterAccountLimits({
    apiKey: 'sk-or-test',
    fetchImpl: async () => { throw new Error('ECONNREFUSED'); },
  });
  assert.equal(offline.available, false);
});
