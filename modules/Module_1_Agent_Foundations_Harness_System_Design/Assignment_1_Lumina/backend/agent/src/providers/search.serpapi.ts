/**
 * SerpApi. The swap target: `SEARCH_PROVIDER=serpapi` and nothing else changes.
 *
 * SerpApi has no reader endpoint, so `extract` is absent from this provider and
 * fetch_page uses Readability. That is the fallback path AGENTS.md names, and it is the
 * path this build uses for both providers anyway.
 */
import { secrets } from '../env.js';
import { ProviderError, requireSecret } from '../lib/errors.js';
import type { SearchHit, SearchOptions } from './search.js';

const BASE = 'https://serpapi.com/search.json';
const DEFAULT_TIMEOUT_MS = 8000;

type OrganicResult = { title?: string; link?: string; snippet?: string; date?: string };

export async function serpapiSearch(query: string, opts?: SearchOptions): Promise<SearchHit[]> {
  const key = requireSecret('serpapi', secrets.serpapi, 'SERPAPI_API_KEY');
  const url = new URL(BASE);
  url.searchParams.set('engine', 'google');
  url.searchParams.set('q', query);
  url.searchParams.set('num', String(opts?.maxResults ?? 6));
  url.searchParams.set('api_key', key);

  let res: Response;
  try {
    res = await fetch(url, { signal: opts?.signal ?? AbortSignal.timeout(DEFAULT_TIMEOUT_MS) });
  } catch (e) {
    throw new ProviderError('serpapi', e instanceof Error ? e.message : String(e));
  }
  if (!res.ok) {
    const detail = (await res.text().catch(() => '')).slice(0, 300);
    throw new ProviderError('serpapi', `${res.status} ${res.statusText} ${detail}`.trim(), res.status);
  }

  const json = (await res.json()) as { organic_results?: OrganicResult[]; error?: string };
  // SerpApi reports plan and query errors as 200 + {error}. A 200 is not a success here.
  if (json.error) throw new ProviderError('serpapi', json.error);

  return (json.organic_results ?? [])
    .filter((r): r is OrganicResult & { link: string } => typeof r.link === 'string' && r.link.length > 0)
    .map((r, i) => ({
      title: r.title?.trim() || r.link,
      url: r.link,
      snippet: r.snippet,
      // SerpApi returns rank, not a score. Synthesize a descending one so ranking is
      // comparable across providers without the caller knowing which one ran.
      score: 1 - i / 100,
      publishedAt: r.date
    }));
}
