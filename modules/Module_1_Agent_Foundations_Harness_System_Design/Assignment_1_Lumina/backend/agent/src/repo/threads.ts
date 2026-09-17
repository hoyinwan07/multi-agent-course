/**
 * The `threads` collection, and the only file allowed to touch it (the `repo/` rule,
 * TECHSPEC §3).
 *
 * A thread's `_id` IS its `thr_…` string (§4.4) — no second id field, no ObjectId. Every
 * read is filtered by `userId` as well as by id: a thread belonging to somebody else must
 * read as "no such thread", not as "yours, but forbidden". 404 rather than 403 is also
 * what the contract asks for, and it is the only answer that does not leak which ids exist.
 */
import { COLLECTIONS, type ThreadDoc } from '@lumina/contract';
import { db } from '../db.js';

type ThreadRow = ThreadDoc & { _id: string };

const threads = async () => (await db()).collection<ThreadRow>(COLLECTIONS.threads);

export async function insertThread(doc: ThreadDoc): Promise<void> {
  const rows = await threads();
  // `_id` in the filter, never in the replacement body — it is immutable and the driver's
  // types reject it there. Upsert keyed on the natural id, so a retried create is a no-op
  // rather than a second thread (§4.4).
  const { _id, ...body } = doc;
  await rows.replaceOne({ _id }, body as ThreadRow, { upsert: true });
}

/** null means 404. Not "null means empty": the caller must not invent the thread. */
export async function findThread(threadId: string, userId: string): Promise<ThreadDoc | null> {
  const rows = await threads();
  return (await rows.findOne({ _id: threadId, userId })) as ThreadDoc | null;
}

export async function listThreads(userId: string, limit: number): Promise<ThreadDoc[]> {
  const rows = await threads();
  // Matches the `{ userId: 1, createdAt: -1 }` index in scripts/indexes.json exactly, so
  // the sidebar query is an index scan rather than a collection scan per keystroke.
  return (await rows.find({ userId }).sort({ createdAt: -1 }).limit(limit).toArray()) as ThreadDoc[];
}

/**
 * Name an untitled thread after its first question.
 *
 * `title: ''` in the filter is what makes this safe under concurrency: it matches only a
 * thread nobody has titled yet, so of four asks racing down one thread exactly one write
 * lands and a title the user set at creation is never overwritten. An empty string is the
 * "not yet titled" marker rather than a sentinel like "New thread", because a sentinel a
 * user could plausibly type is a sentinel that eventually gets clobbered.
 */
export async function titleThreadIfUntitled(threadId: string, userId: string, title: string): Promise<void> {
  const rows = await threads();
  await rows.updateOne({ _id: threadId, userId, title: '' }, { $set: { title } });
}
