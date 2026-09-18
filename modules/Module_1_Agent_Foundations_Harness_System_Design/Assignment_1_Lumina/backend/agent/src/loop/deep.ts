/**
 * DEEP SEARCH (§5.5). One recall, one forced planning call, then a bounded-concurrency
 * fan-out of ordinary quick-shaped `retrieve()` calls — one per sub-question — merged
 * into a single evidence set for `run.ts` to number and synthesize from.
 *
 * The planning call is NOT folded into the normal turn loop `retrieve()` runs. It Must
 * happen exactly once, first, before any retrieval (`plan` ships before a single
 * `web_search`/`fetch_page`/`search_documents`), and a model that is merely offered
 * `plan_research` alongside every other tool and asked nicely to call it first is a
 * guarantee that lives in a system prompt, not in the code. So this file calls the LLM
 * directly with `tools: [planResearch]` and `toolChoice` forced, reads the decomposition
 * out of that one call, and only then lets the ordinary loop start. `plan_research.ts`'s
 * own `run()` is consequently never invoked — see its header for why that is by design.
 *
 * Tagging every trace step and source with its `subQuestion` (also a Must) is likewise
 * done by US, not the model: each sub-question gets its own `ToolContext` and a fixed
 * `subQuestion` index passed straight into `retrieve()`, which stamps it on everything
 * that call produces (`loop/retrieve.ts`'s `tagSubQuestion`). Nothing depends on the model
 * remembering to self-report which sub-question a fetch several turns later belongs to.
 */
import { PlanEvent, type SubQuestion } from '@lumina/contract';
import { env } from '../env.js';
import type { Log } from '../obs/log.js';
import type { Spend } from '../obs/cost.js';
import type { SseEmitter } from '../http/sse.js';
import type { LlmMessage, LlmProvider } from '../providers/llm.js';
import { planResearch } from '../tools/plan_research.js';
import { newSearchAccounting, type ToolContext } from '../tools/types.js';
import { deadlineFrom, type Gear } from './gear.js';
import { planSystemPrompt } from './prompts.js';
import { eagerRecall, retrieve, type RetrieveOutcome, type ToolCallRecord } from './retrieve.js';

/** "Should: bounded concurrency" (§5.5) — how many sub-questions research at once. */
const SUBQUESTION_CONCURRENCY = 3;

/** Reserves one call of the shared budget for the top-level recall (§ below). */
const RESERVED_FOR_RECALL = 1;

/** A sub-question gets at least this many calls even when the plan is large. */
const MIN_TOOL_CALLS_PER_SUBQUESTION = 3;

/**
 * `deep_plan_p95_ms` (4000ms — the plan's real first paint) is a generation-time budget,
 * not a network one: measured at 8-10s with no cap, because 6 verbose sub-questions and
 * reasons is genuinely that many output tokens. This is the lever — a smaller ceiling
 * forces conciseness (the prompt also asks for it directly) rather than relying on the
 * model to self-limit.
 */
const PLAN_MAX_TOKENS = 900;

export type DeepArgs = {
  query: string;
  history: LlmMessage[];
  gear: Gear;
  llm: LlmProvider;
  ctx: ToolContext;
  sse: SseEmitter;
  log: Log;
  startedAt: number;
  toolCalls: ToolCallRecord[];
  spend: Spend;
};

