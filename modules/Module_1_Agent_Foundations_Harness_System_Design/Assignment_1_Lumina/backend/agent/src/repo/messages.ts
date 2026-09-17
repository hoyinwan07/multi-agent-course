/**
 * The `messages` collection, and the only file allowed to touch it (the `repo/` rule,
 * TECHSPEC §3).
 *
 * Two readers with different budgets, one query shape: the loop wants the tail of the
 * thread to resolve a pronoun, and `GET /threads/:id` wants the transcript to render. Both
 * are "the last N in order", so both go through `recentMessages` and differ only in N.
 *
 * `createdAt` is stored as an ISO string rather than a BSON Date. There is no TTL monitor
 * on this collection to care (that constraint belongs to `searchCache`), the contract's
 * `ThreadMessage.createdAt` is `z.string().datetime()` so the route would have to convert
 * one back anyway, and a fixed-format UTC ISO string sorts lexicographically in exactly
 * chronological order.
 */
import { COLLECTIONS, type MessageDoc } from '@lumina/contract';
import { db } from '../db.js';

type MessageRow = MessageDoc & { _id: string };

const messages = async () => (await db()).collection<MessageRow>(COLLECTIONS.messages);

/**
 * Upsert each document on its natural id (§4.4, and the same rule `repo/runs.ts` follows):
 * the user turn is keyed on the requestId and the assistant turn on the answerId, so a
 * retried request rewrites its own pair instead of duplicating the exchange.
 */
export async function saveMessages(docs: MessageDoc[]): Promise<void> {
  if (!docs.length) return;
  const rows = await messages();
  await rows.bulkWrite(
    docs.map((doc) => {
      const { _id, ...body } = doc;
      return { replaceOne: { filter: { _id }, replacement: body as MessageRow, upsert: true } };
    }),
    { ordered: false }
  );
}

/**
 * The last `limit` messages of a thread, oldest first.
 *
 * Sorted descending in the query and reversed in memory on purpose: ascending + limit
 * would return the OLDEST N, which is the wrong end of a long thread. The sort matches the
 * `{ threadId: 1, createdAt: 1 }` index — Mongo walks an index backwards as happily as
 * forwards, so descending costs nothing.
 */
export async function recentMessages(threadId: string, limit: number): Promise<MessageDoc[]> {
  const rows = await messages();
  const found = (await rows
    .find({ threadId })
    .sort({ createdAt: -1 })
    .limit(limit)
    .toArray()) as MessageDoc[];
  return found.reverse();
}
