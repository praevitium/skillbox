/**
 * Server-side handler for the `web_fetch` tool.
 *
 * Fetches a single URL and returns its readable text so the copilot can
 * read a page in depth — the companion to `web_search`, which only
 * returns titles + short SERP excerpts. The intended loop (orchestrated
 * by the model per the web-search SKILL.md) is:
 *
 *   web_search(query) → pick a promising result URL → web_fetch(url)
 *     → read the body → answer, or refine the query and try again.
 *
 * Auto-discovered by ratchet's SkillLoader (convention:
 *   skillbox/<box>/tools/<tool-id>.js, default-export handler).
 *
 * Contract:
 *   args.url      : string  (required) — absolute http(s) URL to fetch
 *   args.maxChars : integer (optional) — cap on returned text length,
 *                                        clamped to [500, 20000]; default 8000
 *
 * Returns:
 *   {
 *     url       : string,            // the requested URL
 *     finalUrl? : string,            // post-redirect URL when it differs
 *     title?    : string,            // <title> of the page, when present
 *     text      : string,            // extracted readable body (capped)
 *     truncated : boolean,           // true when the body was cut at maxChars
 *     contentType?: string,          // response Content-Type, when present
 *     sources   : Array<{ id, title, url, excerpt }>,  // one entry, for [n] citation
 *     fromWeb   : boolean,           // true when a body was retrieved
 *     note?     : string             // failure / empty explanation
 *   }
 *
 * The single-entry `sources` array mirrors `web_search` / `lookup_regulations`
 * so the LLM proxy maps the fetched page into a [n] citation and the default
 * `renderSourceCards` renderer paints a card for free. `text` carries the full
 * (capped) body for the model to actually read — `sources[0].excerpt` is just a
 * short preview for the card.
 *
 * Safety: only absolute http/https URLs are fetched. A non-http scheme,
 * an unparseable URL, a non-2xx response, an oversized body, or a network
 * error all degrade to an empty `text` + a `note` — the handler never
 * throws, so a dead link can't break the chat turn.
 *
 * Test seam: `__setFetchImpl(fn)` overrides the module's HTTP client so
 * unit tests don't have to touch `globalThis.fetch`. Pass `null` to
 * restore the default. Same seam as `web_search`.
 */

const DEFAULT_MAX_CHARS = 8000;
const MIN_MAX_CHARS = 500;
const MAX_MAX_CHARS = 20000;
const REQUEST_TIMEOUT_MS = 10000;
// Hard ceiling on the raw response we will pull down before extracting text,
// so a multi-megabyte page can't blow up memory. ~2 MB of markup is plenty
// to recover the readable body of any normal article.
const MAX_RESPONSE_BYTES = 2 * 1024 * 1024;

let fetchImpl = null;

export function __setFetchImpl(fn) {
  fetchImpl = fn;
}

function resolveFetch() {
  if (typeof fetchImpl === 'function') return fetchImpl;
  if (typeof globalThis.fetch === 'function') return globalThis.fetch.bind(globalThis);
  return null;
}

export default async function webFetch(args, _context) {
  const rawUrl = typeof args.url === 'string' ? args.url.trim() : '';
  if (!rawUrl) {
    return {
      url: '',
      text: '',
      truncated: false,
      sources: [],
      fromWeb: false,
      note: 'Empty url — provide an absolute http(s) URL to fetch.',
    };
  }

  let parsed;
  try {
    parsed = new URL(rawUrl);
  } catch {
    return {
      url: rawUrl,
      text: '',
      truncated: false,
      sources: [],
      fromWeb: false,
      note: `Not a valid absolute URL: ${rawUrl}`,
    };
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    return {
      url: rawUrl,
      text: '',
      truncated: false,
      sources: [],
      fromWeb: false,
      note: `Unsupported URL scheme "${parsed.protocol}" — only http and https are fetched.`,
    };
  }

  const fetcher = resolveFetch();
  if (!fetcher) {
    return {
      url: rawUrl,
      text: '',
      truncated: false,
      sources: [],
      fromWeb: false,
      note: 'No HTTP client available — web_fetch requires Node 18+ (global fetch) or a configured fetch shim.',
    };
  }

  const maxChars = clampInt(args.maxChars, MIN_MAX_CHARS, MAX_MAX_CHARS, DEFAULT_MAX_CHARS);

  try {
    const res = await withTimeout(
      fetcher(rawUrl, {
        headers: {
          Accept: 'text/html,application/xhtml+xml,text/plain;q=0.9,*/*;q=0.8',
          'User-Agent': 'Mozilla/5.0 (compatible; ratchet/web_fetch; +local)',
        },
        redirect: 'follow',
      }),
      REQUEST_TIMEOUT_MS
    );

    if (!res.ok) {
      return {
        url: rawUrl,
        finalUrl: responseUrl(res, rawUrl),
        text: '',
        truncated: false,
        sources: [],
        fromWeb: false,
        note: `HTTP ${res.status} fetching ${rawUrl}`,
      };
    }

    const contentType =
      (res.headers && typeof res.headers.get === 'function'
        ? res.headers.get('content-type')
        : '') || '';

    const raw = await readBodyText(res);
    const isHtml = /html|xml/i.test(contentType) || looksLikeHtml(raw);
    const title = isHtml ? extractTitle(raw) : '';
    const extracted = isHtml ? htmlToText(raw) : collapseWhitespace(raw);

    const truncated = extracted.length > maxChars;
    const text = truncated ? extracted.slice(0, maxChars) : extracted;
    const finalUrl = responseUrl(res, rawUrl);

    if (!text) {
      return {
        url: rawUrl,
        finalUrl: finalUrl !== rawUrl ? finalUrl : undefined,
        title: title || undefined,
        text: '',
        truncated: false,
        contentType: contentType || undefined,
        sources: [],
        fromWeb: false,
        note: 'Fetched the page but could not extract any readable text. Try a different source.',
      };
    }

    const cardTitle = title || finalUrl || rawUrl;
    return {
      url: rawUrl,
      finalUrl: finalUrl !== rawUrl ? finalUrl : undefined,
      title: title || undefined,
      text,
      truncated,
      contentType: contentType || undefined,
      sources: [
        {
          id: 'fetch-1',
          title: cardTitle,
          url: finalUrl || rawUrl,
          excerpt: text.slice(0, 300),
        },
      ],
      fromWeb: true,
    };
  } catch (err) {
    return {
      url: rawUrl,
      text: '',
      truncated: false,
      sources: [],
      fromWeb: false,
      note: `Fetch failed: ${(err && err.message) || String(err)}`,
    };
  }
}

