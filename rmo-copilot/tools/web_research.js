/**
 * Server-side handler for the `web_research` tool.
 *
 * Searches the public web for information the LLM needs to ground an
 * answer. Pairs with `lookup_regulations` — the copilot should reach
 * for the KB first, and fall back to `web_research` when the question
 * is current-events, vendor-specific, or simply not covered locally.
 *
 * Auto-discovered by ratchet's SkillLoader (convention:
 *   skillbox/<box>/tools/<tool-id>.js, default-export handler).
 *
 * Contract:
 *   args.query   : string  (required) — plain-language search query
 *   args.limit   : integer (optional) — max results, clamped to [1, 10]
 *   args.recency : string  (optional) — 'day' | 'week' | 'month' | 'year'
 *                                       bias toward fresher pages; silently
 *                                       dropped if unrecognised
 *   args.region  : string  (optional) — BCP-47 locale ('en-CA') or
 *                                       ISO country code ('CA') for
 *                                       region-biased ranking; passed
 *                                       through to providers that
 *                                       support it
 *
 * Returns:
 *   {
 *     sources : Array<{ id, title, url, excerpt, relevance? }>,
 *     query   : string,
 *     provider: 'tavily' | 'brave' | 'duckduckgo' | 'none',
 *     fromWeb : boolean,
 *     recency?: 'day' | 'week' | 'month' | 'year',  // echoed when resolved
 *     region? : string,                              // echoed when resolved
 *     appliedFilters?: Array<'recency' | 'region'>, // which the provider honoured
 *     note?   : string
 *   }
 *
 * `recency` / `region` are echoed back only when they resolved to a valid
 * value, so the renderer can surface the freshness/region filter the same
 * way `lookup_regulations` echoes `scoringMode` / `hybridWeight`.
 *
 * `appliedFilters` reports which of the *requested* filters the selected
 * provider actually honoured at its API layer. Tavily and Brave map both
 * `recency` and `region` onto provider parameters; the DuckDuckGo HTML SERP
 * exposes `kl`/`df`, but those don't map cleanly from our `en-CA`/`recency`
 * contract, so the DDG provider deliberately applies neither and reports `[]`
 * even when the caller asked for them. The renderer uses this to distinguish
 * "filtered" from "requested but ignored" — a requested filter missing from
 * `appliedFilters` is painted with a "(not applied)" annotation. It is included
 * only when at least one filter resolved (an unfiltered search omits it), and
 * only on the success path — a provider that threw never reported what it
 * applied, so the catch path echoes the requested filters without an
 * `appliedFilters` array.
 *
 * The `sources` shape mirrors `lookup_regulations` so the default
 * `renderSourceCards` renderer paints citation cards for free; the LLM
 * proxy already maps the same shape into [n] citation markers.
 *
 * Provider selection (resolved at handler entry, not at module load —
 * env changes between calls are honoured):
 *   - `RATCHET_WEB_SEARCH_PROVIDER` env var explicitly picks a provider.
 *     Valid: 'tavily' | 'brave' | 'duckduckgo'.
 *   - Otherwise, if `TAVILY_API_KEY` is set → tavily.
 *   - Otherwise, if `BRAVE_SEARCH_API_KEY` is set → brave.
 *   - Otherwise → duckduckgo (the key-free fallback; scrapes the DDG
 *     HTML SERP for a real ranked result list — see `searchDuckDuckGo`).
 *
 * No approval gate — searching the public web is a read. A host that
 * wants human-in-the-loop confirmation can flip `requiresApproval: true`
 * on the manifest entry without changing the handler.
 *
 * Test seam: `__setFetchImpl(fn)` overrides the module's HTTP client so
 * unit tests don't have to touch `globalThis.fetch`. Pass `null` to
 * restore the default. Same spirit as `runEmbedCli`'s `engineFactory`.
 */

const DEFAULT_LIMIT = 5;
const MAX_LIMIT = 10;
const VALID_RECENCY = new Set(['day', 'week', 'month', 'year']);
const VALID_PROVIDERS = new Set(['tavily', 'brave', 'duckduckgo']);
const REQUEST_TIMEOUT_MS = 8000;

let fetchImpl = null;

export function __setFetchImpl(fn) {
  fetchImpl = fn;
}

