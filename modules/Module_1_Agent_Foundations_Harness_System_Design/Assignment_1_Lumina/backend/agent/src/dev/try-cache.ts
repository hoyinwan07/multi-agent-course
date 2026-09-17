/**
 * Dev harness for the search cache (TECHSPEC §7). Not on any route.
 *
 *   npx tsx src/dev/try-cache.ts            inspect the key, the rows, and the TTL index
 *   npx tsx src/dev/try-cache.ts --purge    empty the collection (it is a CACHE — safe)
 *
 * What it is really checking is the three properties a live ask cannot show you: that the
 * stored `_id` is the key we think it is, that `expiresAt` is a Date the TTL monitor can
 * actually sweep, and that flipping the provider changes the key.
 */
import { COLLECTIONS, SearchCacheDoc } from '@lumina/contract';
import { searchCacheKey } from '../cache/searchCache.js';
import { db } from '../db.js';
import { env } from '../env.js';

const purge = process.argv.includes('--purge');

const rows = (await db()).collection(COLLECTIONS.searchCache);

if (purge) {
  const { deletedCount } = await rows.deleteMany({});
  console.log(`purged ${deletedCount} cache row(s)`);
  process.exit(0);
}

// ---- key properties, no database needed --------------------------------------------
const q = 'What is the Raft consensus algorithm?';
console.log('key derivation');
console.log(`  normalize+hash is stable      ${eq(searchCacheKey(q), searchCacheKey(q))}`);
console.log(`  case and punctuation ignored  ${eq(searchCacheKey(q), searchCacheKey(`  ${q.toUpperCase()}!! `))}`);
console.log(
  `  provider is part of the key   ${ne(searchCacheKey(q, 'tavily'), searchCacheKey(q, 'serpapi'))}`
);
console.log(`    tavily  ${searchCacheKey(q, 'tavily').slice(0, 32)}…`);
console.log(`    serpapi ${searchCacheKey(q, 'serpapi').slice(0, 32)}…`);

// ---- what is actually stored --------------------------------------------------------
const all = await rows.find({}).toArray();
console.log(`\nstored rows: ${all.length} (ttl ${env.searchCacheTtlSeconds}s)`);

for (const row of all.slice(0, 5)) {
  const r = row as unknown as SearchCacheDoc & { createdAt: Date; expiresAt: Date };
  const parsed = SearchCacheDoc.safeParse(r);
  const keyOk = r._id === searchCacheKey(r.query, r.provider);
  console.log(`  ${String(r.query).slice(0, 48)}`);
  console.log(
    `    _id matches key ${keyOk ? 'yes' : 'NO'} · ${r.results.length} hits · contract ${parsed.success ? 'ok' : 'FAILED'}`
  );
  console.log(
    `    expiresAt is a ${r.expiresAt?.constructor?.name} — ${
      r.expiresAt instanceof Date ? 'sweepable ✅' : 'A STRING: THE TTL WILL NEVER FIRE ✗'
    }`
  );
}

// ---- the index ----------------------------------------------------------------------
const ttl = (await rows.indexes()).find((i) => i.expireAfterSeconds !== undefined);
console.log(
  `\nTTL index: ${ttl ? `${ttl.name} on ${JSON.stringify(ttl.key)} expireAfterSeconds=${ttl.expireAfterSeconds}` : 'MISSING — run scripts/create-indexes.mjs'}`
);

process.exit(0);

function eq(a: string, b: string): string {
  return a === b ? 'yes ✅' : 'NO ✗';
}
function ne(a: string, b: string): string {
  return a !== b ? 'yes ✅' : 'NO ✗';
}