/** Post-redirect URL from a Response, when the runtime exposes it. */
function responseUrl(res, fallback) {
  return res && typeof res.url === 'string' && res.url ? res.url : fallback;
}

/**
 * Read the response body as text, guarding against an oversized payload.
 * Prefers a streamed read (so we can stop at MAX_RESPONSE_BYTES) and falls
 * back to res.text() for runtimes / stubs without a byte stream.
 */
async function readBodyText(res) {
  const body = res && res.body;
  if (body && typeof body.getReader === 'function') {
    const reader = body.getReader();
    const decoder = new TextDecoder('utf-8', { fatal: false });
    let out = '';
    let total = 0;
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      if (value) {
        total += value.byteLength;
        out += decoder.decode(value, { stream: true });
        if (total >= MAX_RESPONSE_BYTES) {
          try {
            await reader.cancel();
          } catch {
            /* ignore */
          }
          break;
        }
      }
    }
    out += decoder.decode();
    return out;
  }
  const text = typeof res.text === 'function' ? await res.text() : '';
  return typeof text === 'string' && text.length > MAX_RESPONSE_BYTES
    ? text.slice(0, MAX_RESPONSE_BYTES)
    : text;
}

function looksLikeHtml(s) {
  return typeof s === 'string' && /<\s*(html|body|div|p|article|head)\b/i.test(s);
}

/** Pull the <title> text out of an HTML document, when present. */
function extractTitle(html) {
  const m = /<title[^>]*>([\s\S]*?)<\/title>/i.exec(String(html || ''));
  return m ? collapseWhitespace(decodeEntities(stripTags(m[1]))) : '';
}

/**
 * Reduce an HTML document to readable plain text: drop non-content elements
 * (script / style / noscript / svg / head / nav / footer / template), insert
 * line breaks for block-level boundaries so the text doesn't run together,
 * strip the remaining tags, decode entities, and collapse whitespace.
 *
 * No DOM dependency — a light regex pass is enough to recover the body of a
 * normal article and keeps the handler runnable under plain Node.
 */
function htmlToText(html) {
  let s = String(html || '');
  // Remove whole non-content elements (open tag … close tag).
  s = s.replace(
    /<(script|style|noscript|svg|head|nav|footer|template|iframe|form)\b[\s\S]*?<\/\1>/gi,
    ' '
  );
  // Block-level boundaries → newlines so words don't fuse across elements.
  s = s.replace(/<\/(p|div|section|article|li|tr|h[1-6]|br|header|main)\s*>/gi, '\n');
  s = s.replace(/<br\s*\/?>(?=)/gi, '\n');
  s = stripTags(s);
  s = decodeEntities(s);
  // Collapse runs of blank lines / spaces while keeping paragraph breaks.
  s = s
    .replace(/[ \t\f\v]+/g, ' ')
    .replace(/ *\n */g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
  return s;
}

function stripTags(s) {
  return String(s).replace(/<[^>]*>/g, ' ');
}

function collapseWhitespace(s) {
  return String(s).replace(/\s+/g, ' ').trim();
}

/** Decode the common HTML entities found in page text. */
function decodeEntities(s) {
  return String(s)
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#0*39;|&#x0*27;|&apos;/gi, "'")
    .replace(/&nbsp;/g, ' ')
    .replace(/&#(\d+);/g, (_, d) => safeCodePoint(parseInt(d, 10)))
    .replace(/&#x([0-9a-f]+);/gi, (_, h) => safeCodePoint(parseInt(h, 16)));
}

function safeCodePoint(cp) {
  if (!Number.isFinite(cp) || cp < 0 || cp > 0x10ffff) return '';
  try {
    return String.fromCodePoint(cp);
  } catch {
    return '';
  }
}

function clampInt(value, min, max, fallback) {
  const n = Number.isFinite(value) ? Math.trunc(value) : fallback;
  return Math.max(min, Math.min(max, n));
}

function withTimeout(promise, ms) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(
      () => reject(new Error(`Request timed out after ${ms}ms`)),
      ms
    );
    Promise.resolve(promise).then(
      (v) => {
        clearTimeout(timer);
        resolve(v);
      },
      (e) => {
        clearTimeout(timer);
        reject(e);
      }
    );
  });
}
