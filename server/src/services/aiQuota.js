// AI Usage, Rate-Limit & Cooldown Monitoring Service.
// Tracks per-provider and per-model API requests, token usage, rate-limit headers,
// cooldown windows, daily reset timestamps, and OpenRouter account-level quota exhaustion
// without ever inventing quota statistics or storing API secrets.

const state = {
  startedAt: new Date().toISOString(),
  totalRequests: 0,
  successfulRequests: 0,
  failedRequests: 0,
  fallbackActivations: 0,
  byProvider: {
    openrouter: createProviderBucket(),
    gemini: createProviderBucket(),
    groq: createProviderBucket(),
  },
  // Per-provider/model rate-limit & cooldown state (key = `${provider}:${model}`)
  modelState: {},
  // Account-level daily exhaustion timestamp (ms) for shared-quota providers like OpenRouter Free
  accountExhaustedUntil: {},
  dailyUsage: {},
};

function createProviderBucket() {
  return {
    requests: 0,
    successes: 0,
    failures: 0,
    promptTokens: 0,
    completionTokens: 0,
    totalTokens: 0,
    lastStatus: 'unknown',
    lastError: null,
    lastSuccessAt: null,
    lastFailureAt: null,
  };
}

function createModelQuotaEntry(providerId, modelId) {
  return {
    provider_id: providerId,
    model_id: modelId,
    remaining_requests: null,
    remaining_tokens: null,
    rate_limit_type: null,
    reset_timestamp: null,
    retry_after_seconds: null,
    last_successful_request: null,
    last_failure: null,
    last_error: null,
    cooldown_until: null,
    enabled: true,
  };
}

function todayKey(date = new Date()) {
  return date.toISOString().slice(0, 10);
}

function modelKey(provider, model) {
  return `${String(provider || 'unknown').toLowerCase()}:${String(model || 'default').trim()}`;
}

function ensureProvider(name) {
  const key = String(name || 'unknown').toLowerCase();
  if (!state.byProvider[key]) {
    state.byProvider[key] = createProviderBucket();
  }
  return state.byProvider[key];
}

function ensureModelQuota(provider, model) {
  const p = String(provider || 'unknown').toLowerCase();
  const m = String(model || 'default').trim();
  const key = modelKey(p, m);
  if (!state.modelState[key]) {
    state.modelState[key] = createModelQuotaEntry(p, m);
  }
  return state.modelState[key];
}

function ensureDay(day = todayKey()) {
  if (!state.dailyUsage[day]) {
    state.dailyUsage[day] = {
      date: day,
      requests: 0,
      successes: 0,
      failures: 0,
      fallbacks: 0,
      promptTokens: 0,
      completionTokens: 0,
      totalTokens: 0,
    };
  }
  return state.dailyUsage[day];
}

// Compute the next midnight Pacific Time (America/Los_Angeles) in ISO format
// for documented Google Gemini daily quota resets when no explicit header is returned.
export function getNextMidnightPacificIso(now = new Date()) {
  try {
    const parts = new Intl.DateTimeFormat('en-US', {
      timeZone: 'America/Los_Angeles',
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
      hour12: false,
    }).formatToParts(now);
    const get = (t) => Number(parts.find((p) => p.type === t)?.value || 0);
    const ptHour = get('hour') % 24;
    const ptMin = get('minute');
    const ptSec = get('second');
    const secondsIntoDay = ptHour * 3600 + ptMin * 60 + ptSec;
    const remainingSec = Math.max(60, 86400 - secondsIntoDay);
    return new Date(now.getTime() + remainingSec * 1000).toISOString();
  } catch {
    return null;
  }
}