function resolveFetch() {
  if (typeof fetchImpl === 'function') return fetchImpl;
  if (typeof globalThis.fetch === 'function') return globalThis.fetch.bind(globalThis);
  return null;
}

function resolveProvider(env) {
  const explicit = typeof env.RATCHET_WEB_SEARCH_PROVIDER === 'string'
    ? env.RATCHET_WEB_SEARCH_PROVIDER.trim().toLowerCase()
    : '';
  if (VALID_PROVIDERS.has(explicit)) return explicit;
  if (env.TAVILY_API_KEY) return 'tavily';
  if (env.BRAVE_SEARCH_API_KEY) return 'brave';
  return 'duckduckgo';
}

export default async function webResearch(args, _context) {
  const query = typeof args.query === 'string' ? args.query.trim() : '';
  if (!query) {
    return {
      sources: [],
      query: '',
      provider: 'none',
      fromWeb: false,
      note: 'Empty query — provide a topic or question.',
    };
  }

  const fetcher = resolveFetch();
  if (!fetcher) {
    return {
      sources: [],
      query,
      provider: 'none',
      fromWeb: false,
      note: 'No HTTP client available — web_research requires Node 18+ (global fetch) or a configured fetch shim.',
    };
  }

  const requested = Number.isFinite(args.limit) ? Math.trunc(args.limit) : DEFAULT_LIMIT;
  const limit = Math.max(1, Math.min(MAX_LIMIT, requested));

  const recency = typeof args.recency === 'string' && VALID_RECENCY.has(args.recency)
    ? args.recency
    : undefined;
  const region = typeof args.region === 'string' && args.region.trim()
    ? args.region.trim()
    : undefined;

  // Echo the resolved filters back so the renderer can surface which
  // freshness / region bias produced the results — mirrors the
  // scoringMode / hybridWeight echo on lookup_regulations. Only the
  // fields that actually resolved are spread, so an unfiltered search
  // returns a clean payload. (DuckDuckGo ignores these at the provider
  // layer; the echo still reflects what the caller asked for.)
  const echo = {};
  if (recency) echo.recency = recency;
  if (region) echo.region = region;

  const env = (typeof process !== 'undefined' && process.env) || {};
  const provider = resolveProvider(env);
  const opts = { limit, recency, region, env, fetch: fetcher };

  try {
    let sources;
    let providerNote;
    let appliedFilters;
    switch (provider) {
      case 'tavily':
        ({ sources, note: providerNote, appliedFilters } = await searchTavily(query, opts));
        break;
      case 'brave':
        ({ sources, note: providerNote, appliedFilters } = await searchBrave(query, opts));
        break;
      case 'duckduckgo':
      default:
        ({ sources, note: providerNote, appliedFilters } = await searchDuckDuckGo(query, opts));
        break;
    }

    // Report which of the requested filters the provider actually honoured,
    // but only when at least one filter resolved (an unfiltered search has
    // nothing to report). `appliedFilters` may be []  — that is the DDG
    // "requested but ignored everything" signal the renderer keys off.
    const report =
      (recency || region) && Array.isArray(appliedFilters)
        ? { appliedFilters }
        : {};

    return {
      sources,
      query,
      provider,
      fromWeb: sources.length > 0,
      ...echo,
      ...report,
      note:
        providerNote ||
        (sources.length === 0
          ? 'No matching web results. Say so explicitly rather than guessing.'
          : undefined),
    };
  } catch (err) {
    return {
      sources: [],
      query,
      provider,
      fromWeb: false,
      ...echo,
      note: `Web search failed: ${(err && err.message) || String(err)}`,
    };
  }
}

/**
 * Tavily — JSON POST, designed for LLM grounding. Returns
 * `{ results: [{ title, url, content, score }] }`.
 */
