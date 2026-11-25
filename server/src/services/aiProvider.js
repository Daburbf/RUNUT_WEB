// RUNUT Free Multi-Model AI Provider & Intelligent Failover Controller
// Enforces STRICT_FREE_AI_ONLY=true centrally via aiModelRegistry.js and tracks
// real rate-limit headers, cooldowns, and daily resets via aiQuota.js.
//
// Default Free Failover Order:
//   1. OpenRouter: particle-ai/particle-1:free (Primary)
//   2. OpenRouter: baidu/ernie-5.5-flash-preview:free (Fallback 1)
//   3. OpenRouter: inclusionai/ling-3.2-flash:free (Fallback 2)
//   4. OpenRouter: openrouter/free (Fallback 3 - Dynamic Free Router)
//   5. OpenRouter: nvidia/nemotron-3-ultra-550b-a55b:free (Optional, non-confidential only)
//   6. Google AI Studio: gemini-3.1-flash-lite (Independent Provider & Validation)
//   7. Groq: ONLY when ENABLE_GROQ_FREE=true, GROQ_FREE_VERIFIED=true, and non-deprecated
//
// Also preserves backward compatibility with explicit 9router test stubs.

import {
  buildWritingSystemPrompt,
  buildWritingUserPrompt,
  detectDocumentLanguage,
  detectDocumentType,
} from './prompts/writingEngine.js';
import {
  DEFAULT_OPENROUTER_BASE_URL,
  DEFAULT_OPENROUTER_PRIMARY_MODEL,
  DEFAULT_OPENROUTER_FALLBACK_1,
  DEFAULT_OPENROUTER_FALLBACK_2,
  DEFAULT_OPENROUTER_DYNAMIC_MODEL,
  OPTIONAL_OPENROUTER_NEMOTRON_MODEL,
  DEFAULT_GEMINI_BASE_URL,
  DEFAULT_GEMINI_MODEL,
  DEFAULT_GROQ_BASE_URL,
  DEPRECATED_MODELS,
  ALLOWED_OPENROUTER_FREE_MODELS,
  FREE_PROVIDER_ALLOWLIST,
  PAID_PROVIDER_BLOCKLIST,
  FREE_MODEL_REGISTRY,
  verifyOpenRouterCatalogEntry,
  isModelEligibleForPrivacy,
  getFreeModelRegistrySnapshot,
} from './aiModelRegistry.js';
import {
  recordAiRequest,
  recordRateLimitState,
  isProviderInCooldown,
  isOpenRouterAccountExhausted,
  getEarliestCooldownResetIso,
  parseRateLimitHeaders,
} from './aiQuota.js';

export {
  DEFAULT_OPENROUTER_BASE_URL,
  DEFAULT_OPENROUTER_PRIMARY_MODEL as DEFAULT_OPENROUTER_MODEL,
  DEFAULT_OPENROUTER_PRIMARY_MODEL,
  DEFAULT_OPENROUTER_FALLBACK_1,
  DEFAULT_OPENROUTER_FALLBACK_2,
  DEFAULT_OPENROUTER_DYNAMIC_MODEL,
  OPTIONAL_OPENROUTER_NEMOTRON_MODEL,
  DEFAULT_GEMINI_BASE_URL,
  DEFAULT_GEMINI_MODEL,
  DEFAULT_GROQ_BASE_URL,
  FREE_PROVIDER_ALLOWLIST,
  ALLOWED_OPENROUTER_FREE_MODELS,
  DEPRECATED_MODELS,
  FREE_MODEL_REGISTRY,
  getFreeModelRegistrySnapshot,
};

// Section 12: Internal system instruction for Stage A content editing models.
export const DOCUMENT_CONTENT_REVISION_SYSTEM_PROMPT = `You are RUNUT's document content revision engine.

Your task is to improve the user's existing textual content while
preserving its meaning, information, facts, structure, and context.

IMPORTANT RULES:

1. Revise text only.
2. Never redesign or regenerate the document.
3. Never create new sections, paragraphs, tables, or headings.
4. Preserve the source language unless translation was explicitly requested.
5. Preserve names, dates, figures, statistics, formulas, technical terms,
   references, and citations.
6. Never invent facts or supporting evidence.
7. Improve grammar, clarity, coherence, readability, and sentence flow.
8. Preserve the document's existing level of formality and writing style.
9. Avoid repetitive wording and artificial transitions.
10. Avoid generic AI-sounding expressions.
11. Preserve the original author's meaning and intent.
12. Keep the length reasonably close to the original.
13. Preserve protected placeholders and immutable tokens exactly.
14. Do not create content for missing or empty sections.
15. Do not remove essential qualifications, limitations, or caveats.
16. Do not alter fixed template labels.
17. Do not change citations or bibliography entries unless specifically
    authorized by the editing task.

OUTPUT:

Return only valid JSON matching the required schema.

Use the original block IDs.

Every editable block must appear exactly once.

Do not add, remove, duplicate, or rename block IDs.

Do not include Markdown fences.

Do not include explanations outside JSON.

If the original text does not require revision, return the original text.`;