// Parse documented rate-limit headers from OpenRouter, Gemini, Groq, etc.
export function parseRateLimitHeaders(headers, nowMs = Date.now()) {
  const getHeader = (name) => {
    if (!headers) return null;
    if (typeof headers.get === 'function') return headers.get(name);
    const lower = name.toLowerCase();
    for (const [k, v] of Object.entries(headers)) {
      if (k.toLowerCase() === lower) return v;
    }
    return null;
  };

  const toInt = (val) => {
    if (val === null || val === undefined || val === '') return null;
    const n = Number(val);
    return Number.isFinite(n) && n >= 0 ? Math.floor(n) : null;
  };

  const remainingRequests = toInt(
    getHeader('x-ratelimit-remaining-requests') ?? getHeader('x-ratelimit-remaining'),
  );
  const remainingTokens = toInt(getHeader('x-ratelimit-remaining-tokens'));

  let retryAfterSeconds = null;
  const retryAfterRaw = getHeader('retry-after');
  if (retryAfterRaw !== null && retryAfterRaw !== '') {
    const sec = Number(retryAfterRaw);
    if (Number.isFinite(sec) && sec >= 0) {
      retryAfterSeconds = Math.ceil(sec);
    } else {
      const parsedDate = Date.parse(retryAfterRaw);
      if (Number.isFinite(parsedDate) && parsedDate > nowMs) {
        retryAfterSeconds = Math.ceil((parsedDate - nowMs) / 1000);
      }
    }
  }

  let resetTimestamp = null;
  const resetRaw = getHeader('x-ratelimit-reset-requests') || getHeader('x-ratelimit-reset');
  if (resetRaw !== null && resetRaw !== '') {
    const trimmed = String(resetRaw).trim();
    // Duration format like "12s", "2m30s", "1h"
    const durMatch = trimmed.match(/^(?:(\d+)h)?(?:(\d+)m)?(?:(\d+(?:\.\d+)?)s)?$/i);
    if (durMatch && (durMatch[1] || durMatch[2] || durMatch[3])) {
      const ms = ((Number(durMatch[1] || 0) * 3600) + (Number(durMatch[2] || 0) * 60) + Number(durMatch[3] || 0)) * 1000;
      if (ms > 0) resetTimestamp = new Date(nowMs + ms).toISOString();
    } else if (/^\d{10,13}$/.test(trimmed)) {
      const num = Number(trimmed);
      const ms = trimmed.length === 10 ? num * 1000 : num;
      if (ms > nowMs) resetTimestamp = new Date(ms).toISOString();
    } else {
      const parsed = Date.parse(trimmed);
      if (Number.isFinite(parsed) && parsed > nowMs) {
        resetTimestamp = new Date(parsed).toISOString();
      }
    }
  }

  if (!resetTimestamp && retryAfterSeconds !== null && retryAfterSeconds > 0) {
    resetTimestamp = new Date(nowMs + retryAfterSeconds * 1000).toISOString();
  }

  return {
    remainingRequests,
    remainingTokens,
    retryAfterSeconds,
    resetTimestamp,
  };
}

export function recordRateLimitState({
  provider,
  model,
  headers = null,
  rateLimitType = null,
  accountLevelExhausted = false,
  cooldownMs = null,
  nowMs = Date.now(),
} = {}) {
  const entry = ensureModelQuota(provider, model);
  const parsed = parseRateLimitHeaders(headers, nowMs);

  if (parsed.remainingRequests !== null) entry.remaining_requests = parsed.remainingRequests;
  if (parsed.remainingTokens !== null) entry.remaining_tokens = parsed.remainingTokens;
  if (rateLimitType) entry.rate_limit_type = rateLimitType;
  if (parsed.retryAfterSeconds !== null) entry.retry_after_seconds = parsed.retryAfterSeconds;

  let resetIso = parsed.resetTimestamp;
  if (!resetIso && provider === 'gemini' && rateLimitType === 'daily_quota') {
    resetIso = getNextMidnightPacificIso(new Date(nowMs));
  }
  if (resetIso) {
    entry.reset_timestamp = resetIso;
    entry.cooldown_until = resetIso;
  } else if (typeof cooldownMs === 'number' && cooldownMs > 0) {
    entry.cooldown_until = new Date(nowMs + cooldownMs).toISOString();
  }

  if (accountLevelExhausted) {
    const p = String(provider || '').toLowerCase();
    const untilMs = entry.cooldown_until
      ? Date.parse(entry.cooldown_until)
      : nowMs + (cooldownMs || 5 * 60 * 1000);
    state.accountExhaustedUntil[p] = Number.isFinite(untilMs) ? untilMs : (nowMs + 5 * 60 * 1000);
  }

  return entry;
}

