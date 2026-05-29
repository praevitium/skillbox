/**
 * Lumber-Copilot — web_search renderer.
 *
 * Wraps the default source-card renderer with a "Web search results"
 * header banner and footer showing the search provider + result count.
 * Mirrors the lookup_regulations renderer style so web and KB results
 * have consistent visual presentation.
 *
 * Module contract:
 *   default export = function register({ registerRenderer,
 *                                        renderSourceCards,
 *                                        renderNote }) { ... }
 *
 * The ratchet panel calls `register(ctx)` once after dynamic-import.
 */

export default function register(ctx) {
  const { registerRenderer, renderSourceCards, renderNote } = ctx;

  registerRenderer('web_search', (node, payload, opts) => {
    // Header banner — marks this as web search results (not KB)
    const header = document.createElement('div');
    header.className =
      'ratchet-tool-note ratchet-tool-note-strong lc-web-header';
    const queryStr =
      payload && typeof payload === 'object' && typeof payload.query === 'string'
        ? `Web search — "${payload.query}"`
        : 'Web search results';
    header.textContent = queryStr;
    node.appendChild(header);

    // Filter-echo pill — surfaces the freshness / region bias the handler
    // applied, mirroring lookup_regulations' "scoring: hybrid · weight: …"
    // pill. Painted above the cards (after the header) and only when at
    // least one filter resolved, so an unfiltered search stays clean.
    const recencyLabels = {
      day: 'past day',
      week: 'past week',
      month: 'past month',
      year: 'past year',
    };
    const recency =
      payload && typeof payload.recency === 'string' ? payload.recency : '';
    const region =
      payload && typeof payload.region === 'string' && payload.region.trim()
        ? payload.region.trim()
        : '';
    // `appliedFilters` (when present) lists which requested filters the
    // provider actually honoured. A requested filter missing from it was
    // ignored at the provider layer (e.g. DuckDuckGo supports neither), so
    // annotate it "(not applied)". When the payload omits appliedFilters —
    // older payloads, or the catch path that never resolved an applied set —
    // assume the filter was honoured (the Session-62 behaviour).
    const applied =
      payload && Array.isArray(payload.appliedFilters)
        ? payload.appliedFilters
        : null;
    const notApplied = (name) =>
      applied !== null && !applied.includes(name) ? ' (not applied)' : '';
    const filterParts = [];
    if (recencyLabels[recency]) {
      filterParts.push(
        `freshness: ${recencyLabels[recency]}${notApplied('recency')}`
      );
    }
    if (region) {
      filterParts.push(`region: ${region}${notApplied('region')}`);
    }
    if (filterParts.length > 0) {
      const pill = document.createElement('div');
      pill.className = 'ratchet-tool-scoring-echo lc-web-filters';
      pill.textContent = filterParts.join(' · ');
      node.appendChild(pill);
    }

    // Delegate card rendering to the default.
    renderSourceCards(node, payload, opts);

    // Footer summary: show provider + result count
    const sources = Array.isArray(payload?.sources) ? payload.sources : [];
    if (sources.length > 0) {
      const summary = document.createElement('div');
      summary.className = 'ratchet-tool-card-meta lc-web-footer';
      const provider = payload?.provider || 'unknown';
      const providerLabel =
        provider === 'tavily'
          ? 'Tavily'
          : provider === 'brave'
            ? 'Brave Search'
            : provider === 'duckduckgo'
              ? 'DuckDuckGo'
              : 'Web';
      const parts = [
        `${sources.length} ${sources.length === 1 ? 'result' : 'results'}`,
        `source: ${providerLabel}`,
      ];
      summary.textContent = parts.join(' · ');
      node.appendChild(summary);
    }

    // Fallback message if no results
    if (sources.length === 0) {
      renderNote(
        node,
        'No web results found. Try a different query or configure TAVILY_API_KEY / BRAVE_SEARCH_API_KEY for better coverage.'
      );
    }
  });
}
