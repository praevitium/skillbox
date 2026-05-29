/**
 * Lumber-Copilot — lookup_regulations renderer.
 *
 * Wraps the default source-card renderer with a "Trucking regulations"
 * header banner and a footer summary line (count + last-updated dates
 * if present). Demonstrates that a skillbox-shipped renderer composes
 * on top of the built-in helpers rather than re-implementing them.
 *
 * Module contract:
 *   default export = function register({ registerRenderer,
 *                                        renderSourceCards,
 *                                        renderNote,
 *                                        renderJsonBlock }) { ... }
 *
 * The ratchet panel calls `register(ctx)` once after dynamic-import.
 * Anything we register replaces the host-side renderer (last call wins)
 * and ranks above the shape-matched default.
 */

export default function register(ctx) {
  const { registerRenderer, renderSourceCards, renderNote } = ctx;

  registerRenderer('lookup_regulations', (node, payload, opts) => {
    // Header banner — makes the citation block visually distinct from
    // generic JSON tool output so drivers immediately know "this is the
    // regulation lookup."
    const header = document.createElement('div');
    header.className =
      'ratchet-tool-note ratchet-tool-note-strong lc-regs-header';
    const queryStr =
      payload && typeof payload === 'object' && typeof payload.query === 'string'
        ? `Trucking regulations — "${payload.query}"`
        : 'Trucking regulations';
    header.textContent = queryStr;
    node.appendChild(header);

    // Delegate the actual card rendering to the default. We pass the
    // same opts through so a host can still override excerptLimit.
    renderSourceCards(node, payload, opts);

    // Footer summary. Surfaces freshness (most-recent lastUpdated) and
    // the source-of-truth label so drivers know whether to trust the
    // answer. Skipped entirely when there are no sources to summarise —
    // but in that case we still drop a soft reminder so the chat doesn't
    // look empty when the lookup returned nothing (unless the handler
    // already supplied its own degraded `note`).
    const sources = Array.isArray(payload?.sources) ? payload.sources : [];
    if (sources.length === 0) {
      if (!payload?.note) {
        renderNote(node, 'No matching regulation found in the KB.');
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
      parts.push(`most recent: ${newest.toISOString().slice(0, 10)}`);
    }
    parts.push('source: trucking-regulations KB');
    summary.textContent = parts.join(' · ');
    node.appendChild(summary);
  });
}
