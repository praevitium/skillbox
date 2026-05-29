/**
 * Lumber-Copilot — web_fetch renderer.
 *
 * Paints the result of fetching a single page: a "Fetched page" header
 * (with the page title when known), the source card for the URL (so it
 * earns a [n] citation like every other source), a short body preview,
 * and a footer noting truncation when the body was capped. Falls back to
 * a renderNote when the fetch returned nothing. Mirrors the web_search
 * renderer's structure + class-naming convention so web results and
 * fetched pages read consistently.
 *
 * Module contract:
 *   default export = function register({ registerRenderer,
 *                                        renderSourceCards,
 *                                        renderNote }) { ... }
 */

const PREVIEW_LIMIT = 600;

export default function register(ctx) {
  const { registerRenderer, renderSourceCards, renderNote } = ctx;

  registerRenderer('web_fetch', (node, payload, opts) => {
    // Header banner — marks this as a fetched page (not a SERP).
    const header = document.createElement('div');
    header.className = 'ratchet-tool-note ratchet-tool-note-strong lc-fetch-header';
    const title =
      payload && typeof payload === 'object' && typeof payload.title === 'string'
        ? payload.title.trim()
        : '';
    header.textContent = title ? `Fetched page — ${title}` : 'Fetched page';
    node.appendChild(header);

    const sources = Array.isArray(payload?.sources) ? payload.sources : [];
    const text = payload && typeof payload.text === 'string' ? payload.text : '';

    // No body recovered → just the fallback note.
    if (sources.length === 0 && !text) {
      renderNote(
        node,
        'Could not fetch this page. Try a different URL or run web_search again for another source.'
      );
      return;
    }

    // Delegate the URL card to the default so it earns a [n] citation.
    if (sources.length > 0) {
      renderSourceCards(node, payload, opts);
    }

    // Body preview — the readable text the model actually read.
    if (text) {
      const preview = document.createElement('div');
      preview.className = 'ratchet-tool-card-excerpt lc-fetch-body';
      const shown = text.length > PREVIEW_LIMIT ? `${text.slice(0, PREVIEW_LIMIT)}…` : text;
      preview.textContent = shown;
      node.appendChild(preview);
    }

    // Footer — flag truncation so the reader knows the body was capped.
    if (payload && payload.truncated) {
      const footer = document.createElement('div');
      footer.className = 'ratchet-tool-card-meta lc-fetch-footer';
      footer.textContent = 'Body truncated to fit — fetch with a larger maxChars for more.';
      node.appendChild(footer);
    }
  });
}