async function searchTavily(query, opts) {
  const apiKey = opts.env.TAVILY_API_KEY;
  if (!apiKey) {
    return {
      sources: [],
      appliedFilters: [],
      note: 'Tavily provider selected but TAVILY_API_KEY is not set.',
    };
  }
  const appliedFilters = [];
  const body = {
    api_key: apiKey,
    query,
    max_results: opts.limit,
    search_depth: 'basic',
  };
  if (opts.recency) {
    // Tavily exposes `days` for trailing-window biasing; map our enum.
    body.days = { day: 1, week: 7, month: 30, year: 365 }[opts.recency];
    appliedFilters.push('recency');
  }
  if (opts.region) {
    body.country = opts.region;
    appliedFilters.push('region');
  }

  const data = await postJson(
    opts.fetch,
    'https://api.tavily.com/search',
    body,
    REQUEST_TIMEOUT_MS
  );
  const results = Array.isArray(data && data.results) ? data.results : [];
  const sources = results.slice(0, opts.limit).map((r, idx) => ({
    id: `tavily-${idx + 1}`,
    title: stringOr(r.title, r.url || 'Untitled'),
    url: typeof r.url === 'string' ? r.url : undefined,
    excerpt: stringOr(r.content, ''),
    relevance: Number.isFinite(r.score) ? clamp01(r.score) : undefined,
  }));
  return { sources, appliedFilters };
}

/**
 * Brave Search API — header-based auth, JSON. Returns
 * `{ web: { results: [{ title, url, description }] } }`.
 */
async function searchBrave(query, opts) {
  const apiKey = opts.env.BRAVE_SEARCH_API_KEY;
  if (!apiKey) {
    return {
      sources: [],
      appliedFilters: [],
      note: 'Brave provider selected but BRAVE_SEARCH_API_KEY is not set.',
    };
  }
  const appliedFilters = [];
  const params = new URLSearchParams({ q: query, count: String(opts.limit) });
  if (opts.recency) {
    // Brave's `freshness` enum: pd / pw / pm / py.
    params.set(
      'freshness',
      { day: 'pd', week: 'pw', month: 'pm', year: 'py' }[opts.recency]
    );
    appliedFilters.push('recency');
  }
  if (opts.region) {
    // Accept either a BCP-47 locale ('en-CA') or a bare country code ('CA').
    // Brave expects the ISO-3166 country code, so split on '-' / '_' first
    // and uppercase the trailing component when one's present. Only count
    // region as applied if a country code actually resolved.
    const parts = opts.region.split(/[-_]/);
    const cc = (parts.length > 1 ? parts[parts.length - 1] : parts[0])
      .slice(0, 2)
      .toUpperCase();
    if (cc) {
      params.set('country', cc);
      appliedFilters.push('region');
    }
  }

  const data = await getJson(
    opts.fetch,
    `https://api.search.brave.com/res/v1/web/search?${params.toString()}`,
    {
      Accept: 'application/json',
      'X-Subscription-Token': apiKey,
    },
    REQUEST_TIMEOUT_MS
  );
  const results = Array.isArray(data && data.web && data.web.results)
    ? data.web.results
    : [];
  const sources = results.slice(0, opts.limit).map((r, idx) => ({
    id: `brave-${idx + 1}`,
    title: stringOr(r.title, r.url || 'Untitled'),
    url: typeof r.url === 'string' ? r.url : undefined,
    excerpt: stringOr(r.description, ''),
  }));
  return { sources, appliedFilters };
}

/**
 * DuckDuckGo HTML SERP — key-free fallback. Unlike the Instant Answer
 * API (which only returns disambiguation pages + related topics and is
 * empty for most real queries), the HTML endpoint returns a genuine
 * ranked result list. We POST the query form-encoded and scrape the
 * `result__a` (title + link) / `result__snippet` (excerpt) anchors out
 * of the returned markup, unwrapping DDG's `/l/?uddg=` redirect into the
 * real target URL.
 *
 * Endpoint: POST https://html.duckduckgo.com/html/  (q=<query>&kl=wt-wt)
 *
 * Tradeoff: this depends on DDG's HTML structure and is rate-limited —
 * fine for a demo / key-free path, not a production SLA. Configure a
 * Tavily or Brave key for a stable full-web API.
 *
 * Recency / region: the HTML endpoint exposes `df`/`kl`, but neither maps
 * cleanly from our `recency` enum / BCP-47 `region`, so we apply neither
 * and report `appliedFilters: []` — keeping the renderer's "(not applied)"
 * annotation honest.
 */
