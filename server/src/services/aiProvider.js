// AI Provider layer: OpenRouter Particle-1 Free (primary) + Gemini (automatic fallback)
// Also preserves backward compatibility with explicit 9router / openai / gemini configurations.
import {
  buildWritingSystemPrompt,
  buildWritingUserPrompt,
  detectDocumentLanguage,
  detectDocumentType,
} from './prompts/writingEngine.js';
import { recordAiRequest } from './aiQuota.js';

export const DEFAULT_OPENROUTER_BASE_URL = 'https://openrouter.ai/api/v1';
export const DEFAULT_OPENROUTER_MODEL = 'particle-ai/particle-1:free';
export const DEFAULT_GEMINI_BASE_URL = 'https://generativelanguage.googleapis.com/v1beta/openai';
export const DEFAULT_GEMINI_MODEL = 'gemini-3.1-flash-lite';
export const DEFAULT_GROQ_BASE_URL = 'https://api.groq.com/openai/v1';
export const DEFAULT_GROQ_MODEL = 'llama-3.3-70b-versatile';

export const FREE_PROVIDER_ALLOWLIST = new Set(['openrouter', 'gemini', 'groq', '9router']);

export function isStrictFreeOnly(env = process.env) {
  return String(env.STRICT_FREE_AI_ONLY ?? 'true').trim().toLowerCase() !== 'false';
}

export function assertFreeModelPolicy(provider, model, env = process.env) {
  if (!isStrictFreeOnly(env)) return;
  if (!FREE_PROVIDER_ALLOWLIST.has(provider)) {
    throw new AiError(
      `Provider AI berbayar "${provider}" diblokir oleh kebijakan zero-cost (STRICT_FREE_AI_ONLY=true). Gunakan OpenRouter (:free), Google Gemini Free Tier, atau Groq Free Tier.`,
      { code: 'AI_PAID_PROVIDER_BLOCKED', status: 503, retryable: false, provider },
    );
  }
  if (provider === 'openrouter' && !/:free$/i.test(String(model || '').trim())) {
    throw new AiError(
      `Model OpenRouter "${model}" bukan model gratis (wajib berakhiran ":free") dan diblokir oleh kebijakan zero-cost.`,
      { code: 'AI_PAID_MODEL_BLOCKED', status: 503, retryable: false, provider },
    );
  }
}

export class AiError extends Error {
  constructor(message, { code = 'AI_ERROR', status = 502, retryable = true, provider = null } = {}) {
    super(message);
    this.code = code;
    this.status = status;
    this.retryable = retryable;
    this.provider = provider;
  }
}