export function isStrictFreeOnly(env = process.env) {
  return String(env.STRICT_FREE_AI_ONLY ?? 'true').trim().toLowerCase() !== 'false';
}

export class AiError extends Error {
  constructor(message, {
    code = 'AI_ERROR',
    status = 502,
    retryable = true,
    provider = null,
    model = null,
    retryAfter = null,
    estimatedRetryAt = null,
    accountLevel = false,
  } = {}) {
    super(message);
    this.code = code;
    this.status = status;
    this.retryable = retryable;
    this.provider = provider;
    this.model = model;
    this.retryAfter = retryAfter;
    this.estimatedRetryAt = estimatedRetryAt;
    this.accountLevel = accountLevel;
  }
}

export function assertFreeModelPolicy(provider, model, env = process.env, { baseUrl = '' } = {}) {
  const p = String(provider || '').trim().toLowerCase();
  const m = String(model || '').trim();

  if (DEPRECATED_MODELS.has(m)) {
    throw new AiError(DEPRECATED_MODELS.get(m), {
      code: 'AI_DEPRECATED_MODEL_BLOCKED',
      status: 503,
      retryable: false,
      provider: p,
      model: m,
    });
  }

  if (!isStrictFreeOnly(env)) return;

  if (PAID_PROVIDER_BLOCKLIST.has(p) || !FREE_PROVIDER_ALLOWLIST.has(p)) {
    throw new AiError(
      `Provider AI berbayar "${p}" diblokir oleh kebijakan zero-cost (STRICT_FREE_AI_ONLY=true). Gunakan OpenRouter (:free / openrouter/free) atau Google Gemini Free Tier.`,
      { code: 'AI_PAID_PROVIDER_BLOCKED', status: 503, retryable: false, provider: p, model: m },
    );
  }

  if (p === 'openrouter') {
    const check = verifyOpenRouterCatalogEntry(m, { baseUrl: baseUrl || env.OPENROUTER_BASE_URL || env.AI_BASE_URL || '', env });
    if (!check.ok) {
      throw new AiError(check.reason, {
        code: check.code,
        status: 503,
        retryable: check.code === 'AI_MODEL_UNAVAILABLE',
        provider: p,
        model: m,
      });
    }
  }

  if (p === 'groq') {
    const groqEnabled = String(env.ENABLE_GROQ_FREE || 'false').trim().toLowerCase() === 'true';
    const groqVerified = String(env.GROQ_FREE_VERIFIED || 'false').trim().toLowerCase() === 'true';
    if (!groqEnabled || !groqVerified) {
      throw new AiError(
        'Provider Groq dinonaktifkan secara default sampai akses Free Tier akun diverifikasi (ENABLE_GROQ_FREE=true dan GROQ_FREE_VERIFIED=true).',
        { code: 'AI_GROQ_UNVERIFIED_BLOCKED', status: 503, retryable: false, provider: p, model: m },
      );
    }
  }
}

const PROVIDERS = {
  openrouter: {
    label: 'OpenRouter (Free)',
    requiresApiKey: true,
    defaultBaseUrl: DEFAULT_OPENROUTER_BASE_URL,
    supportsResponseFormat: true,
    endpoint: (baseUrl) => `${baseUrl}/chat/completions`,
  },
  gemini: {
    label: 'Google Gemini (Free Tier)',
    requiresApiKey: true,
    defaultBaseUrl: DEFAULT_GEMINI_BASE_URL,
    supportsResponseFormat: true,
    endpoint: (baseUrl) => `${baseUrl}/chat/completions`,
  },
  groq: {
    label: 'Groq (Verified Free Tier)',
    requiresApiKey: true,
    defaultBaseUrl: DEFAULT_GROQ_BASE_URL,
    supportsResponseFormat: true,
    endpoint: (baseUrl) => `${baseUrl}/chat/completions`,
  },
  '9router': {
    label: '9Router (Test Stub)',
    requiresApiKey: true,
    defaultBaseUrl: 'http://localhost:20128/v1',
    supportsResponseFormat: false,
    endpoint: (baseUrl) => `${baseUrl}/chat/completions`,
  },
  openai: {
    label: 'OpenAI',
    requiresApiKey: true,
    defaultBaseUrl: 'https://api.openai.com/v1',
    supportsResponseFormat: true,
    endpoint: (baseUrl) => `${baseUrl}/chat/completions`,
  },
};

function makeCandidate(provider, model, baseUrl, apiKey, timeoutMs, extra = {}) {
  const impl = PROVIDERS[provider];
  const supportsResponseFormat = model === OPTIONAL_OPENROUTER_NEMOTRON_MODEL
    ? false
    : Boolean(impl?.supportsResponseFormat);
  return {
    provider,
    impl,
    baseUrl: String(baseUrl || impl?.defaultBaseUrl || '').replace(/\/$/, ''),
    apiKey: String(apiKey || '').trim(),
    model: String(model || '').trim(),
    timeoutMs,
    supportsResponseFormat,
    configured: Boolean(impl && baseUrl && model && (!impl.requiresApiKey || apiKey)),
    ...extra,
  };
}

