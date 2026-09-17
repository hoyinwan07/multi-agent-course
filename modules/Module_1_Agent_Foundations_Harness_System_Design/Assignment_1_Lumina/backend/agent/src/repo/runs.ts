/**
 * The `runs` collection, and the only file allowed to touch it (the `repo/` rule,
 * TECHSPEC §3). No route, tool, or loop file imports the mongodb driver.
 *
 * `runs/<requestId>.json` on disk is what `quality/check.mjs` grades; this collection is
 * the same record somewhere a deployed instance can be queried from, which is what
 * `npm run export:runs` and `/stats` read. Same shape, two homes (§10.1).
 */
import { COLLECTIONS, type RunDoc } from '@lumina/contract';
import { db } from '../db.js';

/** Prefixed readable ids, never ObjectIds (§4.4) — a run's `_id` IS its requestId. */
type RunRow = RunDoc & { _id: string };

/**
 * Upsert rather than insert, keyed by `requestId`. A retried request overwrites its own
 * row instead of quietly producing two run logs for one answer, which `/stats` would then
 * count twice.
 */
export async function saveRun(doc: RunDoc): Promise<void> {
  const runs = (await db()).collection<RunRow>(COLLECTIONS.runs);
  // The replacement carries no `_id` — on an upsert Mongo takes it from the filter, and
  // the driver's types reject one in the body precisely because `_id` is immutable.
  await runs.replaceOne({ _id: doc.requestId }, doc, { upsert: true });
}
