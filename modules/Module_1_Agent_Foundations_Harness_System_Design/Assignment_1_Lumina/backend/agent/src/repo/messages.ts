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
import { COLLECTIONS, type DoneEvent, type MessageDoc } from '@lumina/contract';
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

/**
 * `GET /stats` (§10.4). Aggregated straight from this collection rather than the empty
 * `requests` collection TECHSPEC's file tree names alongside `runs`: nothing in this
 * service ever writes a row there (checked — no `repo/requests.ts` exists and no other
 * file imports `COLLECTIONS.requests`), so it would only ever report zeros. Every message
 * row already carries `userId`, and an assistant row's `done` is exactly one answer's
 * `DoneEvent` — the same tokens/cost/ttft/searchCached figures the client was told — so
 * this collection alone is a complete, already-correct source for every field.
 *
 * A "request" is a user turn (persisted whether or not it produced an answer — see
 * `persistExchange` in `http/threads.routes.ts`); an "answer" is an assistant turn (only
 * ever persisted when one was actually delivered). No index backs `{userId, role,
 * createdAt}` — `scripts/` is on the do-not-edit list, and a collection scan over one
 * course's message volume is not worth deviating from "indexes live in scripts/" for.
 */
/**
 * The `DEEP_DAILY_CAP` spend gate (§5.5), checked BEFORE a deep run starts — this is the
 * one query on this collection that runs on the hot path of every deep `ask`, so it stays
 * a plain count rather than reusing `statsForUserSince`'s full `done`-array fetch.
 */
export async function countDeepAnswersToday(userId: string, since: Date): Promise<number> {
  const rows = await messages();
  return rows.countDocuments({
    userId,
    role: 'assistant',
    'done.depth': 'deep',
    createdAt: { $gte: since.toISOString() }
  });
}

export async function statsForUserSince(userId: string, since: Date): Promise<StatsAggregate> {
  const rows = await messages();
  const sinceIso = since.toISOString();

  const [requests, answered] = await Promise.all([
    rows.countDocuments({ userId, role: 'user', createdAt: { $gte: sinceIso } }),
    rows
      .find(
        { userId, role: 'assistant', createdAt: { $gte: sinceIso } },
        { projection: { done: 1 } }
      )
      .toArray() as Promise<Pick<MessageRow, 'done'>[]>
  ]);

  const dones = answered.map((a) => a.done).filter((d): d is DoneEvent => Boolean(d));

  return {
    requests,
    answers: answered.length,
    searchCacheHitRatePct: percentOf(dones, (d) => d.searchCached),
    ttftP95Ms: p95(dones.map((d) => d.ttftMs)),
    costUsdToday: round2(dones.reduce((sum, d) => sum + d.costUsd, 0)),
    deepToday: dones.filter((d) => d.depth === 'deep').length
  };
}

export type StatsAggregate = {
  requests: number;
  answers: number;
  searchCacheHitRatePct: number;
  ttftP95Ms: number;
  costUsdToday: number;
  deepToday: number;
};

const percentOf = <T,>(items: T[], pred: (item: T) => boolean): number =>
  items.length ? Math.round((items.filter(pred).length / items.length) * 1000) / 10 : 0;

const round2 = (n: number): number => Math.round(n * 100) / 100;

/** Nearest-rank p95, same method `benchmark/bench.mjs` scores the SLA with. */
function p95(values: number[]): number {
  if (!values.length) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const idx = Math.min(sorted.length - 1, Math.ceil(0.95 * sorted.length) - 1);
  return sorted[idx]!;
}
