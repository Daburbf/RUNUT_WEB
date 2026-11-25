import test from 'node:test';
import assert from 'node:assert/strict';
import { callStructuredAi, AiError } from '../src/services/aiProvider.js';
import { resetAiUsageForTest } from '../src/services/aiQuota.js';
import { resetOpenRouterCatalogCache } from '../src/services/aiModelRegistry.js';

test('Zero-Cost Policy: memblokir model OpenRouter non-:free, model retired Groq, dan provider berbayar secara ketat', async () => {
  resetAiUsageForTest();
  resetOpenRouterCatalogCache();

  await assert.rejects(
    () => callStructuredAi(
      { systemPrompt: 'sys', userPrompt: 'usr', fetchImpl: async () => { throw new Error('must not call network'); } },
      { AI_PROVIDER: 'openrouter', OPENROUTER_API_KEY: 'sk-test', OPENROUTER_PRIMARY_MODEL: 'openai/gpt-4o', STRICT_FREE_AI_ONLY: 'true' },
    ),
    (err) => err instanceof AiError && err.code === 'AI_PAID_MODEL_BLOCKED' && err.status === 503,
  );

  await assert.rejects(
    () => callStructuredAi(
      { systemPrompt: 'sys', userPrompt: 'usr', fetchImpl: async () => { throw new Error('must not call network'); } },
      { AI_PROVIDER: 'openai', AI_API_KEY: 'sk-test', AI_MODEL: 'gpt-4o', STRICT_FREE_AI_ONLY: 'true' },
    ),
    (err) => err instanceof AiError && err.code === 'AI_PAID_PROVIDER_BLOCKED' && err.status === 503,
  );

  await assert.rejects(
    () => callStructuredAi(
      { systemPrompt: 'sys', userPrompt: 'usr', fetchImpl: async () => { throw new Error('must not call network'); } },
      { AI_PROVIDER: 'groq', GROQ_API_KEY: 'gq-test', GROQ_MODEL: 'llama-3.3-70b-versatile', STRICT_FREE_AI_ONLY: 'true' },
    ),
    (err) => err instanceof AiError && err.code === 'AI_DEPRECATED_MODEL_BLOCKED' && err.status === 503,
  );
});

test('Zero-Cost Multi-Model Failover: Particle-1 (503) -> ERNIE-5.5 (503) -> Ling-3.2 (200 OK)', async () => {
  resetAiUsageForTest();
  resetOpenRouterCatalogCache();
  const calledModels = [];
  const mockFetch = async (url, opts) => {
    const body = JSON.parse(opts.body);
    calledModels.push(body.model);
    if (body.model === 'particle-ai/particle-1:free') {
      return { ok: false, status: 503, headers: new Headers(), text: async () => 'upstream unavailable' };
    }
    if (body.model === 'baidu/ernie-5.5-flash-preview:free') {
      return { ok: false, status: 503, headers: new Headers(), text: async () => 'upstream unavailable' };
    }
    if (body.model === 'inclusionai/ling-3.2-flash:free') {
      return {
        ok: true,
        status: 200,
        headers: new Headers(),
        json: async () => ({
          model: 'inclusionai/ling-3.2-flash:free',
          choices: [{ message: { content: '{"issues":[]}' } }],
        }),
      };
    }
    throw new Error(`Unexpected model: ${body.model}`);
  };

  const res = await callStructuredAi(
    { systemPrompt: 'sys', userPrompt: 'usr', maxRetries: 0, retryBaseDelayMs: 1, fetchImpl: mockFetch },
    {
      STRICT_FREE_AI_ONLY: 'true',
      AI_PROVIDER: 'openrouter',
      OPENROUTER_API_KEY: 'or-free-key',
      GEMINI_API_KEY: 'gem-free-key',
      AI_MAX_PROVIDER_ATTEMPTS: '5',
    },
  );

  assert.equal(res.provider, 'openrouter');
  assert.equal(res.model, 'inclusionai/ling-3.2-flash:free');
  assert.equal(res.fallbackUsed, true);
  assert.deepEqual(calledModels, [
    'particle-ai/particle-1:free',
    'baidu/ernie-5.5-flash-preview:free',
    'inclusionai/ling-3.2-flash:free',
  ]);
});

test('Zero-Cost Quota Exhaustion: bila SEMUA provider gratis habis kuota (429/402), mengembalikan 503 AI_FREE_QUOTA_EXHAUSTED tanpa fallback berbayar', async () => {
  resetAiUsageForTest();
  resetOpenRouterCatalogCache();
  const mockFetch = async () => ({
    ok: false,
    status: 429,
    headers: new Headers({ 'Retry-After': '120' }),
    text: async () => 'rate limit / daily quota exceeded',
  });

  await assert.rejects(
    () => callStructuredAi(
      { systemPrompt: 'sys', userPrompt: 'usr', maxRetries: 0, retryBaseDelayMs: 1, fetchImpl: mockFetch },
      {
        STRICT_FREE_AI_ONLY: 'true',
        AI_PROVIDER: 'openrouter',
        OPENROUTER_API_KEY: 'or-free-key',
        GEMINI_API_KEY: 'gem-free-key',
      },
    ),
    (err) => err instanceof AiError
      && err.code === 'AI_FREE_QUOTA_EXHAUSTED'
      && err.status === 503
      && err.retryable === true
      && Boolean(err.estimatedRetryAt),
  );
});