export function isProviderInCooldown(provider, model, nowMs = Date.now()) {
  const p = String(provider || '').toLowerCase();
  const acctUntil = state.accountExhaustedUntil[p];
  if (acctUntil && nowMs < acctUntil) {
    return { inCooldown: true, scope: 'account', until: new Date(acctUntil).toISOString() };
  }
  if (acctUntil && nowMs >= acctUntil) {
    delete state.accountExhaustedUntil[p];
  }

  const entry = state.modelState[modelKey(p, model)];
  if (!entry) return { inCooldown: false, scope: null, until: null };
  if (entry.cooldown_until) {
    const untilMs = Date.parse(entry.cooldown_until);
    if (Number.isFinite(untilMs) && nowMs < untilMs) {
      return { inCooldown: true, scope: 'model', until: entry.cooldown_until };
    }
    // Cooldown / quota window has reset: automatically restore availability
    entry.cooldown_until = null;
    entry.rate_limit_type = null;
    entry.retry_after_seconds = null;
  }
  return { inCooldown: false, scope: null, until: null };
}

export function isOpenRouterAccountExhausted(nowMs = Date.now()) {
  const until = state.accountExhaustedUntil.openrouter;
  if (!until) return false;
  if (nowMs >= until) {
    delete state.accountExhaustedUntil.openrouter;
    return false;
  }
  return true;
}

export function getEarliestCooldownResetIso(nowMs = Date.now()) {
  const candidates = [];
  for (const untilMs of Object.values(state.accountExhaustedUntil)) {
    if (Number.isFinite(untilMs) && untilMs > nowMs) candidates.push(untilMs);
  }
  for (const entry of Object.values(state.modelState)) {
    const ms = entry.cooldown_until ? Date.parse(entry.cooldown_until) : NaN;
    if (Number.isFinite(ms) && ms > nowMs) candidates.push(ms);
  }
  if (candidates.length === 0) return null;
  return new Date(Math.min(...candidates)).toISOString();
}

export function recordAiRequest({ provider, model = 'default', success, fallbackUsed = false, usage = null, error = null, headers = null }) {
  const nowIso = new Date().toISOString();
  const day = ensureDay();
  const prov = ensureProvider(provider);
  const entry = ensureModelQuota(provider, model);

  state.totalRequests += 1;
  prov.requests += 1;
  day.requests += 1;

  if (fallbackUsed) {
    state.fallbackActivations += 1;
    day.fallbacks += 1;
  }

  if (headers) {
    const parsed = parseRateLimitHeaders(headers);
    if (parsed.remainingRequests !== null) entry.remaining_requests = parsed.remainingRequests;
    if (parsed.remainingTokens !== null) entry.remaining_tokens = parsed.remainingTokens;
    if (parsed.resetTimestamp) entry.reset_timestamp = parsed.resetTimestamp;
  }

  if (success) {
    state.successfulRequests += 1;
    prov.successes += 1;
    prov.lastStatus = 'ok';
    prov.lastError = null;
    prov.lastSuccessAt = nowIso;
    entry.last_successful_request = nowIso;
    entry.last_error = null;
    entry.cooldown_until = null;
    day.successes += 1;
  } else {
    state.failedRequests += 1;
    prov.failures += 1;
    prov.lastStatus = 'error';
    prov.lastError = error ? String(error).slice(0, 240) : 'Request failed';
    prov.lastFailureAt = nowIso;
    entry.last_failure = nowIso;
    entry.last_error = prov.lastError;
    day.failures += 1;
  }

  if (usage && typeof usage === 'object') {
    const prompt = Math.max(0, Number(usage.prompt_tokens) || 0);
    const completion = Math.max(0, Number(usage.completion_tokens) || 0);
    const total = Math.max(0, Number(usage.total_tokens) || (prompt + completion));
    prov.promptTokens += prompt;
    prov.completionTokens += completion;
    prov.totalTokens += total;
    day.promptTokens += prompt;
    day.completionTokens += completion;
    day.totalTokens += total;
  }
}