function resolvePrimaryConfig(env = process.env) {
  const explicitProvider = String(env.AI_PROVIDER || '').trim().toLowerCase();
  const provider = explicitProvider || (env.OPENROUTER_API_KEY ? 'openrouter' : (env.GEMINI_API_KEY ? 'gemini' : 'openrouter'));
  const impl = PROVIDERS[provider];
  const timeoutMs = Number(env.AI_TIMEOUT_MS || 90000);

  let baseUrl = '';
  let apiKey = '';
  let model = '';

  if (provider === 'openrouter') {
    baseUrl = String(env.OPENROUTER_BASE_URL || env.AI_BASE_URL || impl.defaultBaseUrl).replace(/\/$/, '');
    apiKey = env.OPENROUTER_API_KEY || env.AI_API_KEY || '';
    model = env.OPENROUTER_PRIMARY_MODEL || env.OPENROUTER_MODEL || env.AI_MODEL || DEFAULT_OPENROUTER_PRIMARY_MODEL;
  } else if (provider === 'gemini') {
    baseUrl = String(env.GEMINI_BASE_URL || env.AI_BASE_URL || impl.defaultBaseUrl).replace(/\/$/, '');
    apiKey = env.GEMINI_API_KEY || env.AI_API_KEY || '';
    model = env.GEMINI_CONTENT_MODEL || env.GEMINI_MODEL || env.AI_MODEL || DEFAULT_GEMINI_MODEL;
  } else if (provider === 'groq') {
    baseUrl = String(env.GROQ_BASE_URL || env.AI_BASE_URL || impl.defaultBaseUrl).replace(/\/$/, '');
    apiKey = env.GROQ_API_KEY || env.AI_API_KEY || '';
    model = env.GROQ_MODEL || env.AI_MODEL || '';
  } else {
    baseUrl = String(env.AI_BASE_URL || impl?.defaultBaseUrl || '').replace(/\/$/, '');
    apiKey = env.AI_API_KEY || '';
    model = env.AI_MODEL || '';
  }

  return makeCandidate(provider, model, baseUrl, apiKey, timeoutMs);
}

function buildOpenRouterFallbackModels(primaryModel, env = process.env) {
  const apiKey = String(env.OPENROUTER_API_KEY || '').trim();
  if (!apiKey) return [];
  const baseUrl = String(env.OPENROUTER_BASE_URL || DEFAULT_OPENROUTER_BASE_URL).replace(/\/$/, '');
  const timeoutMs = Number(env.AI_TIMEOUT_MS || 90000);

  const rawList = [
    env.OPENROUTER_PRIMARY_MODEL || env.OPENROUTER_MODEL || DEFAULT_OPENROUTER_PRIMARY_MODEL,
    env.OPENROUTER_FALLBACK_MODEL_1 || DEFAULT_OPENROUTER_FALLBACK_1,
    env.OPENROUTER_FALLBACK_MODEL_2 || DEFAULT_OPENROUTER_FALLBACK_2,
    env.OPENROUTER_DYNAMIC_MODEL || DEFAULT_OPENROUTER_DYNAMIC_MODEL,
  ];
  if (String(env.ENABLE_NEMOTRON_FREE || 'false').trim().toLowerCase() === 'true') {
    rawList.push(OPTIONAL_OPENROUTER_NEMOTRON_MODEL);
  }

  const seen = new Set(primaryModel ? [String(primaryModel).trim()] : []);
  const out = [];
  for (const m of rawList) {
    const clean = String(m || '').trim();
    if (!clean || seen.has(clean)) continue;
    seen.add(clean);
    out.push(makeCandidate('openrouter', clean, baseUrl, apiKey, timeoutMs));
  }
  return out;
}

function resolveFallbackChain(primary, env = process.env) {
  if (String(env.AI_FAILOVER_ENABLED ?? 'true').trim().toLowerCase() === 'false') {
    return [];
  }
  const timeoutMs = Number(env.AI_TIMEOUT_MS || 90000);
  const chain = [];

  // 1. Additional OpenRouter free model variants (ERNIE -> Ling -> OpenRouter Free Router -> optional Nemotron)
  if (primary.provider === 'openrouter') {
    chain.push(...buildOpenRouterFallbackModels(primary.model, env));
  }

  // 2. Independent Provider: Google Gemini Free Tier
  if (primary.provider !== 'gemini') {
    const apiKey = String(env.GEMINI_API_KEY || '').trim();
    const model = String(env.GEMINI_CONTENT_MODEL || env.GEMINI_MODEL || DEFAULT_GEMINI_MODEL).trim();
    const baseUrl = String(env.GEMINI_BASE_URL || DEFAULT_GEMINI_BASE_URL).replace(/\/$/, '');
    if (apiKey && model) {
      chain.push(makeCandidate('gemini', model, baseUrl, apiKey, timeoutMs));
    }
  }

  // 3. Groq ONLY if explicitly enabled, verified free, and non-deprecated
  if (primary.provider !== 'groq') {
    const groqEnabled = String(env.ENABLE_GROQ_FREE || 'false').trim().toLowerCase() === 'true';
    const groqVerified = String(env.GROQ_FREE_VERIFIED || 'false').trim().toLowerCase() === 'true';
    const apiKey = String(env.GROQ_API_KEY || '').trim();
    const model = String(env.GROQ_MODEL || '').trim();
    const baseUrl = String(env.GROQ_BASE_URL || DEFAULT_GROQ_BASE_URL).replace(/\/$/, '');
    if (groqEnabled && groqVerified && apiKey && model && !DEPRECATED_MODELS.has(model)) {
      chain.push(makeCandidate('groq', model, baseUrl, apiKey, timeoutMs));
    }
  }

  // 4. OpenRouter free models if primary was Gemini or Groq
  if (primary.provider !== 'openrouter') {
    chain.push(...buildOpenRouterFallbackModels(null, env));
  }

  return chain;
}

