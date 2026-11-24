// AI Usage & Quota Monitoring service.
// Tracks actual API requests, token usage (when provided by the model API),
// fallback activations, and daily usage without ever inventing quota statistics.

const state = {
  startedAt: new Date().toISOString(),
  totalRequests: 0,
  successfulRequests: 0,
  failedRequests: 0,
  fallbackActivations: 0,
  byProvider: {
    openrouter: {
      requests: 0,
      successes: 0,
      failures: 0,
      promptTokens: 0,
      completionTokens: 0,
      totalTokens: 0,
      lastStatus: 'unknown',
      lastError: null,
      lastSuccessAt: null,
    },
    gemini: {
      requests: 0,
      successes: 0,
      failures: 0,
      promptTokens: 0,
      completionTokens: 0,
      totalTokens: 0,
      lastStatus: 'unknown',
      lastError: null,
      lastSuccessAt: null,
    },
  },
  dailyUsage: {},
};

function todayKey(date = new Date()) {
  return date.toISOString().slice(0, 10);
}

function ensureProvider(name) {
  const key = String(name || 'unknown').toLowerCase();
  if (!state.byProvider[key]) {
    state.byProvider[key] = {
      requests: 0,
      successes: 0,
      failures: 0,
      promptTokens: 0,
      completionTokens: 0,
      totalTokens: 0,
      lastStatus: 'unknown',
      lastError: null,
      lastSuccessAt: null,
    };
  }
  return state.byProvider[key];
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

export function recordAiRequest({ provider, success, fallbackUsed = false, usage = null, error = null }) {
  const day = ensureDay();
  const prov = ensureProvider(provider);

  state.totalRequests += 1;
  prov.requests += 1;
  day.requests += 1;

  if (fallbackUsed) {
    state.fallbackActivations += 1;
    day.fallbacks += 1;
  }

  if (success) {
    state.successfulRequests += 1;
    prov.successes += 1;
    prov.lastStatus = 'ok';
    prov.lastError = null;
    prov.lastSuccessAt = new Date().toISOString();
    day.successes += 1;
  } else {
    state.failedRequests += 1;
    prov.failures += 1;
    prov.lastStatus = 'error';
    prov.lastError = error ? String(error).slice(0, 240) : 'Request failed';
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
    daily_history: Object.values(state.dailyUsage).slice(-30),
  };
}

export function resetAiUsageForTest() {
  state.totalRequests = 0;
  state.successfulRequests = 0;
  state.failedRequests = 0;
  state.fallbackActivations = 0;
  for (const key of Object.keys(state.byProvider)) {
    state.byProvider[key] = {
      requests: 0,
      successes: 0,
      failures: 0,
      promptTokens: 0,
      completionTokens: 0,
      totalTokens: 0,
      lastStatus: 'unknown',
      lastError: null,
      lastSuccessAt: null,
    };
  }
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
