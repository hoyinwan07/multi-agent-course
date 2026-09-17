/**
 * web_search — find URLs. It produces NO evidence (§6.2).
 *
 * The teaser a search API returns is not something an answer may cite: the grounding gate
 * looks for a snippet in the fetched page, and a provider's teaser is frequently a
 * rewrite of it. So this tool hands the model a numbered menu of URLs and nothing else,
 * and the observation says so in as many words — a model that is told it cannot cite from
 * here is much less likely to try.
 *
 * A failure of this tool is a PROVIDER failure: the search API is the run's one way to
 * find anything. It throws, and the run ends as terminated:"error" with a 502. That is
 * deliberate — the alternative is an answer that says "I couldn't find anything" when the
 * truth was a rejected key.
 */
import { cachedSearch } from '../cache/searchCache.js';
import { logFor } from '../obs/log.js';
import { searchProviderName, type SearchHit } from '../providers/search.js';
import type { Tool, ToolContext, ToolResult } from './types.js';

const MAX_RESULTS = 6;

/**
 * Hard ceiling on searches per request: the eager one plus refinements. The prompt asks
 * for at most one refinement; this catches the case where the model keeps rephrasing
 * instead of reading. Each search is a billed provider call and ~1.4s of the latency
 * budget, so an unbounded retry loop is a spend bug, not a quality feature.
 */
const MAX_SEARCHES = 3;

export const webSearch: Tool = {
  name: 'web_search',

  description: [
    'Search the web for pages that might answer the question. Returns a numbered list of',
    'titles and URLs.',
    '',
    'This returns LINKS ONLY. The teaser text is a hint for picking pages and MUST NOT be',
    'quoted, cited, or used as a source — only fetch_page produces citable text. After',
    'searching, call fetch_page on the 3-4 most promising URLs in a SINGLE turn so they',
    'are read in parallel.'
  ].join('\n'),

  inputSchema: {
    type: 'object',
    properties: {
      query: {
        type: 'string',
        description:
          'The search query. Keywords, not a sentence — rewrite the question into the terms a page answering it would contain.'
      }
    },
    required: ['query'],
    additionalProperties: false
  },

  async run(input: Record<string, unknown>, ctx: ToolContext): Promise<ToolResult> {
    const query = typeof input.query === 'string' ? input.query.trim() : '';
    if (!query) return { ok: false, error: 'web_search requires a non-empty "query" string' };

    if (ctx.search.searches >= MAX_SEARCHES) {
      // A tool-level refusal, so the model sees it and moves on to reading pages.
      return {
        ok: false,
        error: `search budget spent (${MAX_SEARCHES} searches). Work with the results you already have.`,
        reason: `refused a ${ctx.search.searches + 1}th search`
      };
    }

    ctx.search.searches += 1;

    const { hits, cached } = await cachedSearch(
      query,
      { maxResults: MAX_RESULTS, signal: ctx.signal },
      logFor(ctx.requestId, ctx.userId)
    );

    // The accounting behind `searchCached` lives here, next to the `searches` counter it
    // has to agree with. A cache hit costs nothing and must never reach `providerCalls`:
    // billing for a call that was not made overstates the cost of every cached run.
    if (cached) ctx.search.searchHits += 1;
    else ctx.search.providerCalls += 1;

    const via = cached ? 'cache' : searchProviderName();

    if (!hits.length) {
      // A provider that ran and found nothing is a legitimate empty result, not an error.
      // The run continues and, if it stays empty, terminates as `done` with no citations.
      return {
        ok: true,
        observation: `No results for "${query}". Try different keywords, or say that the search found nothing.`,
        reason: `searched ${via} for "${query}" — no results`
      };
    }

    return {
      ok: true,
      observation: renderHits(hits),
      reason: `searched ${via} for "${query}" — ${hits.length} results`
    };
  }
};

function renderHits(hits: SearchHit[]): string {
  const lines = hits.map(
    (h, i) => `${i + 1}. ${h.title}\n   ${h.url}${h.snippet ? `\n   hint: ${clip(h.snippet)}` : ''}`
  );
  return [
    `${hits.length} results (links only — nothing here is citable):`,
    ...lines,
    '',
    'Call fetch_page on the 3-4 best URLs in one turn.'
  ].join('\n');
}

/** The hint exists to rank, not to inform. Every character is billed on every later turn. */
const clip = (s: string): string => {
  const one = s.replace(/\s+/g, ' ').trim();
  return one.length > 160 ? `${one.slice(0, 160)}…` : one;
};
