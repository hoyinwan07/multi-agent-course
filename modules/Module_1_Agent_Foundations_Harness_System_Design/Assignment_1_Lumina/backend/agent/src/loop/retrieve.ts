/**
 * PHASE 1 — RETRIEVE. A real `while` loop, not a framework's.
 *
 * Tools on, no prose kept. Produces the evidence set and nothing else; Phase 2 writes the
 * answer with tools switched off, which is what makes "grounded or nothing" structural
 * rather than a request in a prompt (§5.1).
 *
 * Termination here is only ever `done` or `cap`. A provider failure does not return — it
 * throws, and `run.ts` turns that into terminated:"error" and a 502 (§9).
 */
import type { SubQuestion, ToolName } from '@lumina/contract';
import type { EvidenceItem } from '../evidence/store.js';
import { EvidenceStore } from '../evidence/store.js';
import { errorMessage, isProviderError } from '../lib/errors.js';
import type { Spend } from '../obs/cost.js';
import type { Log } from '../obs/log.js';
import type { LlmMessage, LlmProvider } from '../providers/llm.js';
import * as registry from '../tools/registry.js';
import type { ToolContext, ToolResult } from '../tools/types.js';
import type { SseEmitter } from '../http/sse.js';
import { deadlineFrom, type Gear } from './gear.js';
import { openingUserMessage, retrieveSystemPrompt } from './prompts.js';

/** One assistant turn may ask for several pages. Run them together, but bounded. */
const MAX_PARALLEL = 4;

/**
 * Enough sources to answer from, so Phase 1 exits without spending another LLM turn
 * asking the model to confirm what the evidence already shows.
 *
 * The turn it removes cost a measured 1.5s of a 2500ms TTFT budget and ~2.7k input
 * tokens, and it almost always answered "DONE". The trade is real and belongs in
 * DESIGN.md: the model no longer gets to say "three pages, but none of them covers the
 * second half of the question, let me fetch one more". It applies once the STORE holds
 * this many items, regardless of whether some other call in the same turn failed — see
 * the exit check further down in `retrieve()` for why a failed `fetch_page` alongside
 * enough successful ones is not a reason to spend another turn.
 */
const MIN_EVIDENCE_TO_EXIT = 3;

/**
 * Deep search's per-sub-question floor (`loop/deep.ts`). A sub-question's tool-call
 * budget is a fair fraction of the SAME 24-call ceiling `expectations.json` holds the
 * whole run log to (recall reserves one call, the rest divides evenly) — at the wide end
 * of the plan (6 sub-questions) that leaves ~3-4 calls each, one of which is the eager
 * search. `MIN_EVIDENCE_TO_EXIT`'s 3 assumes quick's roomier 8-call budget; asking a
 * 3-4-call sub-question for the same three corroborating fetches before it can exit
 * cleanly guarantees it never does — it is a narrower, more focused question than the
 * one it was decomposed from, and two solid passages are a reasonable bar for it.
 */
const MIN_EVIDENCE_TO_EXIT_SUBQUESTION = 2;

/** What the run log records per call (`RunLog.toolCalls` in the contract). */
export type ToolCallRecord = { name: ToolName; ok: boolean; error?: string; ms: number };

export type RetrieveOutcome = {
  /** Never "error": that path throws. Encoded in the type so the taxonomy is visible. */
  terminated: 'done' | 'cap';
  evidence: EvidenceItem[];
  turns: number;
  /**
   * The rendered recall block, or null when this user has nothing stored.
   *
   * Returned rather than re-queried because Phase 2 needs it too and it is the phase that
   * actually matters: a preference like "answer in British English" changes the WRITING,
   * and Phase 1 does not write. Recalling twice would pay for the embedding twice to get
   * the same string.
   */
  memories: string | null;
  /** Deep search only: the plan. Undefined on a quick run. */
  subQuestions?: SubQuestion[];
};

