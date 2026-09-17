/**
 * The `memories` collection, and the only file allowed to touch it (the `repo/` rule,
 * TECHSPEC §3).
 *
 * Two things here are load-bearing and neither is obvious from the query text.
 *
 * 1 · `userId` IS A FILTER INSIDE `$vectorSearch`, NEVER A `$match` AFTER IT. The stage
 *     returns `limit` nearest neighbours and then the pipeline continues; a `$match` on the
 *     far side of it discards whatever of those k belonged to somebody else, so a user
 *     whose neighbours happen to be another user's rows silently gets back fewer than k —
 *     or nothing. It reads as "recall is flaky" and it is not flaky, it is wrong.
 *     `memories_vector` declares `userId` as a filter field precisely so it can go inside.
 *
 * 2 · `listMemories` PROJECTS `embedding` AWAY. A memory row is ~1536 float64s ≈ 12 KB of
 *     wire for a panel that renders one sentence. Fetching fifty of them to display fifty
 *     sentences is 600 KB of Atlas egress per page view.
 *
 * The index is eventually consistent (TECHSPEC §12.3): a memory saved during a request is
 * not necessarily recallable microseconds later. That is fine in Week 1 because recall
 * happens at the START of a later request, which is seconds or minutes away.
 */
import { COLLECTIONS, SEARCH_INDEXES, type MemoryDoc } from '@lumina/contract';
import { db } from '../db.js';

type MemoryRow = MemoryDoc & { _id: string };

/** A recalled memory, minus the vector nobody downstream reads. */
export type RecalledMemory = {
  _id: string;
  text: string;
  sourceThread?: string;
  createdAt: string | Date;
  /** Atlas's cosine score, 0..1. Logged, never thresholded — see `tools/recall_memory.ts`. */
  score: number;
};

/** The list view's shape: everything `Memory` in the contract needs, and nothing else. */
export type ListedMemory = Omit<MemoryDoc, 'embedding'>;

const memories = async () => (await db()).collection<MemoryRow>(COLLECTIONS.memories);

/**
 * Upsert on the natural id, as everywhere else (§4.4). `save_memory` derives that id from
 * the memory's own content, so saving the same preference twice rewrites one row instead of
 * growing the user's memory by a duplicate every time they repeat themselves.
 */
export async function insertMemory(doc: MemoryDoc): Promise<void> {
  const rows = await memories();
  const { _id, ...body } = doc;
  await rows.replaceOne({ _id }, body as MemoryRow, { upsert: true });
}

/**
 * The k nearest memories of THIS user.
 *
 * `numCandidates` is the approximate-search working set: Atlas walks that many vectors
 * before ranking down to `limit`. The usual guidance is 10-20x, and with a per-user corpus
 * measured in tens of rows the whole thing is cheap either way.
 */
export async function recallMemories(userId: string, vector: number[], k: number): Promise<RecalledMemory[]> {
  const rows = await memories();
  return (await rows
    .aggregate([
      {
        $vectorSearch: {
          index: SEARCH_INDEXES.memoriesVector,
          path: 'embedding',
          queryVector: vector,
          // INSIDE the stage. See the header — this line is the whole point of the file.
          filter: { userId },
          numCandidates: Math.max(k * 15, 100),
          limit: k
        }
      },
      {
        // An inclusion projection rather than `{ embedding: 0 }`: a projection cannot mix
        // exclusions with a computed field, and `score` is a computed field.
        $project: {
          _id: 1,
          text: 1,
          sourceThread: 1,
          createdAt: 1,
          score: { $meta: 'vectorSearchScore' }
        }
      }
    ])
    .toArray()) as RecalledMemory[];
}

/** Newest first, for `GET /memory`. Matches the `{ userId: 1, createdAt: -1 }` index. */
export async function listMemories(userId: string, limit: number): Promise<ListedMemory[]> {
  const rows = await memories();
  return (await rows
    .find({ userId }, { projection: { embedding: 0 } })
    .sort({ createdAt: -1 })
    .limit(limit)
    .toArray()) as ListedMemory[];
}

/**
 * Delete one, scoped by `userId`. false means 404 — including when the row exists but
 * belongs to somebody else, which must be indistinguishable from "no such memory" for the
 * same reason threads answer 404 rather than 403.
 */
export async function deleteMemory(memoryId: string, userId: string): Promise<boolean> {
  const rows = await memories();
  const { deletedCount } = await rows.deleteOne({ _id: memoryId, userId });
  return deletedCount === 1;
}
