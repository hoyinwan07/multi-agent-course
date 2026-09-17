/**
 * The two-tier search cache (TECHSPEC §7). One key, two tiers, one policy.
 *
 *   tier 1  in-process LRU (bounded Map)      — hit: return, mark cached
 *   tier 2  searchCache collection, _id = key — hit: warm the LRU, return, mark cached
 *   miss    provider call → write both tiers  — return, mark NOT cached
 *
 * The key is `sha256(normalize(query) + '|' + provider)`, and `normalize()` is the SAME
 * function the grounding check uses (`lib/normalize.ts`). One normalizer, two callers: the
 * day a second one appears is the day a cache key stops matching something it should.
 *
 * The provider is IN the key. Flipping `SEARCH_PROVIDER` must not serve the other
 * provider's cached results — otherwise the env-swap test passes without the swap ever
 * reaching a provider, which is the same as not testing it.
 *
 * A cache is an optimisation, not a source of truth: if Mongo is unreachable, every path
 * here degrades to a provider call and says so in the log. It never degrades to a HIT —
 * reporting `searchCached: true` off a failed read would be a fabricated measurement.
 */
import { createHash } from 'node:crypto';
import { type SearchCacheDoc } from '@lumina/contract';
import { env } from '../env.js';
import { normalize } from '../lib/normalize.js';
import type { Log } from '../obs/log.js';
import {
  getSearchProvider,
  searchProviderName,
  type SearchHit,
  type SearchOptions,
  type SearchProviderName
} from '../providers/search.js';
import { readSearchCache, writeSearchCache } from '../repo/searchCache.js';

/**
 * Bounded on purpose. An unbounded Map on a long-lived process is a memory leak with a
 * friendly name, and 500 entries of six hits each is a few megabytes at most.
 */
const LRU_MAX = 500;

/**
 * Below this many hits, the result is not written to either tier.
 *
 * Measured, not guessed. A question that returns 6 results on one call came back with 1
 * on another, and caching that froze the bad response for the whole TTL: every later ask
 * of that question saw one link, decided the results were off-target, and spent a
 * refinement search — which costs the same as the search the cache "saved", plus an LLM
 * turn, plus a `searchCached: false`.
 *
 * A cache cannot tell a transient provider glitch from a genuinely thin corner of the
 * web, so it should not persist either one. The cost of being wrong here is one search
 * call on the next ask; the cost of being wrong the other way is hours of worse answers.
 */
const MIN_CACHEABLE_HITS = 2;

type Entry = { hits: SearchHit[]; expiresAtMs: number };

/** Insertion-ordered, so the oldest key is simply the first one. */
const lru = new Map<string, Entry>();

export function searchCacheKey(query: string, provider: SearchProviderName = searchProviderName()): string {
  return createHash('sha256').update(`${normalize(query)}|${provider}`).digest('hex');
}

export type CachedSearch = {
  hits: SearchHit[];
  /** True only when the results came out of a tier. The caller bills on this. */
  cached: boolean;
};

export async function cachedSearch(query: string, opts: SearchOptions, log: Log): Promise<CachedSearch> {
  const provider = searchProviderName();
  const key = searchCacheKey(query, provider);
  const now = Date.now();

  // ---- tier 1: in-process ----
  const local = lru.get(key);
  if (local) {
    if (local.expiresAtMs > now) {
      touch(key, local);
      return { hits: local.hits, cached: true };
    }
    lru.delete(key);
  }

  // ---- tier 2: mongo ----
  try {
    const row = await readSearchCache(key);
    // Mongo's TTL monitor runs about once a minute, so an expired row can still be read
    // for up to a minute after it expires. The read path checks rather than trusting the
    // sweeper (§7.3) — otherwise the cache serves results it has already promised to
    // forget, and does it for exactly as long as nobody is watching.
    const expiresAtMs = row ? asMs(row.expiresAt) : 0;
    if (row && expiresAtMs > now) {
      const hits = row.results as unknown as SearchHit[];
      put(key, hits, expiresAtMs);
      return { hits, cached: true };
    }
  } catch (e) {
    log.warn({ err: message(e), key }, 'search cache read failed — treating it as a miss');
  }

  // ---- miss: pay the provider ----
  // Not wrapped: a search provider that is down is a PROVIDER failure and ends the run
  // (§9). Falling back to a stale cache entry here would be the Live Translate bug with a
  // cache in front of it.
  const hits = await getSearchProvider().search(query, opts);

  if (hits.length < MIN_CACHEABLE_HITS) {
    log.info({ hits: hits.length, query }, 'search result too thin to cache — not storing it');
    return { hits, cached: false };
  }

  const expiresAt = new Date(now + env.searchCacheTtlSeconds * 1000);
  put(key, hits, expiresAt.getTime());

  const doc: SearchCacheDoc = {
    _id: key,
    provider,
    query,
    results: hits as unknown as Record<string, unknown>[],
    expiresAt,
    createdAt: new Date(now)
  };

  try {
    await writeSearchCache(doc);
  } catch (e) {
    // The in-process tier still has it, so this request's neighbours still benefit.
    log.warn({ err: message(e), key }, 'search cache write failed — tier 1 only');
  }

  return { hits, cached: false };
}

/** Test seam: the LRU outlives a request, so a test that wants a cold tier 1 can say so. */
export function clearLocalSearchCache(): void {
  lru.clear();
}

function touch(key: string, entry: Entry): void {
  lru.delete(key);
  lru.set(key, entry);
}

function put(key: string, hits: SearchHit[], expiresAtMs: number): void {
  lru.delete(key);
  lru.set(key, { hits, expiresAtMs });
  while (lru.size > LRU_MAX) {
    const oldest = lru.keys().next().value;
    if (oldest === undefined) break;
    lru.delete(oldest);
  }
}

/** `expiresAt` is a Date in Mongo but the contract permits an ISO string. Accept both. */
const asMs = (v: string | Date): number => (v instanceof Date ? v.getTime() : new Date(v).getTime());

const message = (e: unknown): string => (e instanceof Error ? e.message : String(e));
