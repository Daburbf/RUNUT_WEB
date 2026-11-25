// Regression tests for Verified Free DeepSeek V4.1 Flash API Providers:
// - Token Harbor (https://tokenharbor.ai/v1, model: deepseek-v4.1-flash:free)
// - BeatAPI (https://direct.beatapi.io/v1, model: deepseek-v4.1-flash-free)
// Covers strict free model ID enforcement, paid sibling & V4 Pro blocking,
// allowance & catalog preflights, rolling 7-day recovery, 1 req/min rate lock,
// HTTP 402/429 handling, privacy & consent revocation, malformed/truncated JSON,
// full multi-provider failover, and opt-in live smoke tests.

import test, { beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import {
  callStructuredAi,
  AiError,
  DEFAULT_TOKEN_HARBOR_BASE_URL,
  DEFAULT_TOKEN_HARBOR_FREE_MODEL,
  DEFAULT_BEATAPI_BASE_URL,
  DEFAULT_BEATAPI_FREE_MODEL,
  DEFAULT_OPENROUTER_PRIMARY_MODEL,
  DEFAULT_GEMINI_MODEL,
} from '../src/services/aiProvider.js';
import {
  createThirdPartyConsentRecord,
  revokeThirdPartyConsentRecord,
  resetOpenRouterCatalogCache,
} from '../src/services/aiModelRegistry.js';
import {
  resetAiUsageForTest,
  checkTokenHarborFreeAllowance,
  checkBeatApiFreeCatalog,
  acquireBeatApiMinuteSlot,
  commitBeatApiSuccess,
  isProviderInCooldown,
  getAiUsageSnapshot,
} from '../src/services/aiQuota.js';

function jsonRes(status, body, headers = {}) {
  return {
    ok: status >= 200 && status < 300,
    status,
    headers: new Headers(headers),
    json: async () => body,
    text: async () => (typeof body === 'string' ? body : JSON.stringify(body)),
  };
}

beforeEach(() => {
  resetAiUsageForTest();
  resetOpenRouterCatalogCache();
});

test('1. Exact Free Model IDs & Paid Sibling / DeepSeek V4 Pro Blocking', async () => {
  const mustNotCall = async () => { throw new Error('Network must not be called for blocked models'); };

  // Token Harbor paid sibling deepseek-v4.1-flash-1017 blocked
  await assert.rejects(
    () => callStructuredAi(
      { systemPrompt: 'sys', userPrompt: 'usr', fetchImpl: mustNotCall },
      {
        STRICT_FREE_AI_ONLY: 'true',
        AI_PROVIDER: 'tokenharbor',
        ENABLE_TOKEN_HARBOR_FREE: 'true',
        ALLOW_THIRD_PARTY_FREE_AI_PROCESSING: 'true',
        TOKEN_HARBOR_API_KEY: 'th-key',
        TOKEN_HARBOR_FREE_MODEL: 'deepseek-v4.1-flash-1017',
      },
    ),
    (err) => err instanceof AiError && err.code === 'AI_PAID_MODEL_BLOCKED' && err.status === 503,
  );

  // BeatAPI paid sibling deepseek-v4.1-flash blocked
  await assert.rejects(
    () => callStructuredAi(
      { systemPrompt: 'sys', userPrompt: 'usr', fetchImpl: mustNotCall },
      {
        STRICT_FREE_AI_ONLY: 'true',
        AI_PROVIDER: 'beatapi',
        ENABLE_BEATAPI_FREE: 'true',
        ALLOW_THIRD_PARTY_FREE_AI_PROCESSING: 'true',
        BEATAPI_API_KEY: 'ba-key',
        BEATAPI_FREE_MODEL: 'deepseek-v4.1-flash',
      },
    ),
    (err) => err instanceof AiError && err.code === 'AI_PAID_MODEL_BLOCKED' && err.status === 503,
  );

  // DeepSeek V4 Pro & aliases blocked everywhere under strict free mode
  for (const proModel of ['deepseek-v4-pro', 'deepseek-v4-pro-0813', 'deepseek-v4-pro:free']) {
    await assert.rejects(
      () => callStructuredAi(
        { systemPrompt: 'sys', userPrompt: 'usr', fetchImpl: mustNotCall },
        {
          STRICT_FREE_AI_ONLY: 'true',
          AI_PROVIDER: 'tokenharbor',
          ENABLE_TOKEN_HARBOR_FREE: 'true',
          ALLOW_THIRD_PARTY_FREE_AI_PROCESSING: 'true',
          TOKEN_HARBOR_API_KEY: 'th-key',
          TOKEN_HARBOR_FREE_MODEL: proModel,
        },
      ),
      (err) => err instanceof AiError && err.code === 'AI_PAID_MODEL_BLOCKED' && err.status === 503,
    );
  }
});

test('2. Token Harbor: exact base URL, allowance preflight, models_enabled, exhausted, reset_at & rolling 7-day recovery', async () => {
  const t0 = Date.parse('2026-11-25T12:00:00.000Z');
  const resetAt = '2026-12-02T12:00:00.000Z'; // Rolling 7x24h window

  // Successful preflight + inference on exact URL & model ID
  const urls = [];
  const fetchOk = async (url, opts) => {
    urls.push(url);
    if (url === 'https://tokenharbor.ai/api/cli/free-tier') {
      assert.equal(opts.headers.Authorization, 'Bearer th-secret-key');
      return jsonRes(200, {
        used_pct: 12.5,
        exhausted: false,
        reset_at: resetAt,
        models_enabled: true,
        models: [DEFAULT_TOKEN_HARBOR_FREE_MODEL],
      }, { 'Cache-Control': 'max-age=60' });
    }
    if (url === `${DEFAULT_TOKEN_HARBOR_BASE_URL}/chat/completions`) {
      const body = JSON.parse(opts.body);
      assert.equal(body.model, DEFAULT_TOKEN_HARBOR_FREE_MODEL);
      return jsonRes(200, {
        model: DEFAULT_TOKEN_HARBOR_FREE_MODEL,
        choices: [{ finish_reason: 'stop', message: { content: '{"replacements":[{"block_id":"paragraph_0001","revised_text":"Teks revisi."}]}' } }],
      });
    }
    throw new Error(`Unexpected URL: ${url}`);
  };

  const out = await callStructuredAi(
    {
      systemPrompt: 'sys',
      userPrompt: 'usr',
      fetchImpl: fetchOk,
      nowMs: t0,
      thirdPartyFreeConsent: createThirdPartyConsentRecord({ provider: 'tokenharbor' }),
    },
    {
      STRICT_FREE_AI_ONLY: 'true',
      AI_FAILOVER_ENABLED: 'false',
      AI_PROVIDER: 'tokenharbor',
      ENABLE_TOKEN_HARBOR_FREE: 'true',
      TOKEN_HARBOR_API_KEY: 'th-secret-key',
    },
  );

  assert.equal(out.provider, 'tokenharbor');
  assert.equal(out.model, DEFAULT_TOKEN_HARBOR_FREE_MODEL);
  assert.equal(urls[0], 'https://tokenharbor.ai/api/cli/free-tier');
  assert.equal(urls[1], 'https://tokenharbor.ai/v1/chat/completions');
  // Ensure API key never appears in usage snapshot
  assert.ok(!JSON.stringify(getAiUsageSnapshot()).includes('th-secret-key'));

  // models_enabled === false -> fail-closed
  const disabledCheck = await checkTokenHarborFreeAllowance({
    apiKey: 'th-secret-key',
    force: true,
    nowMs: t0,
    fetchImpl: async () => jsonRes(200, { models_enabled: false, exhausted: false, models: [DEFAULT_TOKEN_HARBOR_FREE_MODEL] }),
  });
  assert.equal(disabledCheck.ok, false);
  assert.equal(disabledCheck.code, 'AI_TOKEN_HARBOR_DISABLED');

  // exhausted === true -> cooldown until exact provider reset_at, then auto-recovers after rolling 7d window
  const exhaustedCheck = await checkTokenHarborFreeAllowance({
    apiKey: 'th-secret-key',
    force: true,
    nowMs: t0,
    fetchImpl: async () => jsonRes(200, {
      used_pct: 100,
      exhausted: true,
      reset_at: resetAt,
      models_enabled: true,
      models: [DEFAULT_TOKEN_HARBOR_FREE_MODEL],
    }),
  });
  assert.equal(exhaustedCheck.ok, false);
  assert.equal(exhaustedCheck.code, 'AI_QUOTA_EXHAUSTED');
  assert.equal(exhaustedCheck.reset_at, resetAt);
  assert.equal(isProviderInCooldown('tokenharbor', DEFAULT_TOKEN_HARBOR_FREE_MODEL, t0 + 3600_000).inCooldown, true);
  assert.equal(isProviderInCooldown('tokenharbor', DEFAULT_TOKEN_HARBOR_FREE_MODEL, Date.parse(resetAt) + 1000).inCooldown, false);

  // Allowance endpoint unavailable -> conservative fail-closed
  const offlineCheck = await checkTokenHarborFreeAllowance({
    apiKey: 'th-secret-key',
    force: true,
    nowMs: t0,
    fetchImpl: async () => { throw new Error('ECONNREFUSED'); },
  });
  assert.equal(offlineCheck.ok, false);
  assert.equal(offlineCheck.code, 'AI_ALLOWANCE_UNAVAILABLE');
});

test('3. BeatAPI: exact base URL, free catalog preflight, withdrawal disabling, and 1-req/min lock', async () => {
  const t0 = Date.parse('2026-11-25T12:00:00.000Z');

  // Withdrawn model from catalog disables BeatAPI automatically
  const withdrawn = await checkBeatApiFreeCatalog({
    force: true,
    nowMs: t0,
    fetchImpl: async () => jsonRes(200, { models: ['other-free-model'] }),
  });
  assert.equal(withdrawn.ok, false);
  assert.equal(withdrawn.code, 'AI_BEATAPI_FREE_WITHDRAWN');

  // 1 successful request per minute controller with concurrent in-flight lock
  resetAiUsageForTest();
  const s1 = acquireBeatApiMinuteSlot({ nowMs: t0 });
  assert.equal(s1.ok, true);
  const concurrent = acquireBeatApiMinuteSlot({ nowMs: t0 + 100 });
  assert.equal(concurrent.ok, false);
  assert.equal(concurrent.code, 'AI_RATE_LIMIT');

  commitBeatApiSuccess({ nowMs: t0 });
  const tooSoon = acquireBeatApiMinuteSlot({ nowMs: t0 + 30_000 });
  assert.equal(tooSoon.ok, false);
  const afterMinute = acquireBeatApiMinuteSlot({ nowMs: t0 + 61_000 });
  assert.equal(afterMinute.ok, true);
  commitBeatApiSuccess({ nowMs: t0 + 61_000 });

  // End-to-end BeatAPI inference call on exact base URL & model ID
  resetAiUsageForTest();
  const urls = [];
  const fetchBeat = async (url, opts) => {
    urls.push(url);
    if (url === 'https://api.beatapi.io/v1/free-tier') {
      return jsonRes(200, { models: [DEFAULT_BEATAPI_FREE_MODEL] });
    }
    if (url === `${DEFAULT_BEATAPI_BASE_URL}/chat/completions`) {
      const body = JSON.parse(opts.body);
      assert.equal(body.model, DEFAULT_BEATAPI_FREE_MODEL);
      return jsonRes(200, {
        model: DEFAULT_BEATAPI_FREE_MODEL,
        choices: [{ finish_reason: 'stop', message: { content: '{"ok":true}' } }],
      });
    }
    throw new Error(`Unexpected URL: ${url}`);
  };

  const res = await callStructuredAi(
    {
      systemPrompt: 'sys',
      userPrompt: 'usr',
      fetchImpl: fetchBeat,
      nowMs: t0,
      thirdPartyFreeConsent: createThirdPartyConsentRecord({ provider: 'beatapi' }),
    },
    {
      STRICT_FREE_AI_ONLY: 'true',
      AI_FAILOVER_ENABLED: 'false',
      AI_PROVIDER: 'beatapi',
      ENABLE_BEATAPI_FREE: 'true',
      BEATAPI_API_KEY: 'ba-secret-key',
    },
  );
  assert.equal(res.provider, 'beatapi');
  assert.equal(res.model, DEFAULT_BEATAPI_FREE_MODEL);
  assert.equal(urls[0], 'https://api.beatapi.io/v1/free-tier');
  assert.equal(urls[1], 'https://direct.beatapi.io/v1/chat/completions');
});

test('4. Consent Enforcement, Revocation, and Confidential Document Blocking', async () => {
  const mustNotCall = async () => { throw new Error('Must not call network without consent or on confidential doc'); };

  // Without ALLOW_THIRD_PARTY_FREE_AI_PROCESSING and without consent record -> blocked
  await assert.rejects(
    () => callStructuredAi(
      { systemPrompt: 'sys', userPrompt: 'usr', fetchImpl: mustNotCall },
      {
        STRICT_FREE_AI_ONLY: 'true',
        AI_FAILOVER_ENABLED: 'false',
        AI_PROVIDER: 'tokenharbor',
        ENABLE_TOKEN_HARBOR_FREE: 'true',
        ALLOW_THIRD_PARTY_FREE_AI_PROCESSING: 'false',
        TOKEN_HARBOR_API_KEY: 'th-key',
      },
    ),
    (err) => err instanceof AiError && err.code === 'AI_PRIVACY_NO_ELIGIBLE_PROVIDER' && err.status === 503,
  );

  // Revoked consent record -> blocked even if env flag is true
  const granted = createThirdPartyConsentRecord({ provider: 'tokenharbor', version: '2.0' });
  const revoked = revokeThirdPartyConsentRecord(granted);
  await assert.rejects(
    () => callStructuredAi(
      { systemPrompt: 'sys', userPrompt: 'usr', fetchImpl: mustNotCall, thirdPartyFreeConsent: revoked },
      {
        STRICT_FREE_AI_ONLY: 'true',
        AI_FAILOVER_ENABLED: 'false',
        AI_PROVIDER: 'tokenharbor',
        ENABLE_TOKEN_HARBOR_FREE: 'true',
        ALLOW_THIRD_PARTY_FREE_AI_PROCESSING: 'true',
        TOKEN_HARBOR_API_KEY: 'th-key',
      },
    ),
    (err) => err instanceof AiError && err.code === 'AI_PRIVACY_NO_ELIGIBLE_PROVIDER',
  );

  // Confidential document -> blocked for both Token Harbor and BeatAPI even with consent
  for (const prov of ['tokenharbor', 'beatapi']) {
    await assert.rejects(
      () => callStructuredAi(
        {
          systemPrompt: 'sys',
          userPrompt: 'usr',
          confidential: true,
          thirdPartyFreeConsent: createThirdPartyConsentRecord({ provider: prov }),
          fetchImpl: mustNotCall,
        },
        {
          STRICT_FREE_AI_ONLY: 'true',
          AI_FAILOVER_ENABLED: 'false',
          AI_PROVIDER: prov,
          ENABLE_TOKEN_HARBOR_FREE: 'true',
          ENABLE_BEATAPI_FREE: 'true',
          ALLOW_THIRD_PARTY_FREE_AI_PROCESSING: 'true',
          TOKEN_HARBOR_API_KEY: 'th-key',
          BEATAPI_API_KEY: 'ba-key',
        },
      ),
      (err) => err instanceof AiError && err.code === 'AI_PRIVACY_NO_ELIGIBLE_PROVIDER',
    );
  }
});

test('5. HTTP 402/429, Malformed/Truncated JSON, and Full Multi-Provider Failover (Token Harbor -> BeatAPI -> Gemini Free)', async () => {
  const t0 = Date.parse('2026-11-25T12:00:00.000Z');
  const calls = [];

  const fetchFailover = async (url) => {
    calls.push(url);
    // Token Harbor preflight OK, but chat returns HTTP 402 (must never trigger paid retry/top-up)
    if (url === 'https://tokenharbor.ai/api/cli/free-tier') {
      return jsonRes(200, { models_enabled: true, exhausted: false, models: [DEFAULT_TOKEN_HARBOR_FREE_MODEL] });
    }
    if (url === 'https://tokenharbor.ai/v1/chat/completions') {
      return jsonRes(402, { error: 'allowance exhausted' });
    }
    // BeatAPI catalog OK, but chat returns truncated completion (finish_reason=length)
    if (url === 'https://api.beatapi.io/v1/free-tier') {
      return jsonRes(200, { models: [DEFAULT_BEATAPI_FREE_MODEL] });
    }
    if (url === 'https://direct.beatapi.io/v1/chat/completions') {
      return jsonRes(200, {
        model: DEFAULT_BEATAPI_FREE_MODEL,
        choices: [{ finish_reason: 'length', message: { content: '{"truncated":' } }],
      });
    }
    // Fallback to independent Gemini Free succeeds cleanly
    if (url.includes('generativelanguage.googleapis.com')) {
      return jsonRes(200, {
        model: DEFAULT_GEMINI_MODEL,
        choices: [{ finish_reason: 'stop', message: { content: '{"issues":[],"recovered_from":"deepseek_free_chain"}' } }],
      });
    }
    throw new Error(`Unexpected URL: ${url}`);
  };

  const out = await callStructuredAi(
    {
      systemPrompt: 'sys',
      userPrompt: 'usr',
      fetchImpl: fetchFailover,
      nowMs: t0,
      thirdPartyFreeConsent: createThirdPartyConsentRecord({ provider: '*' }),
    },
    {
      STRICT_FREE_AI_ONLY: 'true',
      AI_FAILOVER_ENABLED: 'true',
      AI_MAX_PROVIDER_ATTEMPTS: '5',
      AI_PROVIDER: 'tokenharbor',
      ENABLE_TOKEN_HARBOR_FREE: 'true',
      ENABLE_BEATAPI_FREE: 'true',
      TOKEN_HARBOR_API_KEY: 'th-key',
      BEATAPI_API_KEY: 'ba-key',
      GEMINI_API_KEY: 'gem-key',
    },
  );

  assert.equal(out.provider, 'gemini');
  assert.equal(out.fallbackUsed, true);
  assert.equal(out.parsed.recovered_from, 'deepseek_free_chain');
  // Zero retries on Token Harbor 402 or BeatAPI truncated output
  assert.equal(calls.filter((u) => u === 'https://tokenharbor.ai/v1/chat/completions').length, 1);
  assert.equal(calls.filter((u) => u === 'https://direct.beatapi.io/v1/chat/completions').length, 1);

  // BeatAPI HTTP 429 respects Retry-After without retry loop
  resetAiUsageForTest();
  let beatHits = 0;
  await assert.rejects(
    () => callStructuredAi(
      {
        systemPrompt: 'sys',
        userPrompt: 'usr',
        nowMs: t0,
        thirdPartyFreeConsent: createThirdPartyConsentRecord({ provider: 'beatapi' }),
        fetchImpl: async (url) => {
          if (url === 'https://api.beatapi.io/v1/free-tier') {
            return jsonRes(200, { models: [DEFAULT_BEATAPI_FREE_MODEL] });
          }
          beatHits += 1;
          return jsonRes(429, { error: 'rate limited' }, { 'Retry-After': '90' });
        },
      },
      {
        STRICT_FREE_AI_ONLY: 'true',
        AI_FAILOVER_ENABLED: 'false',
        AI_PROVIDER: 'beatapi',
        ENABLE_BEATAPI_FREE: 'true',
        BEATAPI_API_KEY: 'ba-key',
      },
    ),
    (err) => err instanceof AiError && err.code === 'AI_FREE_QUOTA_EXHAUSTED' && err.status === 503 && Boolean(err.estimatedRetryAt),
  );
  assert.equal(beatHits, 1, 'BeatAPI must not retry on HTTP 429');
});

test('6. Opt-In Live Smoke Test (Token Harbor / BeatAPI) — skipped unless RUNUT_LIVE_DEEPSEEK_FREE_SMOKE=true', {
  skip: process.env.RUNUT_LIVE_DEEPSEEK_FREE_SMOKE !== 'true'
    ? 'Opt-in live smoke test (set RUNUT_LIVE_DEEPSEEK_FREE_SMOKE=true with non-confidential test keys).'
    : false,
}, async () => {
  if (process.env.TOKEN_HARBOR_API_KEY) {
    const check = await checkTokenHarborFreeAllowance({ apiKey: process.env.TOKEN_HARBOR_API_KEY, force: true });
    assert.equal(typeof check.ok, 'boolean');
  }
  const beatCat = await checkBeatApiFreeCatalog({ force: true });
  assert.equal(typeof beatCat.ok, 'boolean');
});
