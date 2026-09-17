/**
 * Tavily. The default provider (`SEARCH_PROVIDER=tavily`).
 *
 * Every failure path here throws ProviderError. None of them returns `[]`: an empty list
 * means "the web has nothing", and a 401 does not mean that.
 */
import { secrets } from '../env.js';
import { ProviderError, requireSecret } from '../lib/errors.js';
import type { SearchHit, SearchOptions } from './search.js';

const SEARCH_URL = 'https://api.tavily.com/search';
const EXTRACT_URL = 'https://api.tavily.com/extract';
const DEFAULT_TIMEOUT_MS = 8000;

type TavilyResult = {
  title?: string;
  url?: string;
  content?: string;
  score?: number;
  published_date?: string;
};

async function post(url: string, body: unknown, opts?: SearchOptions): Promise<unknown> {
  const key = requireSecret('tavily', secrets.tavily, 'TAVILY_API_KEY');
  let res: Response;
  try {
    res = await fetch(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${key}` },
      body: JSON.stringify(body),
      signal: opts?.signal ?? AbortSignal.timeout(DEFAULT_TIMEOUT_MS)
    });
  } catch (e) {
    // DNS, TLS, timeout, aborted socket. The provider is unreachable: that ends the run.
    throw new ProviderError('tavily', e instanceof Error ? e.message : String(e));
  }
  if (!res.ok) {
    const detail = (await res.text().catch(() => '')).slice(0, 300);
    throw new ProviderError('tavily', `${res.status} ${res.statusText} ${detail}`.trim(), res.status);
  }
  return res.json();
}

export async function tavilySearch(query: string, opts?: SearchOptions): Promise<SearchHit[]> {
  const json = (await post(
    SEARCH_URL,
    {
      query,
      max_results: opts?.maxResults ?? 6,
      // `basic` keeps the search inside the TTFT budget; `advanced` roughly doubles it.
      search_depth: 'basic',
      include_answer: false,
      include_raw_content: false
    },
    opts
  )) as { results?: TavilyResult[] };

  return (json.results ?? [])
    .filter((r): r is TavilyResult & { url: string } => typeof r.url === 'string' && r.url.length > 0)
    .map((r) => ({
      title: r.title?.trim() || r.url,
      url: r.url,
      snippet: r.content,
      score: r.score,
      publishedAt: r.published_date
    }));
}

/**
 * Tavily's own reader. Present because the interface offers it, but fetch_page does not
 * reach for it first — it returns markdown, and markdown link syntax injects tokens the
 * grader's HTML stripper never sees. See tools/fetch_page.ts.
 */
export async function tavilyExtract(url: string, opts?: SearchOptions): Promise<string> {
  const json = (await post(EXTRACT_URL, { urls: [url] }, opts)) as {
    results?: { url?: string; raw_content?: string }[];
    failed_results?: { url?: string; error?: string }[];
  };
  const hit = json.results?.[0];
  if (!hit?.raw_content) {
    const why = json.failed_results?.[0]?.error ?? 'no content returned';
    // A page Tavily could not read is a TOOL failure, not a provider outage — the caller
    // turns this into ok:false. It is thrown, not returned, so the caller cannot ignore it.
    throw new Error(`tavily extract failed for ${url}: ${why}`);
  }
  return hit.raw_content;
}