async function searchDuckDuckGo(query, opts) {
  const params = new URLSearchParams({ q: query, kl: 'wt-wt' });
  const html = await postForm(
    opts.fetch,
    'https://html.duckduckgo.com/html/',
    params,
    REQUEST_TIMEOUT_MS
  );

  const sources = parseDdgResults(html, opts.limit).map((r, idx) => ({
    id: `ddg-${idx + 1}`,
    title: stringOr(r.title, r.url || 'Untitled'),
    url: r.url || undefined,
    excerpt: stringOr(r.excerpt, ''),
  }));

  const note =
    sources.length === 0
      ? 'DuckDuckGo returned no parseable results for this query. Configure TAVILY_API_KEY or BRAVE_SEARCH_API_KEY for richer full-web results.'
      : undefined;
  return { sources, note, appliedFilters: [] };
}

/**
 * Scrape `{ title, url, excerpt }` triples out of DuckDuckGo's HTML SERP.
 *
 * Each result wraps an `<a class="result__a" href="…">title</a>` followed
 * by an `<a class="result__snippet">excerpt</a>`. We walk anchors in
 * document order: a `result__a` opens a pending result; the next
 * `result__snippet` closes and emits it (results without a snippet are
 * skipped, mirroring the reference parser). URLs are de-duplicated and the
 * list is capped at `limit`. No DOM dependency — a light anchor scan is
 * enough and keeps the handler runnable under plain Node.
 */
function parseDdgResults(html, limit) {
  if (typeof html !== 'string' || !html) return [];
  const anchorRe = /<a\b([^>]*)>([\s\S]*?)<\/a>/gi;
  const collected = [];
  let cur = null;
  let m;
  while ((m = anchorRe.exec(html)) !== null) {
    const attrs = m[1];
    const inner = m[2];
    const cls = attrMatch(attrs, 'class');
    if (cls.includes('result__a')) {
      cur = {
        title: decodeEntities(stripTags(inner)).trim(),
        url: cleanDdgHref(attrMatch(attrs, 'href')),
        excerpt: '',
      };
    } else if (cls.includes('result__snippet') && cur) {
      cur.excerpt = decodeEntities(stripTags(inner)).trim();
      collected.push(cur);
      cur = null;
    }
  }

  const seen = new Set();
  const out = [];
  for (const r of collected) {
    if (!r.url || seen.has(r.url)) continue;
    seen.add(r.url);
    out.push(r);
    if (out.length >= limit) break;
  }
  return out;
}

function attrMatch(attrs, name) {
  const m = new RegExp(`${name}\\s*=\\s*"([^"]*)"`, 'i').exec(attrs || '');
  return m ? m[1] : '';
}

function stripTags(s) {
  return String(s).replace(/<[^>]*>/g, '');
}

/**
 * DDG wraps result links as `//duckduckgo.com/l/?uddg=<encoded-url>&…`.
 * Unwrap to the real target; pass through already-absolute hrefs.
 */
function cleanDdgHref(href) {
  if (!href) return '';
  let h = decodeEntities(href);
  if (h.startsWith('//')) h = 'https:' + h;
  try {
    const u = new URL(h, 'https://duckduckgo.com');
    if (u.pathname.endsWith('/l/') || u.searchParams.has('uddg')) {
      const target = u.searchParams.get('uddg');
      if (target) return target;
    }
    return u.href;
  } catch {
    return h;
  }
}

/** Decode the handful of HTML entities DDG emits in titles, snippets, hrefs. */
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

async function postJson(fetcher, url, body, timeoutMs) {
  const res = await withTimeout(
    fetcher(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    }),
    timeoutMs
  );
  if (!res.ok) throw new Error(`HTTP ${res.status} from ${url}`);
  return res.json();
}

async function getJson(fetcher, url, headers, timeoutMs) {
  const res = await withTimeout(fetcher(url, { headers }), timeoutMs);
  if (!res.ok) throw new Error(`HTTP ${res.status} from ${url}`);
  return res.json();
}

async function postForm(fetcher, url, params, timeoutMs) {
  const res = await withTimeout(
    fetcher(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
        Accept: 'text/html,application/xhtml+xml',
        'User-Agent': 'Mozilla/5.0 (compatible; ratchet/web_research; +local)',
      },
      body: params.toString(),
    }),
    timeoutMs
  );
  if (!res.ok) throw new Error(`HTTP ${res.status} from ${url}`);
  return res.text();
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

function stringOr(value, fallback) {
  return typeof value === 'string' && value.trim() ? value : fallback;
}

function clamp01(n) {
  if (!Number.isFinite(n)) return undefined;
  if (n < 0) return 0;
  if (n > 1) return 1;
  return n;
}
