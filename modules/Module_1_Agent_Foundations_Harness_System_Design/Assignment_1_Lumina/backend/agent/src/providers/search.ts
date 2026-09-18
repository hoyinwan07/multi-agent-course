/**
 * Search provider: the interface, and the env switch that makes it swappable.
 *
 * `SEARCH_PROVIDER=tavily|serpapi` must change the provider with no code change
 * (AGENTS.md). That is the whole reason this interface exists — and the reason the
 * provider name is part of the cache key, so flipping the env does not serve the other
 * provider's cached results (§7.1).
 */
import { env, secrets } from '../env.js';
import { ProviderError } from '../lib/errors.js';
import { tavilySearch, tavilyExtract } from './search.tavily.js';
import { serpapiSearch } from './search.serpapi.js';

/** One result from a search. It carries a URL and a teaser — it is NOT evidence. */
export type SearchHit = {
  title: string;
  url: string;
  /** The provider's teaser. Useful for ranking, never citable: §6.2. */
  snippet?: string;
  score?: number;
  publishedAt?: string;
};

export type SearchOptions = {
  maxResults?: number;
  signal?: AbortSignal;
};

export type SearchProviderName = 'tavily' | 'serpapi';

export interface SearchProvider {
  readonly name: SearchProviderName;
  /** Throws ProviderError on any upstream failure. Never returns a plausible empty list. */
  search(query: string, opts?: SearchOptions): Promise<SearchHit[]>;
  /**
   * Provider-native page extraction, where it exists. Optional on purpose: fetch_page
   * falls back to Readability, which is also the safer choice for grounding — see the
   * note in tools/fetch_page.ts.
   */
  extract?(url: string, opts?: SearchOptions): Promise<string>;
}

const providers: Record<SearchProviderName, SearchProvider> = {
  tavily: {
    name: 'tavily',
    search: (q, o) => tavilySearch(q, o),
    extract: (u, o) => tavilyExtract(u, o)
  },
  serpapi: {
    name: 'serpapi',
    search: (q, o) => serpapiSearch(q, o)
  }
};

export function getSearchProvider(): SearchProvider {
  const chosen = providers[env.searchProvider];
  if (!chosen) {
    throw new ProviderError('search', `unknown SEARCH_PROVIDER "${env.searchProvider}"`);
  }
  return chosen;
}

/** Whether the configured provider offers a page reader at all (serpapi does not). */
export function providerCanExtract(): boolean {
  return typeof getSearchProvider().extract === 'function';
}

/**
 * Read a page through the provider's own reader.
 *
 * The one caller is `fetch_page.ts`'s 403 fallback, and it is a `ProviderError` — not a
 * tool failure — when the configured provider has no reader: a run that asked for the
 * fallback on serpapi has hit a configuration gap, and returning "could not read it" would
 * dress that up as the page's fault.
 */
export async function extractViaProvider(url: string, opts?: SearchOptions): Promise<string> {
  const provider = getSearchProvider();
  if (!provider.extract) {
    throw new ProviderError('search', `${provider.name} has no page reader to fall back to`);
  }
  return provider.extract(url, opts);
}

/** What /health reports and what the cache key is salted with. */
export function searchProviderName(): SearchProviderName {
  return env.searchProvider;
}

/** True when the configured provider has a usable key. /health and startup read this. */
export function searchProviderConfigured(): boolean {
  return env.searchProvider === 'tavily' ? Boolean(secrets.tavily) : Boolean(secrets.serpapi);
}