export type RetrieveArgs = {
  query: string;
  /**
   * Prior turns of this thread, bounded and citation-stripped by `loop/history.ts`. Here
   * so a follow-up can be rewritten into search terms that stand on their own: the eager
   * search runs on the raw question, so "what does it cost?" is exactly the case where the
   * model's one allowed refinement earns its turn.
   */
  history: LlmMessage[];
  gear: Gear;
  llm: LlmProvider;
  ctx: ToolContext;
  sse: SseEmitter;
  log: Log;
  startedAt: number;
  /**
   * Owned by the CALLER and appended to in place, not returned.
   *
   * A provider failure leaves this function by `throw`, and a return value does not
   * survive a throw. Returning the trajectory would mean that the one run whose
   * trajectory matters most — the one that died — is the one that logs `toolCalls: []`.
   * Rule P1 asks for a failing trajectory somebody can read; this is what makes it
   * readable.
   */
  toolCalls: ToolCallRecord[];
  /** Same reasoning: tokens spent before a failure were still spent, and still billed. */
  spend: Spend;
  /**
   * Deep search only (`loop/deep.ts`): tags every trace step and evidence item THIS call
   * produces with which sub-question it served. Absent on a quick call, so every trace
   * step and source keeps `subQuestion` unset exactly as today.
   */
  subQuestion?: number;
  /**
   * Deep search only: skip this call's own eager `recall_memory` and use this value
   * instead. Recall happens ONCE per deep request, in `loop/deep.ts` — memory is a
   * request-level "how to write" concern, not something to re-look-up per sub-question,
   * and re-looking it up would pay for the embedding call once per sub-question for the
   * same string. `undefined` (the default) means "do the normal eager recall", so a
   * quick call that never sets this is unaffected; `null` is a legitimate value (recall
   * ran once, for this user, there was nothing).
   */
  presetMemories?: string | null;
};

