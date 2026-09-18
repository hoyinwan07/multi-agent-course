/**
 * What `fetch_page` costs, per page, against the pages the bench actually reads.
 *
 * Run it after touching anything in `tools/fetch_page.ts`: the numbers that matter are the
 * wall clock per call (the parse budget is the ttft fix) and the captured token count
 * (which must not move — that is the grounding side of the same change).
 *
 *   npx tsx src/dev/try-fetch-latency.ts
 */
import { fetchPage } from '../tools/fetch_page.js';
import type { ToolContext } from '../tools/types.js';
import { newMemoryAccounting, newSearchAccounting } from '../tools/types.js';

const URLS = [
  'https://www.elastic.co/docs/reference/elasticsearch/rest-apis/reciprocal-rank-fusion',
  'https://www.mongodb.com/docs/atlas/atlas-vector-search/vector-search-overview/',
  'https://en.wikipedia.org/wiki/Okapi_BM25',
  'https://developer.mozilla.org/en-US/docs/Web/API/Server-sent_events/Using_server-sent_events',
  'https://ably.com/topic/server-sent-events',
  'https://www.ibm.com/think/topics/retrieval-augmented-generation',
  'https://www.freecodecamp.org/news/server-sent-events-vs-websockets/'
];

const ctx: ToolContext = {
  requestId: 'req_dev_fetch_latency',
  userId: 'dev',
  threadId: 'thr_dev',
  query: 'dev',
  mode: 'web',
  signal: new AbortController().signal,
  search: newSearchAccounting(),
  embeddingTokens: { total: 0 },
  memory: newMemoryAccounting()
};

for (const url of URLS) {
  const t0 = Date.now();
  const result = await fetchPage.run({ url }, ctx);
  const ms = Date.now() - t0;
  const host = new URL(url).hostname.padEnd(24);
  if (result.ok) {
    const chars = result.evidence?.[0]?.fullText.length ?? 0;
    console.log(`${host} ${String(ms).padStart(6)}ms  ok    ${String(chars).padStart(6)} chars  ${result.reason}`);
  } else {
    console.log(`${host} ${String(ms).padStart(6)}ms  FAIL  ${result.error}`);
  }
}
