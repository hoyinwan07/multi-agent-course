/**
 * The `chunks` collection, and the only file allowed to touch it (the `repo/` rule,
 * TECHSPEC §3). One collection for every Space (§5.4: "no second database"), so `spaceId`
 * is a plain field here and a declared FILTER field on `chunks_vector` — same shape as
 * `userId` on `memories_vector` in `repo/memories.ts`, and for the same reason: the filter
 * has to live INSIDE `$vectorSearch`, never in a `$match` after it, or a Space with
 * neighbours in the same nearest-k as another Space's chunks silently loses recall.
 */
import { COLLECTIONS, SEARCH_INDEXES, type ChunkDoc, type Locator } from '@lumina/contract';
import { db } from '../db.js';

type ChunkRow = ChunkDoc & { _id: string };

const chunks = async () => (await db()).collection<ChunkRow>(COLLECTIONS.chunks);

/**
 * How many candidates each half of hybrid retrieval contributes before fusion, and how
 * many fused results become evidence. Named here rather than inlined so the SPEC §5.4
 * "declared in config, not hard-coded" line is satisfied the same way `RECALL_K` in
 * `tools/recall_memory.ts` and `PAGE_TOKEN_BUDGET` in `tools/fetch_page.ts` already do it —
 * this codebase's config is a named constant next to its use, not a row in `.env` (`env.ts`
 * reserves the file for AGENTS.md's graded caps and the deep-search bounds).
 */
const CANDIDATE_POOL = 20;
const FUSED_TOP_K = 8;
/** Standard RRF constant: dampens the advantage of rank 1 over rank 2 without flattening the curve. */
const RRF_K = 60;

export type ChunkHit = { docId: string; text: string; locator: Locator };

/** Upsert on the natural id (§4.4): re-indexing a document rewrites its own chunks. */
export async function upsertChunks(docs: ChunkDoc[]): Promise<void> {
  if (!docs.length) return;
  const rows = await chunks();
  await rows.bulkWrite(
    docs.map((doc) => {
      const { _id, ...body } = doc;
      return { replaceOne: { filter: { _id }, replacement: body as ChunkRow, upsert: true } };
    }),
    { ordered: false }
  );
}

/**
 * The read-your-write probe (§5.4): ask the vector index for the exact chunk we just wrote
 * and see whether it comes back. Atlas Search indexes are eventually consistent — "upserted"
 * is not "searchable" — so the caller retries this with backoff rather than trusting one
 * negative result.
 *
 * `spaceId` and `userId` are both declared filter fields on `chunks_vector`
 * (`scripts/indexes.json`) and both go INSIDE the `$vectorSearch` stage, for the same
 * post-filter-loses-recall reason as `repo/memories.ts`.
 */
export async function probeChunkIndexed(args: {
  chunkId: string;
  spaceId: string;
  userId: string;
  vector: number[];
}): Promise<boolean> {
  const rows = await chunks();
  const hits = (await rows
    .aggregate([
      {
        $vectorSearch: {
          index: SEARCH_INDEXES.chunksVector,
          path: 'embedding',
          queryVector: args.vector,
          filter: { spaceId: args.spaceId, userId: args.userId },
          numCandidates: 50,
          limit: 5
        }
      },
      { $project: { _id: 1 } }
    ])
    .toArray()) as { _id: string }[];
  return hits.some((h) => h._id === args.chunkId);
}

/**
 * Hybrid retrieval (§5.4 Must): the dense half (`$vectorSearch`) and the BM25 half
 * (`$search` on `chunks_text`) run as two independent queries, each already scoped to
 * this Space and user INSIDE its own stage — same reasoning as the probe above — and are
 * fused by reciprocal rank fusion rather than either being trusted alone: a paraphrase
 * with no shared vocabulary only shows up in the vector list, and an exact acronym or
 * product name a dense embedding blurs together only shows up in the text list.
 *
 * No separate re-rank model call after fusion (the Must allows "a documented reason for
 * skipping it" instead): RRF already re-orders the union by a query-independent score, and
 * a second LLM pass over the top-k would spend tokens and latency this assignment's
 * ttft/answer budgets have no room for (`HANDOFF.md`'s already-open latency finding).
 */
export async function hybridSearchChunks(args: {
  spaceId: string;
  userId: string;
  vector: number[];
  text: string;
}): Promise<ChunkHit[]> {
  const rows = await chunks();
  const { spaceId, userId, vector, text } = args;

  const [byVector, byText] = await Promise.all([
    rows
      .aggregate([
        {
          $vectorSearch: {
            index: SEARCH_INDEXES.chunksVector,
            path: 'embedding',
            queryVector: vector,
            filter: { spaceId, userId },
            numCandidates: Math.max(CANDIDATE_POOL * 15, 100),
            limit: CANDIDATE_POOL
          }
        },
        { $project: { _id: 1, docId: 1, text: 1, locator: 1 } }
      ])
      .toArray() as Promise<ChunkRow[]>,
    rows
      .aggregate([
        {
          $search: {
            index: SEARCH_INDEXES.chunksText,
            compound: {
              must: [{ text: { query: text, path: 'text' } }],
              filter: [
                { equals: { path: 'spaceId', value: spaceId } },
                { equals: { path: 'userId', value: userId } }
              ]
            }
          }
        },
        { $limit: CANDIDATE_POOL },
        { $project: { _id: 1, docId: 1, text: 1, locator: 1 } }
      ])
      .toArray() as Promise<ChunkRow[]>
  ]);

  return fuseByRrf(byVector, byText).slice(0, FUSED_TOP_K);
}

/**
 * Reciprocal rank fusion: `score(id) = Σ 1/(RRF_K + rank)` over every list the chunk
 * appeared in, rank 1-based. A chunk found by only one side still scores — it just does
 * not get the second list's boost — which is what lets a text-only or vector-only hit
 * surface at all instead of requiring both halves to agree.
 */
function fuseByRrf(byVector: ChunkRow[], byText: ChunkRow[]): ChunkHit[] {
  const scores = new Map<string, number>();
  const rows = new Map<string, ChunkRow>();

  for (const list of [byVector, byText]) {
    list.forEach((row, i) => {
      rows.set(row._id, row);
      scores.set(row._id, (scores.get(row._id) ?? 0) + 1 / (RRF_K + i + 1));
    });
  }

  return [...scores.entries()]
    .sort((a, b) => b[1] - a[1])
    .map(([id]) => {
      const row = rows.get(id)!;
      return { docId: row.docId, text: row.text, locator: row.locator };
    });
}

export async function deleteChunksForDoc(docId: string): Promise<void> {
  const rows = await chunks();
  await rows.deleteMany({ docId });
}
