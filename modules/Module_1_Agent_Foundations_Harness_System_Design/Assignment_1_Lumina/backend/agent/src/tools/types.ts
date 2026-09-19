/**
 * The Tool interface every tool implements, and the per-request context they run in.
 *
 * The shape encodes the error taxonomy (§9): `run` returns `{ ok: false, error }` for a
 * tool-level failure and THROWS ProviderError for a provider-level one. A tool must not
 * decide to keep the run alive by returning a cheerful empty result — that decision is
 * made by type, at the throw site, and the registry honours it.
 */
import type { AskMode, ToolName } from '@lumina/contract';
import type { EvidenceItem } from '../evidence/store.js';

/** Counters behind `searchCached` (§7.2). Fetches are not searches and never touch these. */
export type SearchAccounting = {
  searches: number;
  searchHits: number;
  /** Provider calls actually made. Cache hits cost nothing and must not be billed. */
  providerCalls: number;
};

export type ToolContext = {
  requestId: string;
  userId: string;
  threadId: string;
  /** The user's question. Snippet scoring and search-tool heuristics read it. */
  query: string;
  /** web | docs | auto (§5.4's router). Which retrieval tools get shown, not just used. */
  mode: AskMode;
  /** Set only when the request named a Space. `search_documents` has nothing to search without it. */
  spaceId?: string;
  /** Aborted on client disconnect: a closed tab must not keep paying a provider. */
  signal: AbortSignal;
  search: SearchAccounting;
  /** Embedding tokens spent by tools, for the embedding term of costUsd. */
  embeddingTokens: { total: number };
  /** How many memories this request has written. Bounded the same way searches are. */
  memory: MemoryAccounting;
};

/** Writes only. Recall is eager and happens exactly once, so it has nothing to count. */
export type MemoryAccounting = { saves: number };

export type ToolOk = {
  ok: true;
  /** What the MODEL sees. Keep it small — every byte is billed on every later turn. */
  observation: string;
  /** What the ANSWER may cite. Only fetch_page and search_documents produce this. */
  evidence?: EvidenceItem[];
  /** Why this step happened, for the trace. The trace is a debugging surface, not a bar. */
  reason?: string;
  /**
   * The hits behind `observation`, in the same order, for `web_search` only.
   *
   * The model reads `observation`; the LOOP reads this. It exists so Phase 1 can start
   * fetching the top hits speculatively while the model is still deciding which ones it
   * wants (`loop/retrieve.ts`, the speculative-fetch block) without re-parsing URLs back
   * out of rendered prose. Never sent to the model — it is the same data it already has.
   */
  hits?: { url: string; title: string }[];
};

export type ToolFail = {
  ok: false;
  /** Non-empty, always: the contract's superRefine rejects ok:false without it. */
  error: string;
  reason?: string;
};

export type ToolResult = ToolOk | ToolFail;

export interface Tool {
  readonly name: ToolName;
  /** What the model reads when deciding. This text is the tool's real interface. */
  readonly description: string;
  readonly inputSchema: Record<string, unknown>;
  /**
   * The loop calls this tool itself; the model is never shown it (`registry.forGear`).
   *
   * One tool is like this — `recall_memory`, which runs eagerly as step 1 of every request
   * (§5.4). Showing it as well would invite a second, redundant call that costs an
   * embedding, a cap slot and a round trip to fetch what is already in the prompt. It stays
   * a registry tool so it still gets the error taxonomy, the trace step and the cap slot.
   */
  readonly systemOnly?: boolean;
  run(input: Record<string, unknown>, ctx: ToolContext): Promise<ToolResult>;
}

export const newSearchAccounting = (): SearchAccounting => ({
  searches: 0,
  searchHits: 0,
  providerCalls: 0
});

export const newMemoryAccounting = (): MemoryAccounting => ({ saves: 0 });

/**
 * `searchCached` is true ONLY when every search in the request was a hit. A request with
 * zero searches is false, not true — the contract is explicit and it is the opposite of
 * what a naive `hits === misses` check returns.
 */
export const searchCachedFrom = (a: SearchAccounting): boolean =>
  a.searches > 0 && a.searches === a.searchHits;
