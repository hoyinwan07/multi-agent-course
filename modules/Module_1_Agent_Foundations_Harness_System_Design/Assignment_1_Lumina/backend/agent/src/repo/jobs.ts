/**
 * The `jobs` collection, and the only file allowed to touch it (the `repo/` rule,
 * TECHSPEC §3).
 *
 * `claimNextJob` is the one atomic op the worker skeleton's comment calls out: the filter
 * `{status: 'pending'}` and the `$set` to `running` happen as a single `findOneAndUpdate`,
 * so two worker processes racing for the same row never both get it — Mongo serializes the
 * update, and only one of them sees a non-null result.
 *
 * `sweepStaleJobs` is what recovers from a worker that dies mid-job: a `running` row with a
 * `claimedAt` older than the stale threshold gets returned to `pending` (attempts already
 * incremented, so a job that keeps crashing keeps racking up attempts rather than looping
 * forever unnoticed — nothing here caps retries; that is a stretch, not a Must).
 */
import { COLLECTIONS, type JobDoc, type JobKind } from '@lumina/contract';
import { randomUUID } from 'node:crypto';
import { db } from '../db.js';

type JobRow = JobDoc & { _id: string };

const jobs = async () => (await db()).collection<JobRow>(COLLECTIONS.jobs);

export async function insertJob(kind: JobKind, userId: string, payload: Record<string, unknown>): Promise<string> {
  const rows = await jobs();
  const doc: JobDoc = {
    _id: `job_${randomUUID()}`,
    kind,
    status: 'pending',
    payload,
    userId,
    attempts: 0,
    createdAt: new Date().toISOString()
  };
  await rows.insertOne(doc as JobRow);
  return doc._id;
}

/** null when there is no pending work. Sorted oldest-first so jobs run roughly FIFO. */
export async function claimNextJob(workerId: string): Promise<JobDoc | null> {
  const rows = await jobs();
  const claimed = await rows.findOneAndUpdate(
    { status: 'pending' },
    { $set: { status: 'running', claimedAt: new Date(), workerId }, $inc: { attempts: 1 } },
    { sort: { createdAt: 1 }, returnDocument: 'after' }
  );
  return (claimed as JobDoc | null) ?? null;
}

export async function completeJob(jobId: string): Promise<void> {
  const rows = await jobs();
  await rows.updateOne({ _id: jobId }, { $set: { status: 'done' } });
}

export async function failJob(jobId: string, error: string): Promise<void> {
  const rows = await jobs();
  await rows.updateOne({ _id: jobId }, { $set: { status: 'failed', error } });
}

/**
 * Return any `running` job whose `claimedAt` is older than `staleMs` to `pending`, so a
 * worker that crashed mid-job does not strand it there forever. Returns how many it reset.
 */
export async function sweepStaleJobs(staleMs: number): Promise<number> {
  const rows = await jobs();
  const cutoff = new Date(Date.now() - staleMs);
  const { modifiedCount } = await rows.updateMany(
    { status: 'running', claimedAt: { $lt: cutoff } },
    { $set: { status: 'pending' }, $unset: { claimedAt: '', workerId: '' } }
  );
  return modifiedCount;
}
