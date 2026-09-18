/**
 * search_documents — hybrid retrieval over the current Space's `chunks` (§5.4). The RAG
 * counterpart to `fetch_page`: it is the ONLY way to get text a document citation may
 * quote, and — like `fetch_page` — the model is shown a short receipt, never the chunk
 * text itself. The text travels to Phase 2 through the evidence store, the same path
 * `fetch_page` uses, which is what lets `evidence/select.ts` pick a verbatim snippet from
 * text the model never had a chance to paraphrase.
 *
 * Retrieval itself (`$vectorSearch` + `$search`, fused by RRF) lives in `repo/chunks.ts` —
 * the `repo/` rule means this file never touches the Mongo driver.
 *
 * A failure here is a TOOL failure, same reasoning as `fetch_page`'s 403: a Space with no
 * matching passage is a legitimate empty result, not a broken run.
 */
import { embed } from '../providers/embed.js';
import { documentTitles } from '../repo/documents.js';
import { hybridSearchChunks, type ChunkHit } from '../repo/chunks.js';
import type { EvidenceItem } from '../evidence/store.js';
import type { Tool, ToolContext, ToolResult } from './types.js';

export const searchDocuments: Tool = {
  name: 'search_documents',

  description: [
    'Search the current Space\'s uploaded documents for passages that might answer the',
    'question. This is the ONLY way to get text a document citation may quote.',
    '',
    'Returns a short receipt, not the passages themselves — their text is held for the',
    'answer step, where you will be given every passage found, numbered. Only usable when',
    'the request named a Space; if none was named, this tool is not offered.'
  ].join('\n'),

  inputSchema: {
    type: 'object',
    properties: {
      query: { type: 'string', description: 'What to search for. Keywords or a short phrase.' }
    },
    required: ['query'],
    additionalProperties: false
  },

  async run(input: Record<string, unknown>, ctx: ToolContext): Promise<ToolResult> {
    const query = typeof input.query === 'string' ? input.query.trim() : '';
    if (!query) return { ok: false, error: 'search_documents requires a non-empty "query" string' };

    // Defensive, not the real gate: `registry.forGear` only offers this tool when a Space
    // was named, but the eager call in `loop/retrieve.ts` reaches here directly.
    if (!ctx.spaceId) return { ok: false, error: 'no Space is attached to this request' };

    const { vector, tokens } = await embed(query);
    ctx.embeddingTokens.total += tokens;

    const hits = await hybridSearchChunks({ spaceId: ctx.spaceId, userId: ctx.userId, vector, text: query });
    if (!hits.length) {
      return {
        ok: true,
        observation: `No matching passages in this Space for "${query}".`,
        reason: 'searched the Space — no matches'
      };
    }

    // One citation per PAGE (or heading, or line block), not per chunk: a long page split
    // into several chunks would otherwise mint several near-duplicate citations to the same
    // spot. `hits` already arrives ranked by RRF score, so keeping the first occurrence of
    // a locator keeps the best-scoring chunk for it.
    const survivors: ChunkHit[] = [];
    const seenLocators = new Set<string>();
    for (const hit of hits) {
      const key = `${hit.docId}:${locatorKey(hit.locator)}`;
      if (seenLocators.has(key)) continue;
      seenLocators.add(key);
      survivors.push(hit);
    }

    const titles = await documentTitles([...new Set(survivors.map((h) => h.docId))], ctx.userId);

    const evidence: EvidenceItem[] = survivors.map((hit) => ({
      id: `${hit.docId}:${locatorKey(hit.locator)}`,
      kind: 'doc',
      title: titles.get(hit.docId) ?? hit.docId,
      docId: hit.docId,
      locator: hit.locator,
      fullText: hit.text,
      sentText: hit.text,
      segments: [hit.text]
    }));

    return {
      ok: true,
      evidence,
      observation: renderHits(evidence),
      reason: `searched the Space — ${evidence.length} passage(s) across ${titles.size} document(s)`
    };
  }
};

function renderHits(items: EvidenceItem[]): string {
  const lines = items.map((item, i) => `${i + 1}. ${item.title}${locatorSuffix(item)}\n   preview: ${preview(item.sentText)}`);
  return [
    `${items.length} passage(s) found (previews only — the full text is held for the answer step):`,
    ...lines,
    '',
    'Do not quote from these previews; the answer step is given the full passage.'
  ].join('\n');
}

const locatorSuffix = (item: EvidenceItem): string => {
  const l = item.locator;
  if (!l) return '';
  if (l.page !== undefined) return `, p. ${l.page}`;
  if (l.heading) return `, "${l.heading}"`;
  if (l.line !== undefined) return `, line ${l.line}`;
  return '';
};

const locatorKey = (l: ChunkHit['locator']): string =>
  l.page !== undefined ? `page:${l.page}` : l.heading ? `heading:${l.heading}` : `line:${l.line}`;

const preview = (s: string): string => {
  const one = s.replace(/\s+/g, ' ').trim();
  return one.length > 180 ? `${one.slice(0, 180)}…` : one;
};