const PROVIDERS = {
  openrouter: {
    label: 'OpenRouter',
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
    label: 'Groq (Free Tier)',
    requiresApiKey: true,
    defaultBaseUrl: DEFAULT_GROQ_BASE_URL,
    supportsResponseFormat: true,
    endpoint: (baseUrl) => `${baseUrl}/chat/completions`,
  },
  '9router': {
    label: '9Router',
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

function resolvePrimaryConfig(env = process.env) {
  // Respect explicit AI_PROVIDER if set; default to openrouter if OPENROUTER_API_KEY is set, else legacy 9router/gemini
  const explicitProvider = String(env.AI_PROVIDER || '').trim().toLowerCase();
  const provider = explicitProvider || (env.OPENROUTER_API_KEY ? 'openrouter' : 'openrouter');
  const impl = PROVIDERS[provider];

  let baseUrl = '';
  let apiKey = '';
  let model = '';

  if (provider === 'openrouter') {
    baseUrl = String(env.OPENROUTER_BASE_URL || env.AI_BASE_URL || impl.defaultBaseUrl).replace(/\/$/, '');
    apiKey = env.OPENROUTER_API_KEY || env.AI_API_KEY || '';
    model = env.OPENROUTER_MODEL || env.AI_MODEL || DEFAULT_OPENROUTER_MODEL;
  } else if (provider === 'gemini') {
    baseUrl = String(env.AI_BASE_URL || impl.defaultBaseUrl).replace(/\/$/, '');
    apiKey = env.GEMINI_API_KEY || env.AI_API_KEY || '';
    model = env.GEMINI_MODEL || env.AI_MODEL || DEFAULT_GEMINI_MODEL;
  } else if (provider === 'groq') {
    baseUrl = String(env.GROQ_BASE_URL || env.AI_BASE_URL || impl.defaultBaseUrl).replace(/\/$/, '');
    apiKey = env.GROQ_API_KEY || env.AI_API_KEY || '';
    model = env.GROQ_MODEL || env.AI_MODEL || DEFAULT_GROQ_MODEL;
  } else {
    baseUrl = String(env.AI_BASE_URL || impl?.defaultBaseUrl || '').replace(/\/$/, '');
    apiKey = env.AI_API_KEY || '';
    model = env.AI_MODEL || '';
  }

  const timeoutMs = Number(env.AI_TIMEOUT_MS || 90000);
  const configured = Boolean(impl && baseUrl && model && (!impl.requiresApiKey || apiKey));

  return { provider, impl, baseUrl, apiKey, model, timeoutMs, configured };
}

function resolveFallbackChain(primaryProvider, env = process.env) {
  const timeoutMs = Number(env.AI_TIMEOUT_MS || 90000);
  const chain = [];

  if (primaryProvider !== 'gemini') {
    const apiKey = String(env.GEMINI_API_KEY || '').trim();
    const model = String(env.GEMINI_MODEL || DEFAULT_GEMINI_MODEL).trim();
    const baseUrl = String(env.GEMINI_BASE_URL || DEFAULT_GEMINI_BASE_URL).replace(/\/$/, '');
    if (apiKey && model) {
      chain.push({ provider: 'gemini', impl: PROVIDERS.gemini, baseUrl, apiKey, model, timeoutMs, configured: true });
    }
  }

  if (primaryProvider !== 'groq') {
    const apiKey = String(env.GROQ_API_KEY || '').trim();
    const model = String(env.GROQ_MODEL || DEFAULT_GROQ_MODEL).trim();
    const baseUrl = String(env.GROQ_BASE_URL || DEFAULT_GROQ_BASE_URL).replace(/\/$/, '');
    if (apiKey && model) {
      chain.push({ provider: 'groq', impl: PROVIDERS.groq, baseUrl, apiKey, model, timeoutMs, configured: true });
    }
  }

  if (primaryProvider !== 'openrouter') {
    const apiKey = String(env.OPENROUTER_API_KEY || '').trim();
    const model = String(env.OPENROUTER_MODEL || DEFAULT_OPENROUTER_MODEL).trim();
    const baseUrl = String(env.OPENROUTER_BASE_URL || DEFAULT_OPENROUTER_BASE_URL).replace(/\/$/, '');
    if (apiKey && /:free$/i.test(model)) {
      chain.push({ provider: 'openrouter', impl: PROVIDERS.openrouter, baseUrl, apiKey, model, timeoutMs, configured: true });
    }
  }

  return chain;
}

export function getProviderInfo(env = process.env) {
  const primary = resolvePrimaryConfig(env);
  const fallbacks = resolveFallbackChain(primary.provider, env);
  const firstFallback = fallbacks[0] || null;
  return {
    provider: primary.provider,
    baseUrl: primary.baseUrl,
    model: primary.model,
    timeoutMs: primary.timeoutMs,
    configured: primary.configured,
    zero_cost_enforced: isStrictFreeOnly(env),
    fallback: firstFallback
      ? {
          provider: firstFallback.provider,
          model: firstFallback.model,
          configured: true,
        }
      : {
          provider: 'gemini',
          model: String(env.GEMINI_MODEL || DEFAULT_GEMINI_MODEL),
          configured: false,
        },
    fallback_chain: fallbacks.map((f) => ({ provider: f.provider, model: f.model, configured: true })),
  };
}

export function extractJson(raw) {
  const text = String(raw || '').trim();
  const start = text.indexOf('{');
  const end = text.lastIndexOf('}');
  if (start === -1 || end === -1 || end <= start) {
    throw new AiError('Respons model tidak memuat JSON.', { code: 'AI_BAD_JSON', retryable: false });
  }
  try {
    return JSON.parse(text.slice(start, end + 1));
  } catch {
    throw new AiError('Respons model bukan JSON valid.', { code: 'AI_BAD_JSON', retryable: false });
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

function parseRetryAfterMs(headerVal) {
  if (!headerVal) return null;
  const num = Number(headerVal);
  if (Number.isFinite(num) && num >= 0) return Math.min(num * 1000, 5000);
  const dateMs = Date.parse(headerVal);
  if (Number.isFinite(dateMs)) {
    const diff = dateMs - Date.now();
    return diff > 0 ? Math.min(diff, 5000) : 0;
  }
  return null;
}

function explainHttpStatus(status, body, provider) {
  const text = String(body || '');
  const lower = text.toLowerCase();
  if (status === 401 || status === 403) {
    return new AiError(
      `Provider AI (${provider}) menolak kredensial (HTTP ${status}). Periksa kunci API pada server/.env.`,
      { code: `AI_AUTH_${status}`, status: 503, retryable: false, provider },
    );
  }
  if (status === 404) {
    return new AiError(
      `Model atau endpoint tidak ditemukan di provider AI (${provider}, HTTP 404). Periksa model dan base URL.`,
      { code: 'AI_MODEL_NOT_FOUND', status: 503, retryable: false, provider },
    );
  }
  if (status === 402 || (status === 429 && /quota|credit|exhausted|balance|insufficient|daily limit/.test(lower))) {
    return new AiError(
      `Kuota provider AI (${provider}) habis atau terlampaui (HTTP ${status}).`,
      { code: 'AI_QUOTA_EXHAUSTED', status: 429, retryable: true, provider },
    );
  }
  if (status === 429) {
    return new AiError(
      `Provider AI (${provider}) membatasi permintaan (HTTP 429). Coba lagi beberapa saat.`,
      { code: 'AI_RATE_LIMIT', status: 429, retryable: true, provider },
    );
  }
  if (status === 400) {
    return new AiError(
      `Permintaan AI ditolak (${provider}, HTTP 400). ${text.slice(0, 200)}`,
      { code: 'AI_BAD_REQUEST', status: 400, retryable: false, provider },
    );
  }
  const retryable = status === 502 || status === 503 || status === 504 || status >= 500;
  return new AiError(
    `Provider AI (${provider}) menjawab HTTP ${status}. ${text.slice(0, 200)}`,
    { code: `AI_HTTP_${status}`, status: status === 503 || status === 504 ? status : 502, retryable, provider },
  );
}

function shouldFallback(err) {
  if (!(err instanceof AiError)) return true;
  if (err.code === 'AI_RATE_LIMIT' || err.code === 'AI_QUOTA_EXHAUSTED') return true;
  if (err.code === 'AI_TIMEOUT' || err.code === 'AI_UNREACHABLE') return true;
  if (err.code === 'AI_HTTP_502' || err.code === 'AI_HTTP_503' || err.code === 'AI_HTTP_504') return true;
  if (err.code === 'AI_HTTP_500' || err.retryable) return true;
  return false;
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

async function invokeSingleProvider(cfg, { systemPrompt, userPrompt, useResponseFormat = true, maxRetries = 1, retryBaseDelayMs = 250, fetchImpl = fetch }) {
  const headers = {
    'Content-Type': 'application/json',
    Authorization: `Bearer ${cfg.apiKey}`,
  };
  if (cfg.provider === 'openrouter') {
    headers['HTTP-Referer'] = process.env.FRONTEND_URL || 'https://runut.local';
    headers['X-Title'] = 'Runut AI Writing Analysis';
  }

  let attempt = 0;
  let allowResponseFormat = Boolean(useResponseFormat && cfg.impl.supportsResponseFormat);

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
        throw new AiError(`Permintaan AI (${cfg.provider}) melewati batas waktu ${cfg.timeoutMs} ms.`, {
          code: 'AI_TIMEOUT',
          status: 504,
          retryable: true,
          provider: cfg.provider,
        });
      }
      throw new AiError(`Tidak dapat menghubungi provider AI (${cfg.provider}) di ${cfg.baseUrl}: ${err.message}`, {
        code: 'AI_UNREACHABLE',
        status: 503,
        retryable: true,
        provider: cfg.provider,
      });
    }

    if (!res.ok) {
      const errBody = await res.text().catch(() => '');
      // If provider rejects response_format parameter, retry once without it
      if (res.status === 400 && allowResponseFormat && /response_format/i.test(errBody)) {
        allowResponseFormat = false;
        continue;
      }

      const aiErr = explainHttpStatus(res.status, errBody, cfg.provider);
      // Do not retry quota exhaustion or non-retryable errors on the same provider
      const canRetryHere = aiErr.retryable && aiErr.code !== 'AI_QUOTA_EXHAUSTED' && attempt < maxRetries;
      if (canRetryHere) {
        const retryAfter = parseRetryAfterMs(res.headers?.get?.('retry-after'));
        const delayMs = retryAfter !== null ? retryAfter : retryBaseDelayMs * (2 ** attempt);
        attempt += 1;
        await sleep(Math.min(delayMs, 2000));
        continue;
      }
      throw aiErr;
    }

    const data = await res.json().catch(() => null);
    const content = data?.choices?.[0]?.message?.content;
    if (typeof content !== 'string' || !content.trim()) {
      throw new AiError(`Respons model (${cfg.provider}) kosong.`, {
        code: 'AI_EMPTY',
        status: 502,
        retryable: false,
        provider: cfg.provider,
      });
    }

    return {
      content,
      usage: data?.usage || null,
      provider: cfg.provider,
      model: data?.model || cfg.model,
    };
  }
}

export async function callStructuredAi({
  systemPrompt,
  userPrompt,
  useResponseFormat = true,
  maxRetries = 1,
  retryBaseDelayMs = 200,
  fetchImpl = fetch,
} = {}, env = process.env) {
  const primary = resolvePrimaryConfig(env);
  if (!primary.impl) {
    throw new AiError(`Provider AI "${primary.provider}" belum diimplementasikan.`, {
      code: 'AI_BAD_PROVIDER',
      status: 503,
      retryable: false,
    });
  }

  // Enforce strict zero-cost policy: block paid providers or non-:free OpenRouter models
  if (primary.configured) {
    assertFreeModelPolicy(primary.provider, primary.model, env);
  }

  const fallbacks = resolveFallbackChain(primary.provider, env);

  if (!primary.configured && fallbacks.length === 0) {
    throw new AiError(
      'Konfigurasi AI belum lengkap. Isi OPENROUTER_API_KEY, GEMINI_API_KEY, atau GROQ_API_KEY di server/.env lalu coba lagi.',
      { code: 'AI_NOT_CONFIGURED', status: 503, retryable: false },
    );
  }

  const started = Date.now();
  let primaryError = null;

  if (primary.configured) {
    try {
      const out = await invokeSingleProvider(primary, {
        systemPrompt,
        userPrompt,
        useResponseFormat,
        maxRetries,
        retryBaseDelayMs,
        fetchImpl,
      });
      const parsed = extractJson(out.content);
      recordAiRequest({ provider: out.provider, success: true, fallbackUsed: false, usage: out.usage });
      return {
        parsed,
        latencyMs: Date.now() - started,
        provider: out.provider,
        model: out.model,
        fallbackUsed: false,
        primaryError: null,
        usage: out.usage,
      };
    } catch (err) {
      primaryError = err;
      recordAiRequest({ provider: primary.provider, success: false, fallbackUsed: false, error: err.message });
      if (fallbacks.length === 0 || !shouldFallback(err)) {
        throw err;
      }
    }
  }

  // Automatic free-only fallback chain (Gemini Free -> Groq Free -> OpenRouter :free)
  const fallbackErrors = [];
  for (const fb of fallbacks) {
    assertFreeModelPolicy(fb.provider, fb.model, env);
    try {
      const out = await invokeSingleProvider(fb, {
        systemPrompt,
        userPrompt,
        useResponseFormat,
        maxRetries: 0,
        retryBaseDelayMs,
        fetchImpl,
      });
      const parsed = extractJson(out.content);
      recordAiRequest({ provider: out.provider, success: true, fallbackUsed: true, usage: out.usage });
      return {
        parsed,
        latencyMs: Date.now() - started,
        provider: out.provider,
        model: out.model,
        fallbackUsed: true,
        primaryError: primaryError ? { code: primaryError.code, message: primaryError.message } : null,
        usage: out.usage,
      };
    } catch (fbErr) {
      recordAiRequest({ provider: fb.provider, success: false, fallbackUsed: true, error: fbErr.message });
      fallbackErrors.push({ provider: fb.provider, err: fbErr });
      if (!shouldFallback(fbErr)) break;
    }
  }

  const lastFb = fallbackErrors[fallbackErrors.length - 1]?.err;
  const allQuota = [primaryError, ...fallbackErrors.map((x) => x.err)]
    .filter(Boolean)
    .every((e) => e.code === 'AI_QUOTA_EXHAUSTED' || e.code === 'AI_RATE_LIMIT');

  if (primaryError) {
    const fbSummary = fallbackErrors.map((x) => `${x.provider}: ${x.err.message}`).join(' | ');
    throw new AiError(
      allQuota
        ? 'Seluruh kuota layanan AI gratis sementara penuh. Token Anda tidak dipotong; silakan coba beberapa saat lagi.'
        : `Provider utama (${primary.provider}) dan cadangan gratis gagal: ${primaryError.message}${fbSummary ? ' | Fallback: ' + fbSummary : ''}`,
      {
        code: allQuota ? 'AI_FREE_QUOTA_EXHAUSTED' : (lastFb?.code || primaryError.code || 'AI_ALL_FAILED'),
        status: allQuota ? 503 : (lastFb?.status || 503),
        retryable: true,
      },
    );
  }
  throw lastFb || new AiError('Seluruh provider AI gratis sementara tidak tersedia.', { code: 'AI_ALL_FAILED', status: 503, retryable: true });
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
    fetchImpl = fetch,
    retryBaseDelayMs = 200,
  } = {},
  env = process.env,
) {
  const detectedLang = language || detectDocumentLanguage(text);
  const detectedType = documentType || detectDocumentType(text);
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
    sectionHint,
  });

  const result = await callStructuredAi({
    systemPrompt,
    userPrompt,
    useResponseFormat: true,
    maxRetries: 1,
    retryBaseDelayMs,
    fetchImpl,
  }, env);

  return {
    ...result,
    parsed: calibrateIssues(result.parsed, text),
    language: detectedLang,
    documentType: detectedType,
  };
}
