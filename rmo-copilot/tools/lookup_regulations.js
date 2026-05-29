/**
 * Server-side handler for the `lookup_regulations` tool.
 *
 * Auto-discovered by ratchet's SkillLoader (convention:
 *   skillbox/<box>/tools/<tool-id>.js, default-export handler).
 *
 * The handler runs inside the ratchet backend, so it can reach the
 * shared RAG engine through `context.services.rag`. We never import
 * ratchet internals directly — that would couple this skillbox to a
 * specific ratchet version. The services bag is the contract.
 *
 * Contract:
 *   args.query        : string  (required) — plain-language topic
 *   args.limit        : integer (optional) — max results, clamped to [1, 10]
 *   args.scoringMode  : string  (optional) — 'lexical' | 'embedding' | 'hybrid'
 *                                            override of the engine default
 *   args.hybridWeight : number  (optional) — [0,1] cosine weight when
 *                                            mode is hybrid; lexical gets
 *                                            (1 - weight). Bias toward
 *                                            lexical for rare proper
 *                                            nouns (regulation IDs).
 *
 * Returns:
 *   { sources: Array<{ id, title, url?, excerpt, relevance? }>,
 *     query, fromKb: boolean, scoringMode?: string, hybridWeight?: number,
 *     note?: string }
 *
 * The shape mirrors what the LLM proxy already feeds into the prompt
 * for [n] citation markers, so the model can quote the result without
 * us having to teach it a new format. `scoringMode` / `hybridWeight`
 * are echoed only when the caller passed them through, so a debug
 * surface (or a renderer) can show "this search was lexical-biased"
 * without having to inspect the engine's config.
 */

const DEFAULT_LIMIT = 5;
const MAX_LIMIT = 10;
const VALID_MODES = new Set(['lexical', 'embedding', 'hybrid']);

export default async function lookupRegulations(args, context) {
  const query = typeof args.query === 'string' ? args.query.trim() : '';
  if (!query) {
    return {
      sources: [],
      query: '',
      fromKb: false,
      note: 'Empty query — provide a topic or question.',
    };
  }

  const rag = context?.services?.rag;
  if (!rag || typeof rag.retrieve !== 'function') {
    return {
      sources: [],
      query,
      fromKb: false,
      note: 'Regulation KB is not available in this deployment.',
    };
  }

  const requested = Number.isFinite(args.limit) ? Math.trunc(args.limit) : DEFAULT_LIMIT;
  const limit = Math.max(1, Math.min(MAX_LIMIT, requested));

  // Optional per-call retrieval overrides. The engine treats handler
  // input as untrusted (invalid values fall back to the configured
  // defaults), but we still drop obviously-bad values here so the echo
  // fields in the response reflect what actually ran.
  const opts = {};
  const echo = {};
  if (typeof args.scoringMode === 'string' && VALID_MODES.has(args.scoringMode)) {
    opts.mode = args.scoringMode;
    echo.scoringMode = args.scoringMode;
  }
  if (Number.isFinite(args.hybridWeight)) {
    const w = Math.max(0, Math.min(1, args.hybridWeight));
    opts.weight = w;
    echo.hybridWeight = w;
  }

  const sources = await rag.retrieve(query, limit, opts);

  return {
    sources,
    query,
    fromKb: true,
    ...echo,
    note:
      sources.length === 0
        ? 'No matching entries in the trucking-regulations KB. Say so explicitly rather than guessing.'
        : undefined,
  };
}
