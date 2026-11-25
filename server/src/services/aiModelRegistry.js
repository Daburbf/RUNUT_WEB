// Explicit Free Model Registry & Zero-Cost Policy Enforcement for RUNUT.
// Enforces STRICT_FREE_AI_ONLY=true centrally: blocks paid providers, retired models,
// unknown OpenRouter models, and models whose live catalog pricing is non-zero.

export const DEFAULT_OPENROUTER_BASE_URL = 'https://openrouter.ai/api/v1';
export const DEFAULT_OPENROUTER_PRIMARY_MODEL = 'particle-ai/particle-1:free';
export const DEFAULT_OPENROUTER_FALLBACK_1 = 'baidu/ernie-5.5-flash-preview:free';
export const DEFAULT_OPENROUTER_FALLBACK_2 = 'inclusionai/ling-3.2-flash:free';
export const DEFAULT_OPENROUTER_DYNAMIC_MODEL = 'openrouter/free';
export const OPTIONAL_OPENROUTER_NEMOTRON_MODEL = 'nvidia/nemotron-3-ultra-550b-a55b:free';

export const DEFAULT_GEMINI_BASE_URL = 'https://generativelanguage.googleapis.com/v1beta/openai';
export const DEFAULT_GEMINI_MODEL = 'gemini-3.1-flash-lite';

export const DEFAULT_GROQ_BASE_URL = 'https://api.groq.com/openai/v1';

// Explicitly retired/deprecated models that MUST be rejected.
export const DEPRECATED_MODELS = new Map([
  ['llama-3.3-70b-versatile', 'Model llama-3.3-70b-versatile telah dihentikan (retired) oleh Groq pada 16 Agustus 2026 dan tidak boleh digunakan lagi.'],
]);

// Explicitly permitted free OpenRouter model IDs.
export const ALLOWED_OPENROUTER_FREE_MODELS = new Set([
  DEFAULT_OPENROUTER_PRIMARY_MODEL,
  DEFAULT_OPENROUTER_FALLBACK_1,
  DEFAULT_OPENROUTER_FALLBACK_2,
  DEFAULT_OPENROUTER_DYNAMIC_MODEL,
  OPTIONAL_OPENROUTER_NEMOTRON_MODEL,
]);

// Providers permitted under STRICT_FREE_AI_ONLY=true (9router kept for local test stubs).
export const FREE_PROVIDER_ALLOWLIST = new Set(['openrouter', 'gemini', 'groq', '9router']);

// Paid providers explicitly prohibited under zero-cost policy.
export const PAID_PROVIDER_BLOCKLIST = new Set([
  'openai',
  'anthropic',
  'claude',
  'deepseek',
  'deepseek-direct',
  'azure',
  'bedrock',
]);

