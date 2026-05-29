/**
 * Lumber-Copilot fr-CA peer — web_research renderer (Session 64).
 *
 * French (Canadian) override for the rmo-copilot primary's web_research
 * renderer. Mirrors the English primary's DOM shape and CSS class names
 * one-for-one (same `lc-web-header` / `lc-web-filters` /
 * `ratchet-tool-scoring-echo` / `lc-web-footer` classes, same header →
 * pill → cards → footer ordering, same `renderSourceCards` delegation)
 * so theming, layout, and renderer-error isolation behave identically
 * across locales — only the visible strings change.
 *
 * The aggregator's `branding.renderers` map applies last-wins per toolId,
 * and the loader's deterministic alphabetic ordering pins `rmo-copilot`
 * before `rmo-copilot-fr-CA`, so the peer's URL wins on the
 * `/api/branding` wire when SKILLBOX_ENABLE=rmo-copilot-fr-CA is set.
 *
 * No sibling helpers needed — like the English primary, this renderer is
 * pure string assembly with no locale-aware stamp dependency, so it stays
 * a synchronous `register`. Provider labels (Tavily / Brave Search /
 * DuckDuckGo) are proper nouns and stay untranslated; the regulation /
 * web-result excerpts themselves are whatever the source returned and are
 * out of scope for this renderer.
 */

export default function register(ctx) {
  const { registerRenderer, renderSourceCards, renderNote } = ctx;

  registerRenderer('web_research', (node, payload, opts) => {
    // Header banner — marks this as web search results (not KB).
    const header = document.createElement('div');
    header.className =
      'ratchet-tool-note ratchet-tool-note-strong lc-web-header';
    const queryStr =
      payload && typeof payload === 'object' && typeof payload.query === 'string'
        ? `Recherche Web — « ${payload.query} »`
        : 'Résultats de recherche Web';
    header.textContent = queryStr;
    node.appendChild(header);

    // Filter-echo pill — surfaces the freshness / region bias the handler
    // applied. Painted above the cards (after the header) and only when at
    // least one filter resolved, so an unfiltered search stays clean.
    const recencyLabels = {
      day: 'dernier jour',
      week: 'dernière semaine',
      month: 'dernier mois',
      year: 'dernière année',
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
    // annotate it « (non appliqué) ». When the payload omits appliedFilters —
    // older payloads, or the catch path that never resolved an applied set —
    // assume the filter was honoured (the Session-62 behaviour).
    const applied =
      payload && Array.isArray(payload.appliedFilters)
        ? payload.appliedFilters
        : null;
    const notApplied = (name) =>
      applied !== null && !applied.includes(name) ? ' (non appliqué)' : '';
    const filterParts = [];
    if (recencyLabels[recency]) {
      filterParts.push(
        `fraîcheur : ${recencyLabels[recency]}${notApplied('recency')}`
      );
    }
    if (region) {
      filterParts.push(`région : ${region}${notApplied('region')}`);
    }
    if (filterParts.length > 0) {
      const pill = document.createElement('div');
      pill.className = 'ratchet-tool-scoring-echo lc-web-filters';
      pill.textContent = filterParts.join(' · ');
      node.appendChild(pill);
    }

    // Delegate card rendering to the default.
    renderSourceCards(node, payload, opts);

    // Footer summary: show provider + result count.
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
        `${sources.length} ${sources.length === 1 ? 'résultat' : 'résultats'}`,
        `source : ${providerLabel}`,
      ];
      summary.textContent = parts.join(' · ');
      node.appendChild(summary);
    }

    // Fallback message if no results.
    if (sources.length === 0) {
      renderNote(
        node,
        'Aucun résultat Web trouvé. Essayez une autre requête ou configurez TAVILY_API_KEY / BRAVE_SEARCH_API_KEY pour une meilleure couverture.'
      );
    }
  });
}