export function getProviderInfo(env = process.env) {
  const primary = resolvePrimaryConfig(env);
  const fallbacks = resolveFallbackChain(primary, env);
  const firstFallback = fallbacks[0] || null;
  return {
    provider: primary.provider,
    baseUrl: primary.baseUrl,
    model: primary.model,
    timeoutMs: primary.timeoutMs,
    configured: primary.configured,
    zero_cost_enforced: isStrictFreeOnly(env),
    failover_enabled: String(env.AI_FAILOVER_ENABLED ?? 'true').trim().toLowerCase() !== 'false',
    fallback: firstFallback
      ? {
          provider: firstFallback.provider,
          model: firstFallback.model,
          configured: true,
        }
      : {
          provider: 'gemini',
          model: String(env.GEMINI_CONTENT_MODEL || env.GEMINI_MODEL || DEFAULT_GEMINI_MODEL),
          configured: false,
        },
    fallback_chain: fallbacks.map((f) => ({ provider: f.provider, model: f.model, configured: true })),
  };
}

export function extractJson(raw) {
  const text = String(raw || '')
    .replace(/<think>[\s\S]*?<\/think>/gi, '')
    .trim();
  const start = text.indexOf('{');
  const end = text.lastIndexOf('}');
  if (start === -1 || end === -1 || end <= start) {
    throw new AiError('Respons model tidak memuat JSON.', { code: 'AI_BAD_JSON', retryable: true });
  }
  try {
    return JSON.parse(text.slice(start, end + 1));
  } catch {
    throw new AiError('Respons model bukan JSON valid.', { code: 'AI_BAD_JSON', retryable: true });
  }
}

async function postJson(url, { headers, body, timeoutMs, fetchImpl = fetch }) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    return await fetchImpl(url, { method: 'POST', headers, body: JSON.stringify(body), signal: ctrl.signal });
  } finally {
    clearTimeout(timer);
  }
}

function explainHttpStatus(status, body, provider, model, headers = null) {
  const text = String(body || '');
  const lower = text.toLowerCase();
  const rl = parseRateLimitHeaders(headers);

  if (status === 401 || status === 403) {
    return new AiError(
      `Provider AI (${provider}) menolak kredensial (HTTP ${status}). Periksa kunci API pada server/.env.`,
      { code: `AI_AUTH_${status}`, status: 503, retryable: false, provider, model },
    );
  }
  if (status === 404) {
    return new AiError(
      `Model atau endpoint tidak ditemukan di provider AI (${provider}/${model}, HTTP 404).`,
      { code: 'AI_MODEL_NOT_FOUND', status: 503, retryable: true, provider, model },
    );
  }
  const isDailyOrAccountQuota = status === 402
    || (status === 429 && /quota|credit|exhausted|balance|insufficient|daily limit|free-models-per-day|per day/i.test(lower));
  if (isDailyOrAccountQuota) {
    return new AiError(
      `Kuota provider AI (${provider}) habis atau terlampaui (HTTP ${status}).`,
      {
        code: 'AI_QUOTA_EXHAUSTED',
        status: 429,
        retryable: true,
        provider,
        model,
        retryAfter: rl.retryAfterSeconds,
        estimatedRetryAt: rl.resetTimestamp,
        accountLevel: provider === 'openrouter' || /daily|account|quota/i.test(lower),
      },
    );
  }
  if (status === 429) {
    return new AiError(
      `Provider AI (${provider}) membatasi permintaan (HTTP 429).`,
      {
        code: 'AI_RATE_LIMIT',
        status: 429,
        retryable: true,
        provider,
        model,
        retryAfter: rl.retryAfterSeconds,
        estimatedRetryAt: rl.resetTimestamp,
        // OpenRouter's 20 RPM free-tier rate limit is shared at the account level
        accountLevel: provider === 'openrouter',
      },
    );
  }
  if (status === 400) {
    return new AiError(
      `Permintaan AI ditolak (${provider}, HTTP 400). ${text.slice(0, 200)}`,
      { code: 'AI_BAD_REQUEST', status: 400, retryable: false, provider, model },
    );
  }
  const retryable = status === 502 || status === 503 || status === 504 || status >= 500;
  return new AiError(
    `Provider AI (${provider}) menjawab HTTP ${status}. ${text.slice(0, 200)}`,
    { code: `AI_HTTP_${status}`, status: status === 503 || status === 504 ? status : 502, retryable, provider, model },
  );
}