export async function runDeep(args: DeepArgs): Promise<RetrieveOutcome> {
  const { query, history, gear, llm, ctx, sse, log, startedAt, toolCalls, spend } = args;
  const deadline = deadlineFrom(startedAt, gear);

  // ---- RECALL, ONCE (§5.4's reasoning applies at the request level, not per sub-question) --
  const recalled = await eagerRecall(query, ctx, gear, log);
  sse.emitTrace({
    step: sse.nextStep(),
    tool: 'recall_memory',
    input: { query },
    ok: recalled.result.ok,
    ms: recalled.ms,
    ...(recalled.result.reason ? { reason: recalled.result.reason } : {}),
    ...(recalled.result.ok ? {} : { error: recalled.result.error })
  });
  toolCalls.push({
    name: 'recall_memory',
    ok: recalled.result.ok,
    ms: recalled.ms,
    ...(recalled.result.ok ? {} : { error: recalled.result.error })
  });
  const memories = recalled.result.ok && recalled.result.observation ? recalled.result.observation : null;

  // ---- PLAN, BEFORE ANY RETRIEVAL --------------------------------------------------------
  const planReply = await llm.complete({
    system: planSystemPrompt(env.deepSubQuestionsMin, env.deepSubQuestionsMax),
    messages: [...history, { role: 'user', text: `Question: ${query}` }],
    tools: [{ name: planResearch.name, description: planResearch.description, inputSchema: planResearch.inputSchema }],
    toolChoice: planResearch.name,
    maxTokens: PLAN_MAX_TOKENS,
    signal: AbortSignal.any([ctx.signal, AbortSignal.timeout(Math.max(1, deadline - Date.now()))])
  });
  spend.tokensIn += planReply.usage.inputTokens;
  spend.tokensOut += planReply.usage.outputTokens;

  if (planReply.stopReason === 'max_tokens') {
    // A tool call cut off mid-JSON is not a plan with too few sub-questions — it is no
    // plan at all. Named separately from the generic "no matching call" case below
    // because the fix is different: PLAN_MAX_TOKENS is too tight for what this model
    // wrote, not a model-compliance problem.
    throw new Error(`plan_research was truncated at PLAN_MAX_TOKENS (${PLAN_MAX_TOKENS}) before it finished`);
  }
  const planCall = planReply.toolCalls.find((c) => c.name === planResearch.name);
  if (!planCall) {
    // `toolChoice` forced exactly this tool. Reaching here means the provider ignored
    // that, which is not a shape this service can recover an honest plan from.
    throw new Error('plan_research was forced but the model returned no matching tool call');
  }
  const rawSubs = extractSubQuestions(planCall.input);
  const subQuestions: SubQuestion[] = rawSubs
    .map((raw, i): SubQuestion | null => {
      const s = raw as Record<string, unknown> | null | undefined;
      const question = typeof s?.question === 'string' ? s.question.trim() : '';
      if (!question) return null;
      const reason = typeof s?.reason === 'string' ? s.reason.trim() : '';
      return { i: i + 1, question, ...(reason ? { reason } : {}) };
    })
    .filter((s): s is SubQuestion => s !== null);

  // Checked against the real contract schema rather than trusted as-built: a plan the
  // gate would reject is a plan this service should not stream as if it were a good one.
  // `toolChoice` forcing the tool is a strong nudge, not a schema-enforced guarantee —
  // Anthropic's structured output does not itself enforce `minItems`/`maxItems` — so this
  // is a real, if rare, failure mode, not a defensive no-op.
  const parsedPlan = PlanEvent.safeParse({ subQuestions });
  if (!parsedPlan.success) {
    throw new Error(
      `plan_research returned ${subQuestions.length} usable sub-question(s), which the contract rejects: ` +
        parsedPlan.error.issues.map((i) => i.message).join('; ')
    );
  }
  const plan = parsedPlan.data;
  sse.emitPlan(plan);

  // ---- FAN OUT, BOUNDED CONCURRENCY ------------------------------------------------------
  //
  // Each sub-question's budget comes out of the SAME `gear.maxToolCalls` the run log is
  // graded against (`expectations.json`'s `budget.maxToolCalls: 24` applies to the whole
  // run, not per sub-question) — one call is reserved for the recall above, and the rest
  // is divided evenly, floored, so the sum can never exceed the shared cap by construction.
  const perSubMax = Math.max(
    MIN_TOOL_CALLS_PER_SUBQUESTION,
    Math.floor((gear.maxToolCalls - RESERVED_FOR_RECALL) / plan.subQuestions.length)
  );
  const subGear: Gear = { ...gear, maxToolCalls: perSubMax };

  const tasks = plan.subQuestions.map((sub) => async (): Promise<RetrieveOutcome> => {
    // Own search/embedding accounting per sub-question — each is budgeted like an
    // independent quick search (its own MAX_SEARCHES refinement allowance, its own
    // embedding total), folded into the shared `ctx` after it finishes. `memory` is the
    // ONE exception: passed by reference, unchanged, so `save_memory`'s per-request cap
    // (`MAX_SAVES` in tools/save_memory.ts) is enforced across the whole deep run, not
    // reset to a fresh allowance for every sub-question.
    const subCtx: ToolContext = {
      ...ctx,
      query: sub.question,
      search: newSearchAccounting(),
      embeddingTokens: { total: 0 }
    };

    const outcome = await retrieve({
      query: sub.question,
      history,
      gear: subGear,
      llm,
      ctx: subCtx,
      sse,
      log,
      startedAt,
      toolCalls,
      spend,
      subQuestion: sub.i,
      presetMemories: memories
    });

    ctx.search.searches += subCtx.search.searches;
    ctx.search.searchHits += subCtx.search.searchHits;
    ctx.search.providerCalls += subCtx.search.providerCalls;
    ctx.embeddingTokens.total += subCtx.embeddingTokens.total;

    return outcome;
  });

  const outcomes = await pool(tasks, SUBQUESTION_CONCURRENCY);

  // Honest about the whole: if even one sub-question's research was cut short, the
  // MERGED answer rests on incomplete evidence for at least part of the question, and
  // `terminated: 'cap'` is what tells synthesis to say so (`loop/prompts.ts`'s `partial`).
  const terminated = outcomes.some((o) => o.terminated === 'cap') ? 'cap' : 'done';

  return {
    terminated,
    evidence: outcomes.flatMap((o) => o.evidence),
    turns: outcomes.reduce((sum, o) => sum + o.turns, 0),
    memories,
    subQuestions: plan.subQuestions
  };
}

/**
 * The model does not reliably hand back `subQuestions` as a native array in the tool
 * input — observed, repeatedly, under a FORCED `tool_choice`: it serialises the whole
 * argument object to a JSON string and nests it one level deeper than the schema
 * describes, e.g. `{ subQuestions: '{"subQuestions":[...]}' }` instead of
 * `{ subQuestions: [...] }`. `input_schema` is a hint to the model, not something the API
 * validates the response against, so this is a real, reproducible quirk rather than a
 * defensive no-op — every shape below has been seen or is one JSON.parse away from one
 * that has.
 */
function extractSubQuestions(input: Record<string, unknown>): unknown[] {
  let value: unknown = input.subQuestions;
  if (typeof value === 'string') {
    try {
      value = JSON.parse(value);
    } catch {
      return [];
    }
  }
  if (Array.isArray(value)) return value;
  if (value && typeof value === 'object' && Array.isArray((value as { subQuestions?: unknown }).subQuestions)) {
    return (value as { subQuestions: unknown[] }).subQuestions;
  }
  return [];
}

/** Chunked concurrency, same shape as `retrieve.ts`'s own `runBatch`: simple, dependency-free. */
async function pool<T>(tasks: (() => Promise<T>)[], limit: number): Promise<T[]> {
  const out: T[] = [];
  for (let i = 0; i < tasks.length; i += limit) {
    const chunk = tasks.slice(i, i + limit);
    out.push(...(await Promise.all(chunk.map((t) => t()))));
  }
  return out;
}