// Explicit Free Model Registry metadata.
export const FREE_MODEL_REGISTRY = Object.freeze([
  {
    id: 'openrouter:particle-1',
    provider: 'openrouter',
    model: DEFAULT_OPENROUTER_PRIMARY_MODEL,
    role: 'primary_content',
    priority: 1,
    free: true,
    supportsResponseFormat: true,
    supportsStructuredJson: true,
    allowConfidential: true,
    requiresUserConsentForTraining: false,
    dataUsePolicy: 'OpenRouter free tier routing; verify provider retention settings for sensitive documents.',
    sharedAccountQuota: true,
    documentedLimits: { requestsPerDay: 50, requestsPerMinute: 20, scope: 'openrouter_free_account' },
    enabledByDefault: true,
  },
  {
    id: 'openrouter:ernie-5.5-flash-preview',
    provider: 'openrouter',
    model: DEFAULT_OPENROUTER_FALLBACK_1,
    role: 'fallback_content_1',
    priority: 2,
    free: true,
    supportsResponseFormat: true,
    supportsStructuredJson: true,
    allowConfidential: true,
    requiresUserConsentForTraining: false,
    dataUsePolicy: 'OpenRouter free tier routing; shared account daily quota.',
    sharedAccountQuota: true,
    documentedLimits: { requestsPerDay: 50, requestsPerMinute: 20, scope: 'openrouter_free_account' },
    enabledByDefault: true,
  },
  {
    id: 'openrouter:ling-3.2-flash',
    provider: 'openrouter',
    model: DEFAULT_OPENROUTER_FALLBACK_2,
    role: 'fallback_content_2',
    priority: 3,
    free: true,
    supportsResponseFormat: true,
    supportsStructuredJson: true,
    allowConfidential: true,
    requiresUserConsentForTraining: false,
    dataUsePolicy: 'OpenRouter free tier routing; shared account daily quota.',
    sharedAccountQuota: true,
    documentedLimits: { requestsPerDay: 50, requestsPerMinute: 20, scope: 'openrouter_free_account' },
    enabledByDefault: true,
  },
  {
    id: 'openrouter:free-router',
    provider: 'openrouter',
    model: DEFAULT_OPENROUTER_DYNAMIC_MODEL,
    role: 'fallback_dynamic_router',
    priority: 4,
    free: true,
    supportsResponseFormat: true,
    supportsStructuredJson: true,
    allowConfidential: false, // Dynamic router must NOT be used for confidential/personal documents
    requiresUserConsentForTraining: false,
    dataUsePolicy: 'OpenRouter dynamic free-model router; never routes to paid models, but disallowed for confidential/personal documents because target upstream provider is dynamic.',
    sharedAccountQuota: true,
    documentedLimits: { requestsPerDay: 50, requestsPerMinute: 20, scope: 'openrouter_free_account' },
    enabledByDefault: true,
  },
  {
    id: 'openrouter:nemotron-3-ultra',
    provider: 'openrouter',
    model: OPTIONAL_OPENROUTER_NEMOTRON_MODEL,
    role: 'optional_content',
    priority: 5,
    free: true,
    supportsResponseFormat: false, // Does NOT enforce JSON via response_format; validated independently
    supportsStructuredJson: true,
    allowConfidential: false, // Explicit data-use warning: never send confidential/personal documents
    requiresUserConsentForTraining: true,
    dataUsePolicy: 'NVIDIA free endpoint on OpenRouter carries explicit data-use warnings; prohibited for confidential or personal documents.',
    sharedAccountQuota: true,
    documentedLimits: { requestsPerDay: 50, requestsPerMinute: 20, scope: 'openrouter_free_account' },
    enabledByDefault: false,
  },
  {
    id: 'gemini:3.1-flash-lite',
    provider: 'gemini',
    model: DEFAULT_GEMINI_MODEL,
    role: 'validation_and_fallback',
    priority: 6,
    free: true,
    supportsResponseFormat: true,
    supportsStructuredJson: true,
    allowConfidential: false, // Free-tier Google API usage may improve Google products without explicit consent
    requiresUserConsentForTraining: true,
    dataUsePolicy: 'Google AI Studio Free Tier data may be used to improve Google products; requires explicit disclosure and consent for confidential/personal documents.',
    sharedAccountQuota: false,
    dailyResetSchedule: 'midnight_pacific',
    documentedLimits: { scope: 'google_project_free_tier', reset: 'midnight_pacific' },
    enabledByDefault: true,
  },
]);

// Cached OpenRouter catalog metadata for live price=0 & availability verification.
const catalogCache = {
  fetchedAt: 0,
  ttlMs: 10 * 60 * 1000, // 10 minutes
  models: new Map(), // modelId -> { id, promptPrice, completionPrice, available, supportedParameters }
};

export function resetOpenRouterCatalogCache() {
  catalogCache.fetchedAt = 0;
  catalogCache.models.clear();
}