export function getAiUsageSnapshot() {
  const today = todayKey();
  return {
    started_at: state.startedAt,
    totals: {
      requests: state.totalRequests,
      successes: state.successfulRequests,
      failures: state.failedRequests,
      fallback_activations: state.fallbackActivations,
    },
    today: state.dailyUsage[today] || {
      date: today,
      requests: 0,
      successes: 0,
      failures: 0,
      fallbacks: 0,
      promptTokens: 0,
      completionTokens: 0,
      totalTokens: 0,
    },
    by_provider: JSON.parse(JSON.stringify(state.byProvider)),
    by_model_quota: JSON.parse(JSON.stringify(Object.values(state.modelState))),
    daily_history: Object.values(state.dailyUsage).slice(-30),
  };
}

export function resetAiUsageForTest() {
  state.totalRequests = 0;
  state.successfulRequests = 0;
  state.failedRequests = 0;
  state.fallbackActivations = 0;
  for (const key of Object.keys(state.byProvider)) {
    state.byProvider[key] = createProviderBucket();
  }
  state.modelState = {};
  state.accountExhaustedUntil = {};
  state.dailyUsage = {};
}

// Queries OpenRouter official key endpoint (/api/v1/key) to retrieve real account-level limits.
// Never invents daily quota statistics or hardcodes a daily free request limit.
export async function fetchOpenRouterAccountLimits({
  apiKey = process.env.OPENROUTER_API_KEY || '',
  baseUrl = process.env.OPENROUTER_BASE_URL || 'https://openrouter.ai/api/v1',
  fetchImpl = fetch,
  timeoutMs = 5000,
} = {}) {
  const key = String(apiKey || '').trim();
  if (!key) {
    return {
      available: false,
      scope: 'account',
      reason: 'OPENROUTER_API_KEY is not configured.',
    };
  }

  const endpoint = `${String(baseUrl).replace(/\/$/, '')}/key`;
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);

  try {
    const res = await fetchImpl(endpoint, {
      method: 'GET',
      headers: { Authorization: `Bearer ${key}` },
      signal: ctrl.signal,
    });
    if (!res.ok) {
      return {
        available: false,
        scope: 'account',
        status: res.status,
        reason: `OpenRouter key endpoint returned HTTP ${res.status}.`,
      };
    }
    const payload = await res.json().catch(() => null);
    const data = payload?.data;
    if (!data || typeof data !== 'object') {
      return {
        available: false,
        scope: 'account',
        reason: 'OpenRouter key response did not include account limit data.',
      };
    }
    return {
      available: true,
      scope: 'account',
      note: 'Account-level limits from OpenRouter /api/v1/key. Model-specific rate limits may still apply independently.',
      label: data.label ?? null,
      limit: data.limit ?? null,
      limit_remaining: data.limit_remaining ?? null,
      limit_reset: data.limit_reset ?? null,
      usage: data.usage ?? null,
      usage_daily: data.usage_daily ?? null,
      usage_weekly: data.usage_weekly ?? null,
      usage_monthly: data.usage_monthly ?? null,
      is_free_tier: typeof data.is_free_tier === 'boolean' ? data.is_free_tier : null,
      rate_limit: data.rate_limit ?? null,
    };
  } catch (err) {
    return {
      available: false,
      scope: 'account',
      reason: err?.name === 'AbortError' ? 'OpenRouter key endpoint timed out.' : (err?.message || 'Unable to reach OpenRouter key endpoint.'),
    };
  } finally {
    clearTimeout(timer);
  }
}
