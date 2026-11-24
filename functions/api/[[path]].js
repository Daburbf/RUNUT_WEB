// Cloudflare Pages Function: Same-Origin API Proxy for /api/*
// Proxies https://<pages-domain>/api/* -> fixed env.BACKEND_ORIGIN/api/*
// Guarantees:
// - Fixed server-side BACKEND_ORIGIN only (prevents SSRF / open proxy)
// - Preserves HTTP method, query string, body, Cookie, Authorization, and custom headers
// - Preserves EVERY Set-Cookie header individually (never comma-joined)
// - Strips any upstream Domain=... attribute so __Secure-runut_refresh stays host-only on Pages domain
// - Blocks arbitrary upstream 3xx redirects to untrusted external hosts (redirect: 'manual')
// - Handles Render Free cold starts with graceful 502/504 JSON responses

const HOP_BY_HOP_HEADERS = new Set([
  'connection',
  'keep-alive',
  'proxy-authenticate',
  'proxy-authorization',
  'te',
  'trailers',
  'transfer-encoding',
  'upgrade',
  'host',
  'content-length',
]);

const DEFAULT_UPSTREAM_TIMEOUT_MS = 115_000;

export function parseTrustedBackendOrigin(rawOrigin) {
  const value = String(rawOrigin || '').trim().replace(/\/+$/, '');
  if (!value) return null;
  let parsed;
  try {
    parsed = new URL(value);
  } catch {
    return null;
  }
  const isLocal = parsed.hostname === '127.0.0.1' || parsed.hostname === 'localhost';
  if (parsed.protocol !== 'https:' && !(isLocal && parsed.protocol === 'http:')) {
    return null;
  }
  if (parsed.username || parsed.password || (parsed.pathname && parsed.pathname !== '/')) {
    return null;
  }
  return parsed.origin;
}

// Removes any Domain=... attribute from a Set-Cookie header so the cookie is strictly
// scoped to the Cloudflare Pages frontend hostname (host-only cookie).
export function sanitizeSetCookieForSameOrigin(setCookieValue) {
  return String(setCookieValue || '')
    .split(';')
    .map((part) => part.trim())
    .filter((part) => part.length > 0 && !/^domain\s*=/i.test(part))
    .join('; ');
}

function getAllSetCookies(headers) {
  if (typeof headers.getSetCookie === 'function') {
    return headers.getSetCookie();
  }
  const single = headers.get('set-cookie');
  return single ? [single] : [];
}

function jsonError(status, error, code) {
  return new Response(JSON.stringify({ error, code }), {
    status,
    headers: {
      'Content-Type': 'application/json; charset=utf-8',
      'Cache-Control': 'no-store',
    },
  });
}

export async function onRequest(context) {
  const { request, env } = context;
  const backendOrigin = parseTrustedBackendOrigin(env?.BACKEND_ORIGIN);
  if (!backendOrigin) {
    return jsonError(
      503,
      'Proxy API belum dikonfigurasi dengan BACKEND_ORIGIN HTTPS yang valid.',
      'PROXY_MISCONFIGURED',
    );
  }

  const incomingUrl = new URL(request.url);
  if (!incomingUrl.pathname.startsWith('/api/')) {
    return jsonError(404, 'Endpoint API tidak ditemukan.', 'NOT_FOUND');
  }

  const targetUrl = new URL(`${incomingUrl.pathname}${incomingUrl.search}`, backendOrigin);

  // Build safe upstream request headers
  const upstreamHeaders = new Headers();
  for (const [key, value] of request.headers.entries()) {
    const lower = key.toLowerCase();
    if (HOP_BY_HOP_HEADERS.has(lower) || lower.startsWith('cf-')) continue;
    upstreamHeaders.set(key, value);
  }
  upstreamHeaders.set('X-Forwarded-Host', incomingUrl.host);
  upstreamHeaders.set('X-Forwarded-Proto', incomingUrl.protocol.replace(':', ''));
  const clientIp = request.headers.get('CF-Connecting-IP') || request.headers.get('X-Forwarded-For');
  if (clientIp) {
    upstreamHeaders.set('X-Forwarded-For', clientIp);
  }

  const method = request.method.toUpperCase();
  const hasBody = method !== 'GET' && method !== 'HEAD';
  const timeoutMs = Number(env?.PROXY_TIMEOUT_MS || DEFAULT_UPSTREAM_TIMEOUT_MS);
  const fetchFn = context.fetchImpl || fetch;

  let upstreamRes;
  try {
    const init = {
      method,
      headers: upstreamHeaders,
      redirect: 'manual',
      signal: AbortSignal.timeout(timeoutMs),
    };
    if (hasBody && request.body != null) {
      init.body = request.body;
      init.duplex = 'half';
    }
    upstreamRes = await fetchFn(targetUrl.toString(), init);
  } catch (err) {
    const isTimeout = err?.name === 'TimeoutError' || err?.name === 'AbortError';
    return jsonError(
      isTimeout ? 504 : 502,
      isTimeout
        ? 'Backend sedang memulai ulang (cold start) atau melewati batas waktu. Silakan coba lagi.'
        : 'Backend API tidak dapat dijangkau saat ini. Silakan coba beberapa saat lagi.',
      isTimeout ? 'UPSTREAM_TIMEOUT' : 'UPSTREAM_UNREACHABLE',
    );
  }

  // Prevent arbitrary upstream redirects from exposing cookies or Authorization headers
  if (upstreamRes.status >= 300 && upstreamRes.status < 400) {
    const loc = upstreamRes.headers.get('location') || '';
    try {
      const resolvedLoc = new URL(loc, targetUrl);
      if (resolvedLoc.origin !== backendOrigin && resolvedLoc.origin !== incomingUrl.origin) {
        return jsonError(
          502,
          'Redirect eksternal tidak diizinkan melalui proxy API.',
          'UNTRUSTED_UPSTREAM_REDIRECT',
        );
      }
    } catch {
      return jsonError(502, 'Header redirect dari backend tidak valid.', 'INVALID_UPSTREAM_REDIRECT');
    }
  }

  // Copy response headers while preserving every Set-Cookie individually
  const responseHeaders = new Headers();
  for (const [key, value] of upstreamRes.headers.entries()) {
    const lower = key.toLowerCase();
    if (HOP_BY_HOP_HEADERS.has(lower) || lower === 'set-cookie') continue;
    responseHeaders.set(key, value);
  }

  const setCookies = getAllSetCookies(upstreamRes.headers);
  for (const rawCookie of setCookies) {
    const sanitized = sanitizeSetCookieForSameOrigin(rawCookie);
    if (sanitized) {
      responseHeaders.append('Set-Cookie', sanitized);
    }
  }

  return new Response(upstreamRes.body, {
    status: upstreamRes.status,
    statusText: upstreamRes.statusText,
    headers: responseHeaders,
  });
}
