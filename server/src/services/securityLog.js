// Centralized structured security event logger & anomaly tracker.
// NEVER logs passwords, session tokens, API keys, payment secrets, or private document bodies.
const REDACT_KEYS = new Set([
  'password', 'password_hash', 'token', 'accessToken', 'refreshToken', 'authorization',
  'apiKey', 'api_key', 'secret', 'serverKey', 'signature_key', 'otp', 'original_text', 'revised_text',
]);

const failedLoginBuckets = new Map();
const FAILED_LOGIN_WINDOW_MS = 15 * 60 * 1000;
const FAILED_LOGIN_ALERT_THRESHOLD = 5;

function sanitizeMeta(meta = {}) {
  const clean = {};
  for (const [k, v] of Object.entries(meta || {})) {
    if (REDACT_KEYS.has(k) || /secret|password|token|key|cookie/i.test(k)) {
      clean[k] = '[REDACTED]';
      continue;
    }
    if (typeof v === 'string') {
      clean[k] = v.slice(0, 240);
    } else if (typeof v === 'number' || typeof v === 'boolean' || v === null) {
      clean[k] = v;
    }
  }
  return clean;
}

export function logSecurityEvent(event, meta = {}, { severity = 'info' } = {}) {
  const record = {
    ts: new Date().toISOString(),
    category: 'security',
    severity,
    event,
    ...sanitizeMeta(meta),
  };
  if (process.env.NODE_ENV !== 'test' || severity === 'critical') {
    const line = JSON.stringify(record);
    if (severity === 'high' || severity === 'critical') {
      console.error(line);
    } else {
      console.warn(line);
    }
  }
  return record;
}

export function recordFailedLogin({ ip = 'unknown', emailHash = 'unknown' } = {}) {
  const key = `${ip}:${emailHash}`;
  const now = Date.now();
  const prev = failedLoginBuckets.get(key) || [];
  const recent = prev.filter((t) => now - t < FAILED_LOGIN_WINDOW_MS);
  recent.push(now);
  failedLoginBuckets.set(key, recent);

  if (failedLoginBuckets.size > 5000) {
    for (const [k, times] of failedLoginBuckets) {
      if (!times.some((t) => now - t < FAILED_LOGIN_WINDOW_MS)) {
        failedLoginBuckets.delete(k);
      }
    }
  }

  const suspicious = recent.length >= FAILED_LOGIN_ALERT_THRESHOLD;
  logSecurityEvent(
    suspicious ? 'auth_suspicious_failed_logins' : 'auth_login_failed',
    { ip, email_hash: emailHash, attempts_in_window: recent.length },
    { severity: suspicious ? 'high' : 'medium' },
  );
  return { attempts: recent.length, suspicious };
}

export function resetSecurityMonitor() {
  failedLoginBuckets.clear();
}