export function seedOpenRouterCatalogForTest(entries = []) {
  catalogCache.fetchedAt = Date.now();
  catalogCache.models.clear();
  for (const item of entries) {
    if (!item?.id) continue;
    catalogCache.models.set(item.id, {
      id: item.id,
      promptPrice: Number(item.pricing?.prompt ?? item.promptPrice ?? 0),
      completionPrice: Number(item.pricing?.completion ?? item.completionPrice ?? 0),
      available: item.available !== false,
      supportedParameters: Array.isArray(item.supported_parameters)
        ? item.supported_parameters
        : (Array.isArray(item.supportedParameters) ? item.supportedParameters : []),
    });
  }
}

export async function refreshOpenRouterCatalog({
  baseUrl = DEFAULT_OPENROUTER_BASE_URL,
  fetchImpl = fetch,
  force = false,
  timeoutMs = 5000,
} = {}) {
  const now = Date.now();
  if (!force && catalogCache.fetchedAt > 0 && (now - catalogCache.fetchedAt) < catalogCache.ttlMs && catalogCache.models.size > 0) {
    return { ok: true, cached: true, count: catalogCache.models.size };
  }

  const endpoint = `${String(baseUrl || DEFAULT_OPENROUTER_BASE_URL).replace(/\/$/, '')}/models`;
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await fetchImpl(endpoint, { method: 'GET', signal: ctrl.signal });
    if (!res.ok) {
      return { ok: false, status: res.status, reason: `OpenRouter catalog returned HTTP ${res.status}.` };
    }
    const payload = await res.json().catch(() => null);
    const list = Array.isArray(payload?.data) ? payload.data : [];
    const next = new Map();
    for (const item of list) {
      if (!item?.id) continue;
      next.set(item.id, {
        id: item.id,
        promptPrice: Number(item.pricing?.prompt ?? NaN),
        completionPrice: Number(item.pricing?.completion ?? NaN),
        available: true,
        supportedParameters: Array.isArray(item.supported_parameters) ? item.supported_parameters : [],
      });
    }
    if (next.size > 0) {
      catalogCache.models = next;
      catalogCache.fetchedAt = now;
    }
    return { ok: true, cached: false, count: next.size };
  } catch (err) {
    return { ok: false, reason: err?.message || 'Unable to fetch OpenRouter models catalog.' };
  } finally {
    clearTimeout(timer);
  }
}

export function verifyOpenRouterCatalogEntry(modelId, { requireCatalogMatch = false, baseUrl = '', env = process.env } = {}) {
  const cleanId = String(modelId || '').trim();
  if (!cleanId) {
    return { ok: false, code: 'AI_INVALID_MODEL', reason: 'Model ID OpenRouter kosong.' };
  }
  // Allow mock/*:free ONLY for local loopback HTTP stubs during NODE_ENV=test
  const isLocalTestStub = String(env.NODE_ENV || '').toLowerCase() === 'test'
    && /^https?:\/\/(127\.0\.0\.1|localhost)(:\d+)?/i.test(String(baseUrl || ''))
    && /^mock\/[a-z0-9._-]+:free$/i.test(cleanId);
  if (isLocalTestStub) {
    return { ok: true, entry: null };
  }
  // openrouter/free is the dynamic free router
  const isDynamicFree = cleanId === DEFAULT_OPENROUTER_DYNAMIC_MODEL;
  if (!isDynamicFree && !/:free$/i.test(cleanId)) {
    return { ok: false, code: 'AI_PAID_MODEL_BLOCKED', reason: `Model OpenRouter "${cleanId}" wajib berakhiran ":free" atau "openrouter/free".` };
  }
  if (!ALLOWED_OPENROUTER_FREE_MODELS.has(cleanId)) {
    return { ok: false, code: 'AI_UNKNOWN_MODEL_BLOCKED', reason: `Model OpenRouter "${cleanId}" tidak terdaftar dalam registry model gratis resmi RUNUT.` };
  }

  // If catalog is populated, enforce zero prompt & completion pricing and availability
  if (catalogCache.models.size > 0) {
    const entry = catalogCache.models.get(cleanId);
    if (!entry || !entry.available) {
      return { ok: false, code: 'AI_MODEL_UNAVAILABLE', reason: `Model OpenRouter "${cleanId}" tidak tersedia di katalog aktif.` };
    }
    if (!Number.isFinite(entry.promptPrice) || entry.promptPrice !== 0 || !Number.isFinite(entry.completionPrice) || entry.completionPrice !== 0) {
      return {
        ok: false,
        code: 'AI_PRICE_CHANGED_BLOCKED',
        reason: `Model OpenRouter "${cleanId}" kini memiliki harga non-nol (prompt=${entry.promptPrice}, completion=${entry.completionPrice}) dan diblokir oleh kebijakan zero-cost.`,
      };
    }
    return { ok: true, entry };
  }

  if (requireCatalogMatch) {
    return { ok: false, code: 'AI_CATALOG_UNVERIFIED', reason: 'Katalog model OpenRouter belum diverifikasi.' };
  }
  return { ok: true, entry: null };
}

