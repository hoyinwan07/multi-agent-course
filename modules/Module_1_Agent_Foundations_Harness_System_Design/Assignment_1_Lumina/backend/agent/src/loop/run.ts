/**
 * THE ORCHESTRATOR. Owns the clock, the money, and the reason the run stopped.
 *
 * Phase 1 retrieves → evidence is frozen and numbered → `sources` → Phase 2 writes.
 * Steps 4 and 5 fill in the middle and the end; today it runs Phase 1 and reports what
 * actually happened, which is what makes the trace verifiable on its own.
 */
import {
  newId,
  unresolvedCitations,
  type AskMode,
  type Depth,
  type DoneEvent,
  type Source,
  type Terminated
} from '@lumina/contract';
import { mergeEvidence, toSources, verifySubstrings } from '../evidence/merge.js';
import type { SseEmitter } from '../http/sse.js';
import { isProviderError } from '../lib/errors.js';
import { costUsd, emptySpend, type Spend } from '../obs/cost.js';
import { logFor } from '../obs/log.js';
import { getLlmProvider } from '../providers/llm.anthropic.js';
import type { LlmMessage } from '../providers/llm.js';
import { newMemoryAccounting, newSearchAccounting, searchCachedFrom, type ToolContext } from '../tools/types.js';
import { deadlineFrom, resolveGear } from './gear.js';
import { retrieve, type ToolCallRecord } from './retrieve.js';
import { synthesize } from './synthesize.js';

export type RunArgs = {
  requestId: string;
  userId: string;
  threadId: string;
  query: string;
  depth: Depth;
  /** web | docs | auto — the router (§5.4). Defaults applied by the contract, not here. */
  mode: AskMode;
  /** Set only when the request named a Space. */
  spaceId?: string;
  /**
   * Prior turns of this thread, already bounded and stripped by `loop/history.ts`.
   *
   * Loaded by the caller rather than here: the route has to look the thread up anyway to
   * answer 404 before a single byte of the stream is written, so the history read rides
   * along in the same round trip instead of adding one to the TTFT path.
   */
  history: LlmMessage[];
  sse: SseEmitter;
  /** Aborted when the client disconnects: a closed tab must not keep paying a provider. */
  signal: AbortSignal;
};

export type RunOutcome = {
  answerId: string;
  terminated: Terminated;
  toolCalls: ToolCallRecord[];
  spend: Spend;
  wallClockSec: number;
  depth: Depth;
  /** The answer as the client received it. Empty on a run that terminated with an error. */
  answerText: string;
  /** Persisted alongside the message, and what every `[n]` in it resolves to. */
  sources: Source[];
  /**
   * The `done` event exactly as it went out, or null when the run ended on `error` and
   * there was none. Returned rather than rebuilt by the caller so the figures the client
   * was told and the figures stored on the message are the same object, not two
   * calculations that can drift apart.
   */
  done: DoneEvent | null;
};