export async function retrieve(args: RetrieveArgs): Promise<RetrieveOutcome> {
  const { query, history, gear, llm, ctx, sse, log, startedAt, toolCalls, spend, subQuestion, presetMemories } = args;
  const skipEagerRecall = presetMemories !== undefined;
  // Same signal, two meanings: a sub-question call skips its own recall (deep does it
  // once, up front) AND gets a lower evidence-to-exit bar (see the constant's comment) —
  // both follow from "this retrieve() call is one slice of a deep run", not two separate
  // flags to keep in sync.
  const minEvidenceToExit = subQuestion !== undefined ? MIN_EVIDENCE_TO_EXIT_SUBQUESTION : MIN_EVIDENCE_TO_EXIT;

  const store = new EvidenceStore();
  const deadline = deadlineFrom(startedAt, gear);

  let toolCallCount = 0;
  let turns = 0;

  // ---- THE EAGER CALLS ----
  //
  // All real registry calls — traced, counted against the cap, billed — they simply are
  // not model-chosen. Recall has to be in the prompt BEFORE the model reasons, and a
  // search is a thing we always want; paying an LLM round trip to be told to do either
  // costs a measured 1.8s of a TTFT budget that has none to spare (§5.4).
  //
  // WHICH SEARCHES is the router (§5.4): `mode: 'web'` searches the web only, `'docs'`
  // searches only a Space (and only if one was named — otherwise there is nothing to
  // search and the run proceeds on memory alone), and `'auto'` runs both when a Space IS
  // attached — a request that bothered to name a Space is treated as one where the Space
  // is presumptively relevant, and the model still gets a full evidence set to write from
  // either way. `'auto'` with no Space is exactly Week 1's web-only behaviour, unchanged.
  const wantWeb = ctx.mode !== 'docs';
  const wantDocs = Boolean(ctx.spaceId) && ctx.mode !== 'web';

  // RUN TOGETHER, REPORTED IN ORDER. Recall is an embedding call plus a vector query,
  // ~250ms; each search is roughly as expensive. Sequentially that is real TTFT added to
  // every request. Concurrently it is close to free, because they share no state and there
  // is nothing to serialize for. The trace steps are still emitted recall-then-searches, in
  // the fixed order below, which is the order a reader expects and the order the run
  // logically has.
  //
  // ALL COUNT AGAINST THE CAP. Not a philosophical position — `bench.mjs:673` scores the
  // quick envelope as `(a.trace ?? []).length > 8`, i.e. it counts TRACE STEPS, and every
  // eager call emits one. If one of these were exempt from `gear.maxToolCalls`, a run could
  // spend its full budget of tool calls and emit one more trace step than that, and the
  // gate would fail a run that had obeyed its own cap exactly. Counting it makes the
  // internal cap enforce the external check by construction.
  const eagerNames: ('web_search' | 'search_documents')[] = [
    ...(wantWeb ? (['web_search'] as const) : []),
    ...(wantDocs ? (['search_documents'] as const) : [])
  ];
  const [recalled, ...eagerResults] = await Promise.all([
    skipEagerRecall ? null : eagerRecall(query, ctx, gear, log),
    ...eagerNames.map((name) => timed(() => registry.run(name, { query }, ctx, gear)))
  ]);
  const eagerByName = new Map(eagerNames.map((name, i) => [name, eagerResults[i]!]));

  for (const [name, { result, ms }] of [
    // `recalled` is null exactly when this call skipped its own eager recall (deep,
    // sub-question calls) — no trace step for a lookup that never happened.
    ...(recalled ? ([['recall_memory', recalled]] as const) : []),
    ...eagerNames.map((name) => [name, eagerByName.get(name)!] as const)
  ]) {
    toolCallCount += 1;
    sse.emitTrace({
      step: sse.nextStep(),
      tool: name,
      input: { query },
      ok: result.ok,
      ms,
      ...(result.reason ? { reason: result.reason } : {}),
      ...(result.ok ? {} : { error: result.error }),
      ...(subQuestion !== undefined ? { subQuestion } : {})
    });
    toolCalls.push({ name, ok: result.ok, ms, ...(result.ok ? {} : { error: result.error }) });
    // A tool that produced evidence eagerly (search_documents) freezes it into the store
    // exactly like a model-called one does — there is no second copy of this logic.
    if (result.ok && result.evidence?.length) store.add(...tagSubQuestion(result.evidence, subQuestion));
  }

  // An empty observation means "this user has nothing stored", which is the normal case and
  // must not put an empty heading in front of every question.
  const memories = skipEagerRecall
    ? (presetMemories ?? null)
    : recalled?.result.ok && recalled.result.observation
      ? recalled.result.observation
      : null;
  const webResult = eagerByName.get('web_search');
  const docsResult = eagerByName.get('search_documents');

  const messages: LlmMessage[] = [
    ...history,
    {
      role: 'user',
      text: openingUserMessage({
        query,
        webSearch: webResult?.result.ok ? webResult.result.observation : null,
        docSearch: docsResult?.result.ok ? docsResult.result.observation : null,
        memories
      })
    }
  ];

  for (;;) {
    if (toolCallCount >= gear.maxToolCalls) {
      log.info({ toolCallCount, cap: gear.maxToolCalls }, 'phase 1 hit the tool-call cap');
      return { terminated: 'cap', evidence: store.all(), turns, memories };
    }
    if (Date.now() >= deadline) {
      log.info({ ms: Date.now() - startedAt }, 'phase 1 hit the wall clock');
      return { terminated: 'cap', evidence: store.all(), turns, memories };
    }

    turns += 1;
    const turnStart = Date.now();
    const reply = await llm.complete({
      system: retrieveSystemPrompt(gear, { wantWeb, wantDocs }),
      messages,
      tools: registry.forGear(gear, ctx),
      // The deadline is an abort, not just a check: a hung provider must not be able to
      // run past the cap while we wait politely for it.
      signal: AbortSignal.any([ctx.signal, AbortSignal.timeout(Math.max(1, deadline - Date.now()))])
    });
    spend.tokensIn += reply.usage.inputTokens;
    spend.tokensOut += reply.usage.outputTokens;
    // Per-turn LLM latency. Every turn sits inside the TTFT budget, so this is the
    // number that decides whether the three-turn shape is affordable at all.
    log.info(
      { turn: turns, llmMs: Date.now() - turnStart, asked: reply.toolCalls.length, tokensIn: reply.usage.inputTokens },
      'phase 1 turn'
    );

    if (reply.toolCalls.length === 0) {
      log.info({ turns, toolCallCount, evidence: store.size }, 'phase 1 finished on its own');
      return { terminated: 'done', evidence: store.all(), turns, memories };
    }

    // Hard cap, enforced inside the turn. A turn asking for four pages when one call of
    // budget remains runs one, not four — overshooting the cap fails bench.mjs just as
    // surely as ignoring it would.
    const remaining = gear.maxToolCalls - toolCallCount;
    const requested = reply.toolCalls.slice(0, remaining);
    const dropped = reply.toolCalls.length - requested.length;

    // `settled` is a PREFIX of `requested`: runBatch stops starting new chunks once a
    // provider is down, so iterate it, not `requested`, or the pairing goes out of step.
    const settled = await runBatch(requested, ctx, gear);
    toolCallCount += settled.length;

    // Emitted in the order the model ASKED for them, not the order they finished, so the
    // trace reads as a sequence. Costs a little live-ness; buys a debuggable surface.
    const results = [];
    for (let i = 0; i < settled.length; i++) {
      const call = requested[i];
      const outcome = settled[i];
      if (!call || !outcome) break;
      const name = call.name as ToolName;

      if (outcome.kind === 'threw') {
        // A provider is down. Show which step killed the run, then let it propagate.
        sse.emitTrace({
          step: sse.nextStep(),
          tool: name,
          input: call.input,
          ok: false,
          ms: outcome.ms,
          error: errorMessage(outcome.error),
          ...(subQuestion !== undefined ? { subQuestion } : {})
        });
        toolCalls.push({ name, ok: false, error: errorMessage(outcome.error), ms: outcome.ms });
        throw outcome.error;
      }

      const r = outcome.result;
      sse.emitTrace({
        step: sse.nextStep(),
        tool: name,
        input: call.input,
        ok: r.ok,
        ms: outcome.ms,
        ...(r.reason ? { reason: r.reason } : {}),
        ...(r.ok ? {} : { error: r.error }),
        ...(subQuestion !== undefined ? { subQuestion } : {})
      });
      toolCalls.push({ name, ok: r.ok, ms: outcome.ms, ...(r.ok ? {} : { error: r.error }) });

      if (r.ok && r.evidence?.length) store.add(...tagSubQuestion(r.evidence, subQuestion));

      results.push({
        toolCallId: call.id,
        // A failure goes back to the model AS an error. Silently substituting an empty
        // success is the Live Translate bug.
        content: r.ok ? r.observation : r.error,
        isError: !r.ok
      });
    }

    // Enough material to answer from: stop here rather than spend a turn being told DONE.
    // `done` is honest — the loop finished on its own terms, it just used a rule instead of
    // a round trip to decide.
    //
    // Checked BEFORE `dropped > 0` on purpose, and that ordering is itself a fix: this used
    // to run after the dropped-cap return, so a turn whose request got truncated at the cap
    // was ALWAYS `cap`, even when the calls that DID run already pushed `store.size` past
    // the threshold. A model that asks for one more page than the budget allows is not
    // evidence the page it already has is thin — it is just an ambitious ask. Checking
    // evidence first means "the model wanted more, but we already have enough" now reads as
    // `done` (honest — Phase 2 only ever reads `store`, so nothing is lost), and `cap` is
    // reserved for when the truncation actually cost us: not enough evidence AND no budget
    // left to get more.
    //
    // Originally gated on "and nothing failed in this turn" too, on the theory that a
    // failure meant the model might want to compensate by fetching an alternative URL. In
    // practice a `fetch_page` failure (403, paywall, JS-only page) is common and NOT
    // evidence of a thin result: it says nothing about whether the OTHER calls in the same
    // turn — the ones that succeeded and already pushed `store.size` over the threshold —
    // are enough to answer from. Requiring every call in the turn to succeed before
    // trusting evidence that already cleared the bar bought no quality: it just spent a
    // second full LLM turn (measured ~74% of Phase 1 latency) that, per the eval, was
    // costing quick runs the $0.05 budget and pushing them toward the 90s wall clock —
    // exactly the runs later timing out or capping out. Phase 2 only ever reads `store`,
    // never the raw tool-call outcomes, so a run that exits here loses nothing a
    // continuing turn would have given the answer.
    if (store.size >= minEvidenceToExit) {
      log.info({ turns, evidence: store.size, dropped }, 'phase 1 exited on the evidence threshold');
      return { terminated: 'done', evidence: store.all(), turns, memories };
    }

    if (dropped > 0) {
      log.info({ dropped, cap: gear.maxToolCalls }, 'phase 1 truncated a turn at the cap');
      return { terminated: 'cap', evidence: store.all(), turns, memories };
    }

    messages.push({ role: 'assistant', text: reply.text, toolCalls: reply.toolCalls });
    // Every result from one assistant turn in ONE message. Splitting them across messages
    // trains the model out of calling tools in parallel.
    messages.push({ role: 'tool', results });
  }
}

