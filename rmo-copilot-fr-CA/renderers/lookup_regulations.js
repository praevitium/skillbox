/**
 * Lumber-Copilot fr-CA peer — lookup_regulations renderer (Session 65).
 *
 * French (Canadian) override for the rmo-copilot primary's
 * lookup_regulations renderer. Completes the fr-CA peer renderer set:
 * the peer now overrides all five rmo-copilot tool-result renderers
 * (draft_timesheet + draft_dvir + summarize_pay_period + web_research +
 * lookup_regulations).
 *
 * Mirrors the English primary's DOM shape and CSS class names one-for-one
 * (same `lc-regs-header` / `lc-regs-footer` classes, same header → cards →
 * footer ordering, same `renderSourceCards(node, payload, opts)`
 * delegation) so theming, layout, and renderer-error isolation behave
 * identically across locales — only the visible chrome strings change.
 *
 * The aggregator's `branding.renderers` map applies last-wins per toolId,
 * and the loader's deterministic alphabetic ordering pins `rmo-copilot`
 * before `rmo-copilot-fr-CA`, so the peer's URL wins on the
 * `/api/branding` wire when SKILLBOX_ENABLE=rmo-copilot-fr-CA is set.
 *
 * Scope — translate the chrome, not the data: the header/footer/note are
 * renderer-owned copy and are translated; the KB excerpts the cards paint
 * are whatever the trucking-regulations corpus returned (currently en-CA)
 * and stay as-is. This is the same posture web_research takes with its
 * source excerpts (Session 64). A fr-CA RAG corpus would be a separate
 * slice; until then a fr-CA driver still gets French chrome over the
 * shared en-CA citations — strictly better than English chrome.
 *
 * No sibling helpers needed — like the English primary, this renderer is
 * pure string assembly with no locale-aware stamp dependency, so it stays
 * a synchronous `register`. The "source-of-truth" KB label is translated
 * as a noun phrase, not a brand name, so it reads naturally in French.
 */

export default function register(ctx) {
  const { registerRenderer, renderSourceCards, renderNote } = ctx;

  registerRenderer('lookup_regulations', (node, payload, opts) => {
    // Header banner — marks the citation block as the regulation lookup.
    const header = document.createElement('div');
    header.className =
      'ratchet-tool-note ratchet-tool-note-strong lc-regs-header';
    const queryStr =
      payload && typeof payload === 'object' && typeof payload.query === 'string'
        ? `Règlements de camionnage — « ${payload.query} »`
        : 'Règlements de camionnage';
    header.textContent = queryStr;
    node.appendChild(header);

    // Delegate the actual card rendering to the default. Same opts pass-through
    // so a host can still override excerptLimit.
    renderSourceCards(node, payload, opts);

    // Footer summary: result count + freshness (most-recent lastUpdated) +
    // the source-of-truth label. Skipped entirely when there are no sources.
    const sources = Array.isArray(payload?.sources) ? payload.sources : [];
    if (sources.length === 0) {
      // Mirror the English primary: on empty sources, skip the footer and
      // drop a soft French reminder so the chat doesn't look empty (unless
      // the handler already supplied its own degraded `note`).
      if (!payload?.note) {
        renderNote(
          node,
          'Aucun règlement correspondant trouvé dans la base de connaissances.'
        );
      }
      return;
    }

    const summary = document.createElement('div');
    summary.className = 'ratchet-tool-card-meta lc-regs-footer';
    const dates = sources
      .map((s) => (s && s.lastUpdated ? new Date(s.lastUpdated) : null))
      .filter((d) => d instanceof Date && !Number.isNaN(d.valueOf()));
    const newest = dates.length
      ? new Date(Math.max(...dates.map((d) => d.valueOf())))
      : null;
    const parts = [`${sources.length} ${sources.length === 1 ? 'source' : 'sources'}`];
    if (newest) {
      parts.push(`plus récent : ${newest.toISOString().slice(0, 10)}`);
    }
    parts.push('source : base de connaissances réglementation-camionnage');
    summary.textContent = parts.join(' · ');
    node.appendChild(summary);
  });
}
