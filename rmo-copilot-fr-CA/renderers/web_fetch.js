/**
 * Lumber-Copilot fr-CA peer — web_fetch renderer.
 *
 * French (Canadian) override for the rmo-copilot primary's web_fetch
 * renderer. Mirrors the English primary's DOM shape and CSS class names
 * one-for-one (same `lc-fetch-header` / `lc-fetch-body` / `lc-fetch-footer`
 * classes, same header → card → preview → footer ordering, same
 * `renderSourceCards` delegation) so theming and renderer-error isolation
 * behave identically across locales — only the visible strings change.
 */

const PREVIEW_LIMIT = 600;

export default function register(ctx) {
  const { registerRenderer, renderSourceCards, renderNote } = ctx;

  registerRenderer('web_fetch', (node, payload, opts) => {
    const header = document.createElement('div');
    header.className = 'ratchet-tool-note ratchet-tool-note-strong lc-fetch-header';
    const title =
      payload && typeof payload === 'object' && typeof payload.title === 'string'
        ? payload.title.trim()
        : '';
    header.textContent = title ? `Page récupérée — ${title}` : 'Page récupérée';
    node.appendChild(header);

    const sources = Array.isArray(payload?.sources) ? payload.sources : [];
    const text = payload && typeof payload.text === 'string' ? payload.text : '';

    if (sources.length === 0 && !text) {
      renderNote(
        node,
        'Impossible de récupérer cette page. Essayez une autre URL ou relancez web_search pour une autre source.'
      );
      return;
    }

    if (sources.length > 0) {
      renderSourceCards(node, payload, opts);
    }

    if (text) {
      const preview = document.createElement('div');
      preview.className = 'ratchet-tool-card-excerpt lc-fetch-body';
      const shown = text.length > PREVIEW_LIMIT ? `${text.slice(0, PREVIEW_LIMIT)}…` : text;
      preview.textContent = shown;
      node.appendChild(preview);
    }

    if (payload && payload.truncated) {
      const footer = document.createElement('div');
      footer.className = 'ratchet-tool-card-meta lc-fetch-footer';
      footer.textContent =
        'Corps tronqué pour l’affichage — récupérez avec un maxChars plus grand pour plus de contenu.';
      node.appendChild(footer);
    }
  });
}