export type Timed = { result: ToolResult; ms: number };

/** Wall clock around one registry call, so concurrent calls each report their own. */
async function timed(fn: () => Promise<ToolResult>): Promise<Timed> {
  const t0 = Date.now();
  return { result: await fn(), ms: Date.now() - t0 };
}

/**
 * Stamp `subQuestion` onto evidence a call produced. A no-op (returns `items` itself) on
 * a quick call, where `subQuestion` is `undefined` — so `mergeEvidence`'s dedupe-by-`id`
 * still sees the exact same objects Week 1 produced, not new ones with an extra key.
 */
function tagSubQuestion(items: EvidenceItem[], subQuestion: number | undefined): EvidenceItem[] {
  if (subQuestion === undefined) return items;
  return items.map((item) => ({ ...item, subQuestion }));
}

/**
 * The eager recall, and THE ONE PLACE a provider failure is deliberately downgraded.
 *
 * Everywhere else in this service a ProviderError ends the run with a 502, and that is
 * right: `web_search` going down means the run has no way to find anything, so an answer
 * produced anyway would be an answer from the model's own head wearing a citation. Recall
 * is not that. The embedding API being down costs the reader their standing preferences;
 * it does not make the retrieved pages wrong or the citations unresolvable. Killing a
 * correct, grounded answer because a personalisation lookup timed out is the wrong trade.
 *
 * This is NOT the catch that AGENTS.md forbids, and the difference is the whole of rule
 * A1: nothing here returns a plausible success. The trace step carries `ok: false` and the
 * provider's real message, the run log records the failed call, and the answer is written
 * with no memory block rather than with a silently empty one. A reader of the trace can
 * tell "this user has nothing stored" from "the recall broke" — which is exactly what the
 * Live Translate precedent says they must be able to do.
 */
