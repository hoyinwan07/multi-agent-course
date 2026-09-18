/**
 * Dev harness: call one tool directly, with no loop, no server and no browser.
 * This is the step-2 verification from TECHSPEC §14, and it stays useful afterwards —
 * it is the fastest way to find out whether a tool works before the loop can hide it.
 *
 *   npx tsx src/dev/try-tool.ts fetch_page '{"url":"https://example.com"}'
 *   npx tsx src/dev/try-tool.ts web_search '{"query":"mongodb atlas vector search"}'
 *   npx tsx src/dev/try-tool.ts search_documents '{"query":"..."}' spc_yourSpaceId
 *
 * Not wired into the server, not on any route.
 */
import { resolveGear } from '../loop/gear.js';
import * as registry from '../tools/registry.js';
import { isProviderError } from '../lib/errors.js';
import { newMemoryAccounting, newSearchAccounting, searchCachedFrom, type ToolContext } from '../tools/types.js';

const [name, rawInput = '{}', spaceId] = process.argv.slice(2);

if (!name) {
  console.error('usage: tsx src/dev/try-tool.ts <tool> \'<json input>\' [spaceId]');
  process.exit(2);
}

const ctx: ToolContext = {
  requestId: 'dev',
  userId: 'dev',
  threadId: 'thr_dev',
  query: typeof JSON.parse(rawInput).query === 'string' ? JSON.parse(rawInput).query : 'dev query',
  mode: 'auto',
  ...(spaceId ? { spaceId } : {}),
  signal: AbortSignal.timeout(30_000),
  search: newSearchAccounting(),
  embeddingTokens: { total: 0 },
  memory: newMemoryAccounting()
};

const gear = resolveGear('quick');
const started = Date.now();

try {
  const result = await registry.run(name, JSON.parse(rawInput), ctx, gear);
  const ms = Date.now() - started;

  console.log(`\n── ${name} · ${ms}ms · ok=${result.ok}`);
  if (!result.ok) {
    console.log(`error:  ${result.error}`);
  } else {
    console.log(`reason: ${result.reason ?? '(none)'}`);
    console.log(`\nobservation (what the model sees, ${result.observation.length} chars):`);
    console.log(result.observation);
    for (const ev of result.evidence ?? []) {
      console.log(`\nevidence: ${ev.id}`);
      console.log(`  title:    ${ev.title}`);
      console.log(`  fullText: ${ev.fullText.length} chars`);
      console.log(`  sentText: ${ev.sentText.length} chars, ${ev.segments.length} segment(s)`);
      // The guarantee snippet selection will depend on: every segment is a verbatim run
      // of the fetched text. If this ever prints false, grounding is broken at the root.
      const contiguous = ev.segments.every((s) => ev.fullText.includes(s));
      console.log(`  segments ⊆ fullText: ${contiguous}`);
      console.log(`  head:     ${ev.sentText.slice(0, 160).replace(/\s+/g, ' ')}…`);
    }
  }
  console.log(
    `\nsearch accounting: ${JSON.stringify(ctx.search)} → searchCached=${searchCachedFrom(ctx.search)}`
  );
} catch (e) {
  // A ProviderError reaching here is correct behaviour, not a bug in the harness: this is
  // what ends a real run as terminated:"error" with a 502.
  console.log(`\n── ${name} · THREW after ${Date.now() - started}ms`);
  console.log(`provider error: ${isProviderError(e)}`);
  console.log(String(e instanceof Error ? e.message : e));
  process.exit(1);
}
