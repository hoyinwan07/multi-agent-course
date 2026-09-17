/**
 * Grounding pre-flight. Runs the REAL pipeline — eager search, fetch, select, number —
 * then checks each snippet the way `benchmark/bench.mjs` will: against a fresh fetch of
 * the URL, stripped with the bench's own regex, through the bench's own 12-token rule.
 *
 *   npx tsx src/dev/check-grounding.ts "how does hnsw indexing work" "what is rag"
 *
 * This exists because our extraction is not the grader's. Readability decodes entities,
 * the bench turns them into spaces; if that ever diverges enough to break a 12-token run,
 * this says so here rather than in a bench report at the end of the week.
 *
 * Costs one Tavily search + four page fetches per query. No LLM calls.
 */
import { mergeEvidence, toSources } from '../evidence/merge.js';
import type { EvidenceItem } from '../evidence/store.js';
import { snippetIsGrounded } from '../lib/normalize.js';
import { getSearchProvider } from '../providers/search.js';
import { fetchPage } from '../tools/fetch_page.js';
import { newMemoryAccounting, newSearchAccounting, type ToolContext } from '../tools/types.js';

/** Byte-identical to `stripHtml` in benchmark/bench.mjs:193. */
const stripHtml = (html: string): string =>
  html
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&[a-z#0-9]+;/gi, ' ');

async function benchHaystack(url: string): Promise<string | null> {
  try {
    const res = await fetch(url, {
      redirect: 'follow',
      headers: { 'user-agent': 'lumina-bench/0.1 (+course benchmark)' },
      signal: AbortSignal.timeout(12_000)
    });
    return res.ok ? stripHtml(await res.text()) : null;
  } catch {
    return null;
  }
}

const queries = process.argv.slice(2);
if (!queries.length) {
  console.error('usage: tsx src/dev/check-grounding.ts "<query>" ["<query>" ...]');
  process.exit(2);
}

let checked = 0;
let grounded = 0;
let unverifiable = 0;

for (const query of queries) {
  console.log(`\n══ ${query}`);

  const ctx: ToolContext = {
    requestId: 'preflight',
    userId: 'preflight',
    threadId: 'thr_preflight',
    query,
    signal: AbortSignal.timeout(60_000),
    search: newSearchAccounting(),
    embeddingTokens: { total: 0 },
    memory: newMemoryAccounting()
  };

  const hits = await getSearchProvider().search(query, { maxResults: 6, signal: ctx.signal });
  const evidence: EvidenceItem[] = [];

  for (const hit of hits.slice(0, 4)) {
    const r = await fetchPage.run({ url: hit.url }, ctx);
    if (r.ok && r.evidence) evidence.push(...r.evidence);
    else if (!r.ok) console.log(`   (skipped ${new URL(hit.url).hostname}: ${r.error.slice(0, 70)})`);
  }

  const { sources, dropped } = toSources(mergeEvidence([evidence]), query);
  for (const d of dropped) console.log(`   DROPPED ${d.title} — ${d.reason}`);

  for (const s of sources) {
    checked++;
    const hay = s.url ? await benchHaystack(s.url) : null;
    if (!hay) {
      unverifiable++;
      console.log(`   [${s.n}] ? ${s.title.slice(0, 52)} — publisher blocked the check`);
      continue;
    }
    const ok = snippetIsGrounded(s.snippet, hay);
    if (ok) grounded++;
    console.log(`   [${s.n}] ${ok ? 'OK  ' : 'FAIL'} ${s.title.slice(0, 52)}`);
    if (!ok) console.log(`        ${s.snippet.replace(/\s+/g, ' ').slice(0, 150)}`);
  }
}

// The bench excludes unverifiable citations from the ratio rather than failing them, so
// this mirrors that: a paywall teaches nobody anything.
const denom = checked - unverifiable;
const rate = denom ? grounded / denom : 0;
console.log(
  `\n── grounding ${grounded}/${denom} = ${(rate * 100).toFixed(1)}%  ` +
    `(${unverifiable} unverifiable)  gate: 95.0%  →  ${rate >= 0.95 ? 'PASS' : 'FAIL'}`
);
process.exit(rate >= 0.95 ? 0 : 1);
