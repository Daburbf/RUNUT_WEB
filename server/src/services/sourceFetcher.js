// Secure Document-Wide URL Extraction and Public Source Content Fetcher.
// Prevents SSRF (blocks localhost, private IPv4/IPv6 ranges, metadata IPs,
// unsafe redirects, non-HTTP(S) protocols), enforces timeout, size limit,
// and content-type validation, and extracts main text from public HTML, TXT, and PDF URLs.
import { isIP } from 'node:net';
import { lookup as dnsLookup } from 'node:dns/promises';
import { inspectPdf } from './pdfEditor.js';

const URL_RE = /https?:\/\/[^\s<>()[\]"'{}|\\^`]+/gi;
const DOI_RE = /\b(10\.\d{4,9}\/[-._;()/:A-Z0-9]+)\b/gi;

const MAX_REDIRECTS = 3;
const DEFAULT_TIMEOUT_MS = 6000;
const DEFAULT_MAX_BYTES = 2 * 1024 * 1024; // 2 MB
const ALLOWED_PORTS = new Set(['', '80', '443']);
const ALLOWED_CONTENT_TYPES = ['text/html', 'application/xhtml+xml', 'text/plain', 'application/pdf'];

function isPrivateIpv4(ip) {
  const parts = ip.split('.').map(Number);
  if (parts.length !== 4 || parts.some((n) => !Number.isInteger(n) || n < 0 || n > 255)) return true;
  const [a, b, c] = parts;
  if (a === 0) return true;                          // 0.0.0.0/8
  if (a === 10) return true;                         // 10.0.0.0/8
  if (a === 100 && b >= 64 && b <= 127) return true; // CGNAT 100.64.0.0/10
  if (a === 127) return true;                        // 127.0.0.0/8 loopback
  if (a === 169 && b === 254) return true;           // 169.254.0.0/16 link-local & cloud metadata
  if (a === 172 && b >= 16 && b <= 31) return true;  // 172.16.0.0/12
  if (a === 192 && b === 0 && c === 0) return true;  // 192.0.0.0/24 IETF protocol assignments
  if (a === 192 && b === 168) return true;           // 192.168.0.0/16
  if (a === 198 && (b === 18 || b === 19)) return true; // 198.18.0.0/15 benchmark
  if (a >= 224) return true;                         // 224.0.0.0/4 multicast & 240.0.0.0/4 reserved
  return false;
}

export function isPrivateOrBlockedHost(hostname) {
  const host = String(hostname || '').trim().toLowerCase().replace(/^\[|\]$/g, '');
  if (!host) return true;
  if (
    host === 'localhost' ||
    host === '0.0.0.0' ||
    host === '::1' ||
    host === '::' ||
    host.endsWith('.local') ||
    host.endsWith('.localhost') ||
    host.endsWith('.internal') ||
    host.endsWith('.arpa') ||
    host === 'metadata.google.internal' ||
    host === 'metadata'
  ) {
    return true;
  }

  const ipVer = isIP(host);
  if (ipVer === 4) {
    return isPrivateIpv4(host);
  }
  if (ipVer === 6) {
    if (host === '::1' || host === '::') return true;
    // IPv4-mapped IPv6 dotted form: ::ffff:a.b.c.d
    const v4MappedDotted = host.match(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/i);
    if (v4MappedDotted) return isPrivateIpv4(v4MappedDotted[1]);
    // IPv4-mapped IPv6 hex form: ::ffff:xxxx:yyyy
    const v4MappedHex = host.match(/^::ffff:([0-9a-f]{1,4}):([0-9a-f]{1,4})$/i);
    if (v4MappedHex) {
      const hi = parseInt(v4MappedHex[1], 16);
      const lo = parseInt(v4MappedHex[2], 16);
      return isPrivateIpv4(`${(hi >> 8) & 255}.${hi & 255}.${(lo >> 8) & 255}.${lo & 255}`);
    }
    const firstHextet = host.split(':')[0] || '';
    if (
      host.startsWith('fe80:') ||
      host.startsWith('fc') ||
      host.startsWith('fd') ||
      host.startsWith('ff') || // multicast
      firstHextet === 'fe80' ||
      firstHextet === 'fec0'
    ) {
      return true;
    }
  }
  return false;
}

export function validatePublicUrl(rawUrl) {
  let parsed;
  try {
    parsed = new URL(String(rawUrl || '').trim());
  } catch {
    return { ok: false, code: 'INVALID_URL', reason: 'Format URL tidak valid.' };
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    return { ok: false, code: 'UNSUPPORTED_PROTOCOL', reason: `Protokol "${parsed.protocol}" tidak diizinkan; hanya http dan https.` };
  }
  if (parsed.username || parsed.password) {
    return { ok: false, code: 'CREDENTIALS_IN_URL', reason: 'URL berkredensial tidak diizinkan.' };
  }
  if (isPrivateOrBlockedHost(parsed.hostname)) {
    return { ok: false, code: 'SSRF_BLOCKED', reason: `Host "${parsed.hostname}" diblokir oleh proteksi SSRF (localhost/jaringan privat).` };
  }
  if (!ALLOWED_PORTS.has(parsed.port)) {
    return { ok: false, code: 'UNSAFE_PORT', reason: `Port "${parsed.port}" tidak diizinkan oleh proteksi SSRF; hanya port 80 dan 443.` };
  }
  return { ok: true, url: parsed.toString(), parsed };
}

async function verifyResolvedHost(hostname, lookupImpl) {
  const cleanHost = String(hostname || '').trim().replace(/^\[|\]$/g, '');
  if (isIP(cleanHost)) {
    if (isPrivateOrBlockedHost(cleanHost)) {
      return { ok: false, code: 'SSRF_BLOCKED', reason: `Alamat IP "${cleanHost}" diblokir oleh proteksi SSRF.` };
    }
    return { ok: true };
  }
  try {
    const records = await lookupImpl(cleanHost, { all: true, verbatim: true });
    if (!Array.isArray(records) || records.length === 0) {
      return { ok: false, code: 'DNS_RESOLUTION_FAILED', reason: `Host "${cleanHost}" tidak dapat diresolusi.` };
    }
    for (const rec of records) {
      if (!rec?.address || isPrivateOrBlockedHost(rec.address)) {
        return {
          ok: false,
          code: 'SSRF_DNS_BLOCKED',
          reason: `Host "${cleanHost}" mengarah ke alamat IP privat/internal yang diblokir oleh proteksi SSRF.`,
        };
      }
    }
    return { ok: true };
  } catch {
    return { ok: false, code: 'DNS_RESOLUTION_FAILED', reason: `Gagal meresolusi DNS untuk host "${cleanHost}".` };
  }
}

async function readBodyWithLimit(res, maxBytes) {
  if (res.body && typeof res.body.getReader === 'function') {
    const reader = res.body.getReader();
    const chunks = [];
    let total = 0;
    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        const chunk = Buffer.from(value);
        total += chunk.length;
        if (total > maxBytes) {
          await reader.cancel().catch(() => {});
          return { tooLarge: true, size: total };
        }
        chunks.push(chunk);
      }
      return { tooLarge: false, buffer: Buffer.concat(chunks, total) };
    } catch {
      await reader.cancel().catch(() => {});
      return { readError: true };
    }
  }
  try {
    const arrBuf = await res.arrayBuffer();
    const buffer = Buffer.from(arrBuf);
    if (buffer.length > maxBytes) return { tooLarge: true, size: buffer.length };
    return { tooLarge: false, buffer };
  } catch {
    return { readError: true };
  }
}