export function getRegistryEntry(provider, model) {
  const p = String(provider || '').toLowerCase();
  const m = String(model || '').trim();
  return FREE_MODEL_REGISTRY.find((e) => e.provider === p && e.model === m) || null;
}

export function isModelEligibleForPrivacy(provider, model, { confidential = false, userConsentForFreeTier = false } = {}) {
  if (!confidential) return { eligible: true, reason: null };

  const p = String(provider || '').toLowerCase();
  const m = String(model || '').trim();

  // Dynamic model routing (openrouter/free) must not be used for confidential/personal documents.
  if (m === DEFAULT_OPENROUTER_DYNAMIC_MODEL) {
    return {
      eligible: false,
      reason: 'Dynamic router openrouter/free tidak diizinkan untuk dokumen rahasia atau pribadi karena pemilihan upstream bersifat dinamis.',
    };
  }

  // NVIDIA Nemotron free endpoint has explicit data-use warnings — never allow for confidential/personal docs.
  if (m === OPTIONAL_OPENROUTER_NEMOTRON_MODEL) {
    return {
      eligible: false,
      reason: 'Endpoint gratis NVIDIA Nemotron memiliki peringatan penggunaan data dan dilarang untuk dokumen rahasia atau pribadi.',
    };
  }

  // Gemini Free Tier may use submitted data to improve Google products unless explicit consent is granted.
  if (p === 'gemini' && !userConsentForFreeTier) {
    return {
      eligible: false,
      reason: 'Google Gemini Free Tier memerlukan persetujuan eksplisit pengguna untuk dokumen rahasia atau pribadi.',
    };
  }

  return { eligible: true, reason: null };
}

export function getFreeModelRegistrySnapshot(env = process.env) {
  const nemotronEnabled = String(env.ENABLE_NEMOTRON_FREE || 'false').trim().toLowerCase() === 'true';
  const groqEnabled = String(env.ENABLE_GROQ_FREE || 'false').trim().toLowerCase() === 'true'
    && String(env.GROQ_FREE_VERIFIED || 'false').trim().toLowerCase() === 'true'
    && Boolean(String(env.GROQ_API_KEY || '').trim())
    && Boolean(String(env.GROQ_MODEL || '').trim())
    && !DEPRECATED_MODELS.has(String(env.GROQ_MODEL || '').trim());

  return {
    strict_free_ai_only: String(env.STRICT_FREE_AI_ONLY ?? 'true').trim().toLowerCase() !== 'false',
    deprecated_models_blocked: Array.from(DEPRECATED_MODELS.entries()).map(([model, reason]) => ({ model, reason })),
    openrouter_allowed_models: Array.from(ALLOWED_OPENROUTER_FREE_MODELS),
    catalog_cached_count: catalogCache.models.size,
    nemotron_enabled: nemotronEnabled,
    groq_enabled: groqEnabled,
    models: FREE_MODEL_REGISTRY.map((m) => ({
      ...m,
      enabled: m.model === OPTIONAL_OPENROUTER_NEMOTRON_MODEL ? nemotronEnabled : m.enabledByDefault,
    })),
  };
}
