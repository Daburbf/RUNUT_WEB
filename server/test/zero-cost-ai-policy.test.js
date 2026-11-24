import test from 'node:test';
import assert from 'node:assert/strict';
import { callStructuredAi, AiError } from '../src/services/aiProvider.js';

test('Zero-Cost Policy: memblokir model OpenRouter non-:free dan provider berbayar (openai) secara ketat', async () => {
  await assert.rejects(
    () => callStructuredAi(
      { systemPrompt: 'sys', userPrompt: 'usr', fetchImpl: async () => { throw new Error('must not call network'); } },
      { AI_PROVIDER: 'openrouter', OPENROUTER_API_KEY: 'sk-test', OPENROUTER_MODEL: 'openai/gpt-4o', STRICT_FREE_AI_ONLY: 'true' },
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
});

test('Zero-Cost 3-Tier Free Fallback: OpenRouter (:free) 429 -> Gemini Free 503 -> Groq Free 200 OK', async () => {
  const calledUrls = [];
  const mockFetch = async (url) => {
    calledUrls.push(url);
    if (url.includes('openrouter.ai')) {
      return { ok: false, status: 402, headers: new Headers(), text: async () => 'free quota exhausted' };
    }
    if (url.includes('generativelanguage.googleapis.com')) {
      return { ok: false, status: 503, headers: new Headers(), text: async () => 'temporarily unavailable' };
    }
    if (url.includes('api.groq.com')) {
      return {
        ok: true,
        status: 200,
        json: async () => ({
          model: 'llama-3.3-70b-versatile',
          choices: [{ message: { content: '{"issues":[]}' } }],
        }),
      };
    }
    throw new Error(`Unexpected URL: ${url}`);
  };

  const res = await callStructuredAi(
    { systemPrompt: 'sys', userPrompt: 'usr', maxRetries: 0, retryBaseDelayMs: 1, fetchImpl: mockFetch },
    {
      STRICT_FREE_AI_ONLY: 'true',
      AI_PROVIDER: 'openrouter',
      OPENROUTER_API_KEY: 'or-free-key',
      OPENROUTER_MODEL: 'particle-ai/particle-1:free',
      GEMINI_API_KEY: 'gem-free-key',
      GEMINI_MODEL: 'gemini-3.1-flash-lite',
      GROQ_API_KEY: 'groq-free-key',
      GROQ_MODEL: 'llama-3.3-70b-versatile',
    },
  );

  assert.equal(res.provider, 'groq');
  assert.equal(res.fallbackUsed, true);
  assert.equal(calledUrls.length, 3);
  assert.match(calledUrls[0], /openrouter\.ai/);
  assert.match(calledUrls[1], /generativelanguage\.googleapis\.com/);
  assert.match(calledUrls[2], /api\.groq\.com/);
});

test('Zero-Cost Quota Exhaustion: bila SEMUA provider gratis habis kuota (429/402), mengembalikan AI_FREE_QUOTA_EXHAUSTED tanpa fallback berbayar', async () => {
  const mockFetch = async () => ({
    ok: false,
    status: 429,
    headers: new Headers(),
    text: async () => 'rate limit / daily quota exceeded',
  });

  await assert.rejects(
    () => callStructuredAi(
      { systemPrompt: 'sys', userPrompt: 'usr', maxRetries: 0, retryBaseDelayMs: 1, fetchImpl: mockFetch },
      {
        STRICT_FREE_AI_ONLY: 'true',
        AI_PROVIDER: 'openrouter',
        OPENROUTER_API_KEY: 'or-free-key',
        OPENROUTER_MODEL: 'particle-ai/particle-1:free',
        GEMINI_API_KEY: 'gem-free-key',
        GROQ_API_KEY: 'groq-free-key',
      },
    ),
    (err) => err instanceof AiError && err.code === 'AI_FREE_QUOTA_EXHAUSTED' && err.status === 503 && err.retryable === true,
  );
});
