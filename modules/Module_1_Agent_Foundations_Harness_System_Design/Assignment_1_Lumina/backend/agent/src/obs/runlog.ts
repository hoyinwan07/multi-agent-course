/**
 * The run log (TECHSPEC §10.1). Ten lines of adapter, and every gate reads it.
 *
 * Written TWICE — to `runs/<requestId>.json`, which `quality/check.mjs` grades, and to the
 * `runs` collection, which is how a deployed instance can be asked the same question. The
 * file is the authority: the gate never opens a database.
 *
 * Written in a `finally` on stream close, never before. A crash mid-stream must still
 * produce a log saying `terminated: "error"`, and a log written before the last byte is
 * a log with the wrong `wallClockSec`.
 *
 * Note `tokens` is a SINGLE TOTAL here, not the `{in, out}` split the `done` event
 * carries. Two shapes for the same quantity is an easy place to write the wrong one, so
 * the conversion happens here, once, out of `Spend`.
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { RunLog, type Depth, type RunDoc, type Terminated } from '@lumina/contract';
import { env } from '../env.js';
import type { ToolCallRecord } from '../loop/retrieve.js';
import { saveRun } from '../repo/runs.js';
import { costUsd, totalTokens, type Spend } from './cost.js';
import type { Log } from './log.js';

export type RunLogInput = {
  requestId: string;
  userId: string;
  threadId: string;
  answerId?: string;
  query: string;
  terminated: Terminated;
  depth: Depth;
  /** In the order they were called. The trajectory rules read this as a sequence. */
  toolCalls: ToolCallRecord[];
  spend: Spend;
  wallClockSec: number;
  log: Log;
};

export async function writeRunLog(input: RunLogInput): Promise<void> {
  const { requestId, userId, threadId, answerId, query, terminated, depth, toolCalls, spend, wallClockSec, log } =
    input;

  const runLog = {
    tokens: totalTokens(spend),
    wallClockSec: Math.round(wallClockSec * 1000) / 1000,
    costUsd: costUsd(spend),
    terminated,
    // Present from day one even though Week 1 only ever writes "quick". Without it nobody
    // can tell a legitimately expensive deep run from a quick run that ran away (§10.1).
    depth,
    toolCalls: toolCalls.map((t) => ({
      name: t.name,
      ok: t.ok,
      ms: t.ms,
      ...(t.error ? { error: t.error } : {})
    }))
  };

  // The contract enforces rule A1 here as well as at the trace: a failed call with no
  // error string is the Live Translate bug. `safeParse` rather than `parse` on purpose —
  // an invalid log must be SEEN, and the way it gets seen is by being written and failing
  // the gate loudly. Throwing here would delete the evidence instead.
  const parsed = RunLog.safeParse(runLog);
  if (!parsed.success) {
    log.error({ issues: parsed.error.issues }, 'run log does not satisfy the contract — writing it anyway');
  }

  // The file first: it is what the gate reads, and it must not depend on a database being
  // reachable. Mongo second, and its failure is reported but never propagated — losing an
  // observability row must not turn a good answer into a failed request.
  writeFile(requestId, runLog, log);

  const doc: RunDoc = {
    ...runLog,
    requestId,
    userId,
    threadId,
    ...(answerId ? { answerId } : {}),
    query,
    createdAt: new Date().toISOString()
  };

  try {
    await saveRun(doc);
  } catch (e) {
    log.error({ err: e instanceof Error ? e.message : String(e) }, 'run log written to disk but not to mongo');
  }
}

function writeFile(requestId: string, runLog: unknown, log: Log): void {
  try {
    mkdirSync(env.runsDir, { recursive: true });
    writeFileSync(join(env.runsDir, `${requestId}.json`), `${JSON.stringify(runLog, null, 2)}\n`, 'utf8');
  } catch (e) {
    // Nothing left to fall back to, so say so as loudly as a log line can.
    log.error({ err: e instanceof Error ? e.message : String(e), dir: env.runsDir }, 'FAILED TO WRITE THE RUN LOG');
  }
}
