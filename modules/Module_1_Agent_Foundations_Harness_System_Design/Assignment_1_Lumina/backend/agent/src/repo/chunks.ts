/**
 * The `chunks` collection, and the only file allowed to touch it (the `repo/` rule,
 * TECHSPEC §3). One collection for every Space (§5.4: "no second database"), so `spaceId`
 * is a plain field here and a declared FILTER field on `chunks_vector` — same shape as
 * `userId` on `memories_vector` in `repo/memories.ts`, and for the same reason: the filter
 * has to live INSIDE `$vectorSearch`, never in a `$match` after it, or a Space with
 * neighbours in the same nearest-k as another Space's chunks silently loses recall.
 */
import { COLLECTIONS, SEARCH_INDEXES, type ChunkDoc } from '@lumina/contract';
import { db } from '../db.js';

type ChunkRow = ChunkDoc & { _id: string };

const chunks = async () => (await db()).collection<ChunkRow>(COLLECTIONS.chunks);

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

export async function deleteChunksForDoc(docId: string): Promise<void> {
  const rows = await chunks();
  await rows.deleteMany({ docId });
}