// Extract and normalize all URLs and DOI links from the entire document (body, tables, footnotes, bibliography).
export function extractDocumentUrls(text) {
  const source = String(text || '');
  const seen = new Set();
  const urls = [];

  for (const m of source.matchAll(URL_RE)) {
    const cleaned = m[0].replace(/[.,;:!?)'"\]}]+$/, '');
    const check = validatePublicUrl(cleaned);
    if (!check.ok) continue;
    if (!seen.has(check.url)) {
      seen.add(check.url);
      urls.push({ url: check.url, kind: /doi\.org\//i.test(check.url) ? 'doi_url' : 'document_url', position: m.index });
    }
  }

  for (const m of source.matchAll(DOI_RE)) {
    const doi = m[1].replace(/[.,;)]+$/, '');
    const doiUrl = `https://doi.org/${doi}`;
    if (!seen.has(doiUrl)) {
      seen.add(doiUrl);
      urls.push({ url: doiUrl, doi, kind: 'doi_url', position: m.index });
    }
  }

  return urls;
}

function extractMainHtmlContent(html) {
  const raw = String(html || '');
  const titleMatch = raw.match(/<title[^>]*>([\s\S]*?)<\/title>/i);
  const title = titleMatch ? titleMatch[1].replace(/\s+/g, ' ').trim() : null;
  const authorMatch = raw.match(/<meta[^>]+name=["'](?:author|citation_author)["'][^>]+content=["']([^"']+)["']/i);
  const author = authorMatch ? authorMatch[1].trim() : null;
  const dateMatch = raw.match(/<meta[^>]+name=["'](?:citation_publication_date|date|DC\.date)["'][^>]+content=["']([^"']+)["']/i);
  const yearMatch = dateMatch ? dateMatch[1].match(/\b(19|20)\d{2}\b/) : null;

  // Prefer <article> or <main> content if present; remove scripts, styles, nav, header, footer, aside
  const mainMatch = raw.match(/<article\b[^>]*>([\s\S]*?)<\/article>/i) ||
    raw.match(/<main\b[^>]*>([\s\S]*?)<\/main>/i);
  let body = mainMatch ? mainMatch[1] : raw;

  body = body
    .replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style\b[^>]*>[\s\S]*?<\/style>/gi, ' ')
    .replace(/<noscript\b[^>]*>[\s\S]*?<\/noscript>/gi, ' ')
    .replace(/<(?:nav|header|footer|aside|form)\b[^>]*>[\s\S]*?<\/(?:nav|header|footer|aside|form)>/gi, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&quot;/gi, '"')
    .replace(/&#39;/gi, "'")
    .replace(/\s+/g, ' ')
    .trim();

  const isPaywalledHint = body.length < 400 && /\b(subscribe|sign in to read|purchase access|institutional login|paywall|buy this article)\b/i.test(raw);

  return {
    title,
    author,
    year: yearMatch ? Number(yearMatch[0]) : null,
    text: body,
    paywall_hint: isPaywalledHint,
  };
}

// Safely fetch a public URL with SSRF protection (including DNS resolution checks) on every redirect,
// timeout, streaming size limit, and content-type checks.
export async function fetchAndExtractSource(rawUrl, {
  fetchImpl = fetch,
  lookupImpl = null,
  timeoutMs = DEFAULT_TIMEOUT_MS,
  maxBytes = DEFAULT_MAX_BYTES,
} = {}) {
  const effectiveLookup = lookupImpl || (fetchImpl === fetch ? dnsLookup : null);
  let currentUrl = rawUrl;

  for (let hop = 0; hop <= MAX_REDIRECTS; hop++) {
    const check = validatePublicUrl(currentUrl);
    if (!check.ok) {
      return {
        ok: false,
        url: rawUrl,
        code: check.code,
        accessibility_status: 'Source Unavailable',
        reason: check.reason,
      };
    }

    if (effectiveLookup) {
      const dnsCheck = await verifyResolvedHost(check.parsed.hostname, effectiveLookup);
      if (!dnsCheck.ok) {
        return {
          ok: false,
          url: rawUrl,
          code: dnsCheck.code,
          accessibility_status: 'Source Unavailable',
          reason: dnsCheck.reason,
        };
      }
    }

    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), timeoutMs);
    let res;
    try {
      res = await fetchImpl(check.url, {
        method: 'GET',
        redirect: 'manual',
        headers: {
          'User-Agent': 'Runut/1.0 (Academic Source Verification; mailto:support@runut.local)',
          Accept: 'text/html,application/pdf,text/plain;q=0.9,*/*;q=0.1',
        },
        signal: ctrl.signal,
      });
    } catch (err) {
      clearTimeout(timer);
      const isTimeout = err?.name === 'AbortError';
      return {
        ok: false,
        url: check.url,
        code: isTimeout ? 'FETCH_TIMEOUT' : 'NETWORK_ERROR',
        accessibility_status: 'Source Unavailable',
        reason: isTimeout ? `Permintaan melewati batas waktu ${timeoutMs} ms.` : (err?.message || 'Gagal menghubungi URL sumber.'),
      };
    }
    clearTimeout(timer);

    // Handle redirects safely by validating EVERY hop against SSRF rules
    if (res.status >= 300 && res.status < 400) {
      const location = res.headers?.get?.('location');
      if (!location || hop === MAX_REDIRECTS) {
        return {
          ok: false,
          url: check.url,
          code: 'TOO_MANY_REDIRECTS',
          accessibility_status: 'Source Unavailable',
          reason: 'Terlalu banyak pengalihan URL atau header Location tidak valid.',
        };
      }
      try {
        currentUrl = new URL(location, check.url).toString();
      } catch {
        return {
          ok: false,
          url: check.url,
          code: 'INVALID_REDIRECT',
          accessibility_status: 'Source Unavailable',
          reason: 'URL pengalihan tidak valid.',
        };
      }
      continue;
    }

    if (res.status === 401 || res.status === 402 || res.status === 403) {
      return {
        ok: false,
        url: check.url,
        code: 'ACCESS_RESTRICTED',
        accessibility_status: 'Paywalled',
        reason: `Sumber membatasi akses (HTTP ${res.status}).`,
      };
    }
    if (!res.ok) {
      return {
        ok: false,
        url: check.url,
        code: `HTTP_${res.status}`,
        accessibility_status: 'Source Unavailable',
        reason: `Sumber menjawab HTTP ${res.status}.`,
      };
    }

    const contentType = String(res.headers?.get?.('content-type') || '').toLowerCase().split(';')[0].trim();
    if (contentType && !ALLOWED_CONTENT_TYPES.includes(contentType)) {
      return {
        ok: false,
        url: check.url,
        code: 'INVALID_CONTENT_TYPE',
        accessibility_status: 'Source Unavailable',
        reason: `Tipe konten "${contentType}" tidak didukung untuk ekstraksi teks.`,
      };
    }

    const contentLength = Number(res.headers?.get?.('content-length') || 0);
    if (contentLength > maxBytes) {
      return {
        ok: false,
        url: check.url,
        code: 'RESPONSE_TOO_LARGE',
        accessibility_status: 'Source Unavailable',
        reason: `Ukuran respons (${contentLength} byte) melebihi batas maksimum ${maxBytes} byte.`,
      };
    }

    const bodyRead = await readBodyWithLimit(res, maxBytes);
    if (bodyRead.readError) {
      return {
        ok: false,
        url: check.url,
        code: 'READ_ERROR',
        accessibility_status: 'Source Unavailable',
        reason: 'Gagal membaca isi respons sumber.',
      };
    }
    if (bodyRead.tooLarge) {
      return {
        ok: false,
        url: check.url,
        code: 'RESPONSE_TOO_LARGE',
        accessibility_status: 'Source Unavailable',
        reason: `Ukuran konten (${bodyRead.size} byte) melebihi batas maksimum ${maxBytes} byte.`,
      };
    }
    const buf = bodyRead.buffer;

    if (contentType === 'application/pdf' || check.url.toLowerCase().endsWith('.pdf')) {
      if (!buf.slice(0, 5).toString('latin1').startsWith('%PDF-')) {
        return {
          ok: false,
          url: check.url,
          code: 'MALFORMED_PDF',
          accessibility_status: 'Source Unavailable',
          reason: 'Berkas PDF jarak jauh rusak atau tidak memiliki header %PDF- yang valid.',
        };
      }
      try {
        const pdfInfo = await inspectPdf(buf);
        const text = String(pdfInfo.text || '').trim();
        return {
          ok: text.length >= 30,
          url: check.url,
          title: check.url.split('/').pop() || 'Remote PDF Document',
          author: null,
          year: null,
          content_type: 'application/pdf',
          text,
          accessibility_status: text.length >= 30 ? 'Full Text Accessible' : 'Source Unavailable',
          full_text_verified: text.length >= 30,
        };
      } catch {
        return {
          ok: false,
          url: check.url,
          code: 'MALFORMED_PDF',
          accessibility_status: 'Source Unavailable',
          reason: 'PDF jarak jauh tidak dapat diurai.',
        };
      }
    }

    if (contentType === 'text/plain') {
      const text = buf.toString('utf8').trim();
      return {
        ok: text.length >= 30,
        url: check.url,
        title: check.url.split('/').pop() || 'Remote Text Source',
        author: null,
        year: null,
        content_type: 'text/plain',
        text,
        accessibility_status: text.length >= 30 ? 'Full Text Accessible' : 'Source Unavailable',
        full_text_verified: text.length >= 30,
      };
    }

    // HTML / XHTML
    const parsed = extractMainHtmlContent(buf.toString('utf8'));
    if (parsed.paywall_hint) {
      return {
        ok: false,
        url: check.url,
        title: parsed.title,
        author: parsed.author,
        year: parsed.year,
        text: parsed.text,
        content_type: 'text/html',
        accessibility_status: 'Paywalled',
        full_text_verified: false,
        reason: 'Halaman terdeteksi memerlukan langganan atau login penerbit.',
      };
    }

    return {
      ok: parsed.text.length >= 40,
      url: check.url,
      title: parsed.title || check.url,
      author: parsed.author,
      year: parsed.year,
      text: parsed.text,
      content_type: 'text/html',
      accessibility_status: parsed.text.length >= 120 ? 'Full Text Accessible' : 'Metadata Only',
      full_text_verified: parsed.text.length >= 120,
    };
  }

  return {
    ok: false,
    url: rawUrl,
    code: 'TOO_MANY_REDIRECTS',
    accessibility_status: 'Source Unavailable',
    reason: 'Pengalihan URL melebihi batas.',
  };
}
