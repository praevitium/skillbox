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
 * `recency` and `region` onto provider parameters; DuckDuckGo's Instant
 * Answer endpoint supports neither, so it reports `[]` even when the caller
 * asked for them. The renderer uses this to distinguish "filtered" from
 * "requested but ignored" — a requested filter missing from `appliedFilters`
 * is painted with a "(not applied)" annotation. It is included only when at
 * least one filter resolved (an unfiltered search omits it), and only on the
 * success path — a provider that threw never reported what it applied, so the
 * catch path echoes the requested filters without an `appliedFilters` array.
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
 *   - Otherwise → duckduckgo (the key-free fallback; limited to
 *     Instant Answers + related topics, but useful for the demo).
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
 * DuckDuckGo Instant Answer API — key-free fallback. Limited to
 * disambiguation pages, instant answers, and related topics — NOT a
 * full SERP. Adequate for the demo path and any query that DDG has a
 * structured answer for; falls back to RelatedTopics for topical
 * queries.
 *
 * Endpoint: api.duckduckgo.com/?q=<query>&format=json&no_html=1
 *
 * Recency / region are not supported by this endpoint; we accept the
 * args and silently ignore them so the contract stays stable.
 */
async function searchDuckDuckGo(query, opts) {
  const params = new URLSearchParams({
    q: query,
    format: 'json',
    no_html: '1',
    skip_disambig: '1',
  });
  const data = await getJson(
    opts.fetch,
    `https://api.duckduckgo.com/?${params.toString()}`,
    { Accept: 'application/json' },
    REQUEST_TIMEOUT_MS
  );

  const sources = [];
  if (data && typeof data === 'object') {
    if (data.AbstractText && data.AbstractURL) {
      sources.push({
        id: 'ddg-abstract',
        title: stringOr(data.Heading, 'Result'),
        url: data.AbstractURL,
        excerpt: stringOr(data.AbstractText, ''),
      });
    }
    if (Array.isArray(data.Results)) {
      for (const r of data.Results) {
        if (sources.length >= opts.limit) break;
        if (r && r.FirstURL) {
          sources.push({
            id: `ddg-result-${sources.length + 1}`,
            title: stringOr(r.Text, r.FirstURL),
            url: r.FirstURL,
            excerpt: stringOr(r.Text, ''),
          });
        }
      }
    }
    if (Array.isArray(data.RelatedTopics)) {
      for (const t of data.RelatedTopics) {
        if (sources.length >= opts.limit) break;
        if (t && t.FirstURL) {
          sources.push({
            id: `ddg-related-${sources.length + 1}`,
            title: stringOr(t.Text, t.FirstURL),
            url: t.FirstURL,
            excerpt: stringOr(t.Text, ''),
          });
        }
      }
    }
  }

  const note =
    sources.length === 0
      ? 'DuckDuckGo Instant Answer returned nothing for this query. Configure TAVILY_API_KEY or BRAVE_SEARCH_API_KEY for richer full-web results.'
      : undefined;
  // DDG's Instant Answer endpoint honours neither recency nor region, so it
  // never applies a requested filter — report an empty set so the renderer
  // can annotate any requested filter as "(not applied)".
  return { sources, note, appliedFilters: [] };
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