export async function eagerRecall(query: string, ctx: ToolContext, gear: Gear, log: Log): Promise<Timed> {
  const t0 = Date.now();
  try {
    return { result: await registry.run('recall_memory', { query }, ctx, gear), ms: Date.now() - t0 };
  } catch (e) {
    const error = errorMessage(e);
    log.error({ err: error, providerError: isProviderError(e) }, 'recall failed; answering without memory');
    return { result: { ok: false, error, reason: 'memory lookup failed' }, ms: Date.now() - t0 };
  }
}

type Settled =
  | { kind: 'ok'; result: Awaited<ReturnType<typeof registry.run>>; ms: number }
  | { kind: 'threw'; error: unknown; ms: number };

/**
 * Run one turn's tool calls with bounded concurrency. `allSettled` so one page's 403
 * cannot cancel the other three — but a ProviderError is preserved and rethrown by the
 * caller, because that one is not survivable.
 */
async function runBatch(
  calls: { id: string; name: string; input: Record<string, unknown> }[],
  ctx: ToolContext,
  gear: Gear
): Promise<Settled[]> {
  const out: Settled[] = [];
  for (let i = 0; i < calls.length; i += MAX_PARALLEL) {
    const chunk = calls.slice(i, i + MAX_PARALLEL);
    const settled = await Promise.all(
      chunk.map(async (c): Promise<Settled> => {
        const t0 = Date.now();
        try {
          return { kind: 'ok', result: await registry.run(c.name, c.input, ctx, gear), ms: Date.now() - t0 };
        } catch (e) {
          return { kind: 'threw', error: e, ms: Date.now() - t0 };
        }
      })
    );
    out.push(...settled);
    // A provider outage in this chunk means the run is over; do not start the next one.
    if (settled.some((s) => s.kind === 'threw' && isProviderError(s.error))) break;
  }
  return out;
}
