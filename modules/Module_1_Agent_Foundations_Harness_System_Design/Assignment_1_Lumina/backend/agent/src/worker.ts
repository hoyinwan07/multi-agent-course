/**
 * The jobs worker: a standalone process (`npm run worker`), deliberately never in-process
 * with `index.ts`. That is what the bench's decoupling check actually measures — a 60-page
 * PDF parsing on the same event loop that streams somebody's answer shows up as a failed
 * search p95, and running this as its own OS process is the simplest way to make that
 * impossible, not just unlikely.
 *
 * `index_document` is the only job kind LUMINA has (`ingest/index-document.ts` does the
 * work); deep search does not run here — it streams over the ask route's own SSE channel.
 *
 * Claim → work → flip status is atomic at the claim (`repo/jobs.ts`'s `findOneAndUpdate`)
 * and best-effort after that: a worker killed mid-job leaves its row `running` with a stale
 * `claimedAt`, and `sweepStaleJobs` below is what returns it to `pending` for the next
 * worker to pick up. Finished stages are not re-run — `ingest/index-document.ts` re-parses
 * from GridFS on a retry rather than resuming, which is fine at this scale.
 */
import { randomUUID } from 'node:crypto';
import pino from 'pino';
import { env } from './env.js';
import { claimNextJob, completeJob, failJob, sweepStaleJobs } from './repo/jobs.js';
import { updateDocumentProgress } from './repo/documents.js';
import { indexDocument } from './ingest/index-document.js';
import { errorMessage } from './lib/errors.js';

const log = pino({ level: env.logLevel });
const workerId = `wk_${randomUUID().slice(0, 8)}`;

/** Idle backoff between claim attempts when the queue is empty. */
const POLL_INTERVAL_MS = 1000;
/** A `running` job older than this with no update is presumed crashed. */
const STALE_AFTER_MS = 5 * 60_000;
/** How often to run the stale sweep, in poll ticks — every job does not need its own sweep. */
const SWEEP_EVERY_N_POLLS = 10;

let stopping = false;
process.on('SIGINT', () => (stopping = true));
process.on('SIGTERM', () => (stopping = true));

async function main(): Promise<void> {
  log.info({ workerId }, 'jobs worker up — polling for index_document jobs');
  let ticks = 0;

  while (!stopping) {
    if (ticks % SWEEP_EVERY_N_POLLS === 0) {
      const reclaimed = await sweepStaleJobs(STALE_AFTER_MS).catch((e: unknown) => {
        log.error({ err: errorMessage(e) }, 'stale-job sweep failed');
        return 0;
      });
      if (reclaimed) log.warn({ reclaimed }, 'reclaimed stale running job(s) back to pending');
    }
    ticks++;

    const job = await claimNextJob(workerId).catch((e: unknown) => {
      log.error({ err: errorMessage(e) }, 'claim failed');
      return null;
    });

    if (!job) {
      await sleep(POLL_INTERVAL_MS);
      continue;
    }

    const startedAt = Date.now();
    log.info({ jobId: job._id, kind: job.kind, attempts: job.attempts }, 'job claimed');
    try {
      if (job.kind === 'index_document') {
        await indexDocument(job);
      } else {
        // Exhaustive by the contract's JobKind enum today; a future kind lands here loud
        // rather than silently marked done.
        throw new Error(`unknown job kind: ${job.kind}`);
      }
      await completeJob(job._id);
      log.info({ jobId: job._id, ms: Date.now() - startedAt }, 'job done');
    } catch (e) {
      const message = errorMessage(e);
      log.error({ jobId: job._id, err: message, ms: Date.now() - startedAt }, 'job failed');
      await failJob(job._id, message);
      const docId = (job.payload as { docId?: string }).docId;
      if (docId) {
        await updateDocumentProgress(docId, { status: 'failed', error: message }).catch((e2: unknown) =>
          log.error({ jobId: job._id, err: errorMessage(e2) }, 'could not mark document failed')
        );
      }
    }
  }

  log.info({ workerId }, 'jobs worker shutting down');
  process.exit(0);
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

void main();