export async function run(args: RunArgs): Promise<RunOutcome> {
  const { requestId, userId, threadId, query, depth, mode, spaceId, history, sse, signal } = args;

  const startedAt = Date.now();
  const answerId = newId('ans');
  const gear = resolveGear(depth);
  const log = logFor(requestId, userId);
  const llm = getLlmProvider();
  const spend = emptySpend();

  const ctx: ToolContext = {
    requestId,
    userId,
    threadId,
    query,
    mode,
    ...(spaceId ? { spaceId } : {}),
    signal,
    search: newSearchAccounting(),
    embeddingTokens: { total: 0 },
    memory: newMemoryAccounting()
  };

  let terminated: Terminated = 'error';
  let answerText = '';
  let sources: Source[] = [];
  let done: DoneEvent | null = null;

  // Owned here and handed down, not collected from a return value. A provider failure
  // unwinds out of the phase that was running, and whatever it had already done is
  // exactly what the run log needs to show (§10.1).
  const toolCalls: ToolCallRecord[] = [];

  /**
   * Fold the provider counters `ctx` has been keeping into `spend`.
   *
   * Assignment, not accumulation, so it is safe to call more than once — and it has to be
   * called twice: once before `done` goes out, because the cost the client is told must
   * be the cost the run log records, and once in the `finally`, because a run that died
   * still paid for the searches it made on the way down. Doing it only in the `finally`
   * silently under-reported `done.costUsd` by one search call.
   */
  const settleProviderSpend = (): void => {
    spend.searchCalls = ctx.search.providerCalls;
    spend.embeddingTokens = ctx.embeddingTokens.total;
  };

  try {
    const phase1 = await retrieve({ query, history, gear, llm, ctx, sse, log, startedAt, toolCalls, spend });

    terminated = phase1.terminated;

    // ---- THE PHASE BOUNDARY ----
    // Evidence is frozen here. Everything after this point may cite [1]..[N] and nothing
    // else, and `sources` goes out BEFORE the first token so the UI can render citation
    // chips while the text is still arriving (§5.1).
    const merged = mergeEvidence([phase1.evidence]);
    const { sources: minted, cited, dropped } = toSources(merged, query);
    sources = minted;

    if (dropped.length) {
      log.warn({ dropped }, 'evidence dropped: no quotable passage');
    }

    // By construction this is always empty — selection only ever slices a segment of the
    // fetched text. If it ever fires, the guarantee is broken and the citations are not
    // safe, so it is loud rather than silent.
    const broken = verifySubstrings(cited);
    if (broken.length) log.error({ broken }, 'GROUNDING INVARIANT BROKEN');

    sse.emitSources(sources);

    // ---- PHASE 2 · SYNTHESIZE ----
    const phase2 = await synthesize({
      query,
      history,
      cited,
      terminated,
      memories: phase1.memories,
      // Read off the trajectory rather than threaded back from the tool, because the
      // trajectory is the record of what actually happened: `toolCalls` is appended in
      // place by the phase that ran, so this stays true even for a save that landed in a
      // turn the run later abandoned.
      savedMemory: toolCalls.some((c) => c.name === 'save_memory' && c.ok),
      llm,
      ctx,
      sse,
      log,
      deadline: deadlineFrom(startedAt, gear)
    });

    answerText = phase2.text;
    spend.tokensIn += phase2.usage.inputTokens;
    spend.tokensOut += phase2.usage.outputTokens;

    // The guard in citations.ts makes this impossible, so it is a check on the guard
    // rather than on the model. If it ever fires, the answer went out ungrounded.
    const unresolved = unresolvedCitations(answerText, sources);
    if (unresolved.length) {
      log.error({ unresolved }, 'CITATION GUARD LEAKED: an unresolvable [n] reached the client');
    }
    if (phase2.droppedCitations.length) {
      // Not an error — the guard did its job — but it means the prompt did not.
      log.warn({ dropped: phase2.droppedCitations }, 'guard stripped out-of-range citations');
    }

    // Before `done`, never after: this event carries the cost figure the bench scores and
    // the one the run log has to reconcile with.
    settleProviderSpend();

    done = {
      answerId,
      latencyMs: Date.now() - startedAt,
      // Measured server-side at the first `token` written to the wire. The fallback only
      // applies to an answer that streamed nothing at all.
      ttftMs: sse.ttftMs ?? Date.now() - startedAt,
      model: llm.model,
      tokens: { in: spend.tokensIn, out: spend.tokensOut },
      costUsd: costUsd(spend),
      searchCached: searchCachedFrom(ctx.search),
      terminated,
      depth: gear.depth,
      subQuestions: 0
    };
    sse.emitDone(done);
  } catch (e) {
    // A provider is down. The stream is already open, so the status code is settled —
    // this event is the report. No `done`, and never an answer written anyway (§9).
    terminated = 'error';
    const message = e instanceof Error ? e.message : String(e);
    log.error({ err: message, providerError: isProviderError(e) }, 'run terminated with a provider error');
    sse.emitError(502, message);
  } finally {
    // The error path never reached the call above, and a run that died halfway still paid
    // for the searches it made on the way down.
    settleProviderSpend();
  }

  const wallClockSec = (Date.now() - startedAt) / 1000;

  log.info(
    {
      answerId,
      toolCalls: toolCalls.length,
      terminated,
      tokens: spend.tokensIn + spend.tokensOut,
      costUsd: costUsd(spend),
      searchCached: searchCachedFrom(ctx.search),
      ttftMs: sse.ttftMs,
      latencyMs: Date.now() - startedAt,
      depth: gear.depth
    },
    'answer'
  );

  return { answerId, terminated, toolCalls, spend, wallClockSec, depth: gear.depth, answerText, sources, done };
}