function shouldFallback(err) {
  if (!(err instanceof AiError)) return true;
  if ([
    'AI_RATE_LIMIT',
    'AI_QUOTA_EXHAUSTED',
    'AI_TIMEOUT',
    'AI_UNREACHABLE',
    'AI_EMPTY',
    'AI_BAD_JSON',
    'AI_TRUNCATED',
    'AI_MODEL_NOT_FOUND',
    'AI_MODEL_UNAVAILABLE',
    'AI_PRICE_CHANGED_BLOCKED',
    'AI_HTTP_500',
    'AI_HTTP_502',
    'AI_HTTP_503',
    'AI_HTTP_504',
  ].includes(err.code)) {
    return true;
  }
  return Boolean(err.retryable);
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function calibrateIssues(parsed, text) {
  if (!parsed || !Array.isArray(parsed.issues) || typeof text !== 'string') return parsed;
  for (const issue of parsed.issues) {
    if (!issue || typeof issue !== 'object' || typeof issue.text !== 'string' || !issue.text) continue;
    const t = issue.text;
    const start = Number(issue.start);
    if (Number.isInteger(start) && text.slice(start, start + t.length) === t) {
      issue.end = start + t.length;
      continue;
    }
    let best = -1;
    let minDiff = Infinity;
    let from = 0;
    while (from < text.length) {
      const idx = text.indexOf(t, from);
      if (idx === -1) break;
      const diff = Math.abs(idx - (Number.isInteger(start) ? start : 0));
      if (diff < minDiff) {
        minDiff = diff;
        best = idx;
      }
      from = idx + 1;
    }
    if (best !== -1 && minDiff <= 60) {
      issue.start = best;
      issue.end = best + t.length;
    }
  }
  return parsed;
}

async function invokeSingleProvider(cfg, {
  systemPrompt,
  userPrompt,
  useResponseFormat = true,
  maxRetries = 1,
  retryBaseDelayMs = 250,
  fetchImpl = fetch,
}) {
  const headers = {
    'Content-Type': 'application/json',
    Authorization: `Bearer ${cfg.apiKey}`,
  };
  if (cfg.provider === 'openrouter') {
    headers['HTTP-Referer'] = process.env.FRONTEND_URL || 'https://runut.local';
    headers['X-Title'] = 'Runut AI Writing Analysis';
  }

  // Never retry failed OpenRouter requests on the same model (failed requests may consume the 50/day free limit)
  const effectiveMaxRetries = cfg.provider === 'openrouter' ? 0 : Math.max(0, Math.min(2, Number(maxRetries) || 0));
  let attempt = 0;
  let allowResponseFormat = Boolean(useResponseFormat && cfg.supportsResponseFormat);

  while (true) {
    const body = {
      model: cfg.model,
      messages: [
        { role: 'system', content: systemPrompt },
        { role: 'user', content: userPrompt },
      ],
      temperature: 0.2,
    };
    if (allowResponseFormat) {
      body.response_format = { type: 'json_object' };
    }

    let res;
    try {
      res = await postJson(cfg.impl.endpoint(cfg.baseUrl), {
        headers,
        body,
        timeoutMs: cfg.timeoutMs,
        fetchImpl,
      });
    } catch (err) {
      if (err?.name === 'AbortError') {
        throw new AiError(`Permintaan AI (${cfg.provider}/${cfg.model}) melewati batas waktu ${cfg.timeoutMs} ms.`, {
          code: 'AI_TIMEOUT',
          status: 504,
          retryable: true,
          provider: cfg.provider,
          model: cfg.model,
        });
      }
      throw new AiError(`Tidak dapat menghubungi provider AI (${cfg.provider}) di ${cfg.baseUrl}: ${err.message}`, {
        code: 'AI_UNREACHABLE',
        status: 503,
        retryable: true,
        provider: cfg.provider,
        model: cfg.model,
      });
    }

    if (!res.ok) {
      const errBody = await res.text().catch(() => '');
      // If provider rejects response_format parameter, retry once without it
      if (res.status === 400 && allowResponseFormat && /response_format|json_object/i.test(errBody)) {
        allowResponseFormat = false;
        continue;
      }

      const aiErr = explainHttpStatus(res.status, errBody, cfg.provider, cfg.model, res.headers);
      if (aiErr.code === 'AI_QUOTA_EXHAUSTED' || aiErr.code === 'AI_RATE_LIMIT') {
        recordRateLimitState({
          provider: cfg.provider,
          model: cfg.model,
          headers: res.headers,
          rateLimitType: aiErr.code === 'AI_QUOTA_EXHAUSTED' ? 'daily_quota' : 'rate_limit',
          accountLevelExhausted: aiErr.accountLevel,
          cooldownMs: aiErr.retryAfter ? aiErr.retryAfter * 1000 : (aiErr.accountLevel ? 15 * 60 * 1000 : 30 * 1000),
        });
      }

      const canRetryHere = aiErr.retryable && aiErr.code !== 'AI_QUOTA_EXHAUSTED' && attempt < effectiveMaxRetries;
      if (canRetryHere) {
        const delayMs = aiErr.retryAfter !== null
          ? Math.min(aiErr.retryAfter * 1000, 2000)
          : Math.min(retryBaseDelayMs * (2 ** attempt), 2000);
        attempt += 1;
        await sleep(delayMs);
        continue;
      }
      throw aiErr;
    }

    const data = await res.json().catch(() => null);
    const choice = data?.choices?.[0];
    const content = choice?.message?.content;
    if (choice?.finish_reason === 'length') {
      throw new AiError(`Respons model (${cfg.provider}/${cfg.model}) terpotong (finish_reason=length).`, {
        code: 'AI_TRUNCATED',
        status: 502,
        retryable: true,
        provider: cfg.provider,
        model: cfg.model,
      });
    }
    if (typeof content !== 'string' || !content.trim()) {
      throw new AiError(`Respons model (${cfg.provider}/${cfg.model}) kosong.`, {
        code: 'AI_EMPTY',
        status: 502,
        retryable: true,
        provider: cfg.provider,
        model: cfg.model,
      });
    }

    return {
      content,
      usage: data?.usage || null,
      headers: res.headers || null,
      provider: cfg.provider,
      model: data?.model || cfg.model,
    };
  }
}

export async function callStructuredAi({
  systemPrompt,
  userPrompt,
  useResponseFormat = true,
  maxRetries = undefined,
  retryBaseDelayMs = 200,
  fetchImpl = fetch,
  confidential = false,
  userConsentForFreeTier = false,
  preferredProvider = null,
  nowMs = Date.now(),
} = {}, env = process.env) {
  const primary = resolvePrimaryConfig(env);
  if (!primary.impl) {
    throw new AiError(`Provider AI "${primary.provider}" belum diimplementasikan.`, {
      code: 'AI_BAD_PROVIDER',
      status: 503,
      retryable: false,
    });
  }

  // Enforce strict zero-cost & deprecation policy on primary immediately if configured
  if (primary.configured) {
    assertFreeModelPolicy(primary.provider, primary.model, env);
  }

  const fallbacks = resolveFallbackChain(primary, env);
  let candidates = [];
  if (primary.configured) candidates.push({ ...primary, isPrimary: true });
  for (const fb of fallbacks) candidates.push({ ...fb, isPrimary: false });

  if (preferredProvider) {
    const pref = String(preferredProvider).toLowerCase();
    candidates.sort((a, b) => (a.provider === pref ? -1 : (b.provider === pref ? 1 : 0)));
  }

  if (candidates.length === 0) {
    throw new AiError(
      'Konfigurasi AI belum lengkap. Isi OPENROUTER_API_KEY atau GEMINI_API_KEY di server/.env lalu coba lagi.',
      { code: 'AI_NOT_CONFIGURED', status: 503, retryable: false },
    );
  }

  const maxProviderAttempts = Math.max(
    1,
    Math.min(10, Number(env.AI_MAX_PROVIDER_ATTEMPTS || 5)),
  );
  const perProviderRetries = maxRetries !== undefined
    ? maxRetries
    : Number(env.AI_MAX_RETRIES_PER_PROVIDER ?? 1);

  const started = Date.now();
  let primaryError = null;
  const errors = [];
  let attemptsMade = 0;
  let skippedForPrivacy = 0;
  let skippedForCooldown = 0;
  const authFailedProviders = new Set();

  for (const candidate of candidates) {
    if (attemptsMade >= maxProviderAttempts) break;
    if (authFailedProviders.has(candidate.provider)) continue;

    // Privacy gate: skip providers prohibited for confidential/personal documents
    const privacy = isModelEligibleForPrivacy(candidate.provider, candidate.model, {
      confidential,
      userConsentForFreeTier,
    });
    if (!privacy.eligible) {
      skippedForPrivacy += 1;
      continue;
    }

    // OpenRouter shared account daily quota check: skip all remaining OpenRouter variants
    if (candidate.provider === 'openrouter' && isOpenRouterAccountExhausted(nowMs)) {
      skippedForCooldown += 1;
      continue;
    }

    // Per-provider/model cooldown check
    const cooldown = isProviderInCooldown(candidate.provider, candidate.model, nowMs);
    if (cooldown.inCooldown) {
      skippedForCooldown += 1;
      continue;
    }

    // Enforce zero-cost policy on every candidate before touching network
    try {
      assertFreeModelPolicy(candidate.provider, candidate.model, env);
    } catch (policyErr) {
      errors.push({ provider: candidate.provider, model: candidate.model, err: policyErr });
      if (candidate.isPrimary && candidates.length === 1) throw policyErr;
      continue;
    }

    attemptsMade += 1;
    const isFallbackAttempt = attemptsMade > 1 || !candidate.isPrimary;

    try {
      const out = await invokeSingleProvider(candidate, {
        systemPrompt,
        userPrompt,
        useResponseFormat,
        maxRetries: isFallbackAttempt ? 0 : perProviderRetries,
        retryBaseDelayMs,
        fetchImpl,
      });
      const parsed = extractJson(out.content);
      recordAiRequest({
        provider: out.provider,
        model: out.model,
        success: true,
        fallbackUsed: isFallbackAttempt,
        usage: out.usage,
        headers: out.headers,
      });
      return {
        parsed,
        latencyMs: Date.now() - started,
        provider: out.provider,
        model: out.model,
        fallbackUsed: isFallbackAttempt,
        primaryError: primaryError ? { code: primaryError.code, message: primaryError.message } : null,
        usage: out.usage,
      };
    } catch (err) {
      if (!primaryError && candidate.isPrimary) primaryError = err;
      errors.push({ provider: candidate.provider, model: candidate.model, err });
      recordAiRequest({
        provider: candidate.provider,
        model: candidate.model,
        success: false,
        fallbackUsed: isFallbackAttempt,
        error: err.message,
      });

      // Do not fail over on auth/bad-request when there are no other configured candidates
      if (!shouldFallback(err)) {
        if (err.code === 'AI_AUTH_401' || err.code === 'AI_AUTH_403') {
          authFailedProviders.add(candidate.provider);
          const hasOtherProvider = candidates.some((c) => !authFailedProviders.has(c.provider));
          if (hasOtherProvider) continue;
        }
        throw err;
      }
    }
  }

  if (attemptsMade === 0 && skippedForPrivacy > 0) {
    throw new AiError(
      'Tidak ada provider AI gratis yang memenuhi kebijakan privasi untuk dokumen rahasia/pribadi ini.',
      { code: 'AI_PRIVACY_NO_ELIGIBLE_PROVIDER', status: 503, retryable: false },
    );
  }

  const allErrors = errors.map((x) => x.err).filter(Boolean);
  const allQuota = (allErrors.length > 0 && allErrors.every((e) => e.code === 'AI_QUOTA_EXHAUSTED' || e.code === 'AI_RATE_LIMIT'))
    || (attemptsMade === 0 && skippedForCooldown > 0);
  const estimatedRetryAt = getEarliestCooldownResetIso(nowMs);

  if (allQuota) {
    throw new AiError(
      `Seluruh kuota layanan AI gratis sementara penuh.${estimatedRetryAt ? ` Estimasi tersedia kembali sekitar ${estimatedRetryAt}.` : ''} Token Anda tidak dipotong; silakan coba lagi nanti.`,
      {
        code: 'AI_FREE_QUOTA_EXHAUSTED',
        status: 503,
        retryable: true,
        estimatedRetryAt,
      },
    );
  }

  const lastErr = allErrors[allErrors.length - 1];
  if (primaryError && errors.length > 1) {
    const fbSummary = errors.slice(1).map((x) => `${x.provider}/${x.model}: ${x.err.message}`).join(' | ');
    throw new AiError(
      `Provider utama (${primary.provider}) dan cadangan gratis gagal: ${primaryError.message}${fbSummary ? ' | Fallback: ' + fbSummary : ''}`,
      {
        code: lastErr?.code || primaryError.code || 'AI_ALL_FAILED',
        status: lastErr?.status || 503,
        retryable: true,
        estimatedRetryAt,
      },
    );
  }

  throw lastErr || primaryError || new AiError('Seluruh provider AI gratis sementara tidak tersedia.', {
    code: 'AI_ALL_FAILED',
    status: 503,
    retryable: true,
    estimatedRetryAt,
  });
}

// Document-level editing specification passed identically to every fallback model
// so document style and terminology stay consistent even if failover occurs mid-document.
export function buildDocumentEditingSpec({
  language = 'id',
  documentType = 'general_writing',
  writingProfile = null,
  editingMode = 'contextual_revision',
  tone = '',
  audience = '',
  purpose = '',
  terminology = [],
  sectionContext = '',
} = {}) {
  return {
    language,
    document_type: documentType,
    writing_style: writingProfile || documentType,
    editing_mode: editingMode,
    formality: tone || 'preserve_original',
    audience: audience || 'preserve_original',
    purpose: purpose || 'clarity_and_coherence',
    terminology: Array.isArray(terminology) ? terminology.slice(0, 20) : [],
    factual_constraints: 'Preserve all facts, figures, dates, names, formulas, and technical identifiers verbatim.',
    citation_handling: 'Preserve all in-text citations, reference keys, and bibliography entries verbatim.',
    section_context: sectionContext || '',
  };
}

export async function analyzeWithProvider(
  text,
  {
    maxIssues = 30,
    evidence = '',
    language = null,
    documentType = null,
    writingProfile = null,
    editingMode = 'contextual_revision',
    tone = '',
    audience = '',
    purpose = '',
    sectionHint = '',
    confidential = false,
    userConsentForFreeTier = false,
    fetchImpl = fetch,
    retryBaseDelayMs = 200,
  } = {},
  env = process.env,
) {
  const detectedLang = language || detectDocumentLanguage(text);
  const detectedType = documentType || detectDocumentType(text);
  const editingSpec = buildDocumentEditingSpec({
    language: detectedLang,
    documentType: detectedType,
    writingProfile,
    editingMode,
    tone,
    audience,
    purpose,
    sectionContext: sectionHint,
  });

  const systemPrompt = buildWritingSystemPrompt({
    language: detectedLang,
    documentType: detectedType,
    writingProfile,
    editingMode,
    tone,
    audience,
    purpose,
  });
  const userPrompt = buildWritingUserPrompt(text, {
    maxIssues,
    evidence,
    language: detectedLang,
    sectionHint: sectionHint || JSON.stringify(editingSpec),
  });

  const result = await callStructuredAi({
    systemPrompt,
    userPrompt,
    useResponseFormat: true,
    retryBaseDelayMs,
    fetchImpl,
    confidential,
    userConsentForFreeTier,
  }, env);

  return {
    ...result,
    parsed: calibrateIssues(result.parsed, text),
    language: detectedLang,
    documentType: detectedType,
    editingSpec,
  };
}

// Stage A: Content Editing AI — revises ONLY editable text blocks using stable block IDs.
// Never regenerates document structure, tables, styles, or template definitions.
export async function reviseDocumentBlocksWithAi({
  documentId,
  language = 'id',
  blocks = [],
  editingSpec = null,
  maxGrowthRatio = 1.15,
  shorterRetry = false,
  confidential = false,
  userConsentForFreeTier = false,
  fetchImpl = fetch,
  retryBaseDelayMs = 100,
} = {}, env = process.env) {
  const editableBlocks = (Array.isArray(blocks) ? blocks : []).filter((b) => b && b.editable !== false && b.block_id);
  const spec = editingSpec || buildDocumentEditingSpec({ language });

  const userPrompt = JSON.stringify({
    instruction: shorterRetry
      ? `Shorten the revised text so each block stays within ${Math.round(maxGrowthRatio * 100)}% of its original character length while preserving meaning.`
      : 'Revise each editable block to improve grammar, clarity, and natural flow while preserving exact meaning, facts, citations, and comparable length.',
    document_id: documentId || 'doc-001',
    editing_specification: spec,
    max_text_growth_ratio: maxGrowthRatio,
    editable_blocks: editableBlocks.map((b) => ({
      block_id: b.block_id,
      type: b.type || 'paragraph',
      section: b.section || null,
      original_text: b.original_text ?? b.text ?? '',
    })),
    required_output_schema: {
      document_id: documentId || 'doc-001',
      language,
      replacements: [{ block_id: '<exact block_id>', revised_text: '<revised text>' }],
    },
  });

  const result = await callStructuredAi({
    systemPrompt: DOCUMENT_CONTENT_REVISION_SYSTEM_PROMPT,
    userPrompt,
    useResponseFormat: true,
    retryBaseDelayMs,
    fetchImpl,
    confidential,
    userConsentForFreeTier,
  }, env);

  return {
    ...result,
    replacements: Array.isArray(result.parsed?.replacements) ? result.parsed.replacements : [],
    editingSpec: spec,
  };
}

// Stage B: Template Mapping & Validation (prefers Gemini Free, falls back to structured-output free models).
// Never manipulates binary/XML document files; returns structured validation verdict only.
export async function validateBlockReplacementsWithAi({
  documentId,
  manifestBlocks = [],
  replacements = [],
  confidential = false,
  userConsentForFreeTier = false,
  fetchImpl = fetch,
  retryBaseDelayMs = 100,
} = {}, env = process.env) {
  const systemPrompt = [
    'You are RUNUT template mapping and replacement validator.',
    'Verify that every replacement maps to a valid editable block_id, no block is missing or duplicated, no citations/numbers/placeholders were lost, and no unsupported content was introduced.',
    'Return ONLY valid JSON: {"valid":true|false,"missing_block_ids":[],"duplicate_block_ids":[],"unknown_block_ids":[],"issues":[{"block_id":"...","reason":"..."}]}.',
  ].join('\n');

  const userPrompt = JSON.stringify({
    document_id: documentId || 'doc-001',
    original_blocks: manifestBlocks.map((b) => ({
      block_id: b.block_id,
      editable: b.editable !== false,
      original_text: b.original_text ?? b.text ?? '',
    })),
    replacements,
  });

  const result = await callStructuredAi({
    systemPrompt,
    userPrompt,
    useResponseFormat: true,
    preferredProvider: 'gemini',
    retryBaseDelayMs,
    fetchImpl,
    confidential,
    userConsentForFreeTier,
  }, env);

  return {
    ...result,
    validation: result.parsed || { valid: false, issues: [{ reason: 'Empty validation response' }] },
  };
}
