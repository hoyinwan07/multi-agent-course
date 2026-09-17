/**
 * PHASE 2 — SYNTHESIZE. One streaming call, tools off, and the first token on the clock.
 *
 * "Tools off" is structural rather than instructed: `LlmProvider.stream()` has no `tools`
 * parameter to pass (§5.1). By the time the first character of the answer is generated,
 * the citable universe is closed, numbered, and already on the wire as `sources`. There is
 * no code path by which this phase could retrieve something it then cites.
 *
 * Every character the model produces passes through `CitationFilter` before it reaches the
 * client, so an out-of-range `[n]` is impossible rather than unlikely (§6.5).
 *
 * Failure here is a provider failure: it throws, `run.ts` turns it into terminated:"error"
 * and an `error` event. What this function must never do is finish the sentence itself.
 */
import type { Terminated } from '@lumina/contract';
import type { CitedSource } from '../evidence/merge.js';
import type { SseEmitter } from '../http/sse.js';
import type { Log } from '../obs/log.js';
import { emptyUsage, type LlmMessage, type LlmProvider, type LlmUsage } from '../providers/llm.js';
import type { ToolContext } from '../tools/types.js';
import { CitationFilter } from './citations.js';
import { synthesizeSystemPrompt, synthesizeUserMessage } from './prompts.js';

/**
 * The system prompt asks for 150 words and caps at 200, which is roughly 300 tokens. This
 * is the ceiling behind that request: headroom enough that a well-behaved answer is never
 * cut off mid-sentence, low enough that a model which decides to write an essay cannot
 * blow the per-answer cost gate on output tokens alone.
 *
 * It is deliberately NOT tight enough to enforce the length — a hard stop lands mid-word,
 * and a truncated answer is worse than a long one. The prompt does the enforcing; this is
 * the bound on how badly the prompt can be ignored.
 */
const ANSWER_MAX_TOKENS = 500;

/**
 * A run that hit the retrieval cap still owes the client the honest partial answer the
 * contract promises for `terminated: "cap"` (§5.3). Aborting synthesis at a deadline that
 * has already passed would produce neither an answer nor a clean error, so synthesis gets
 * at least this long whatever Phase 1 spent. It is a floor, not an extension: on every run
 * that did not hit the cap, the remaining budget is far larger and this never applies.
 */
const SYNTH_FLOOR_MS = 15_000;

export type SynthesizeArgs = {
  query: string;
  /**
   * Prior turns of this thread, bounded and citation-stripped by `loop/history.ts`.
   *
   * Context for what the question refers to — never evidence. The stripping is what makes
   * that safe: an old `[2]` replayed verbatim is in range for this request, so the guard
   * would pass it through pointing at an unrelated page.
   */
  history: LlmMessage[];
  /** The frozen, numbered evidence. The only thing the answer may rest on. */
  cited: CitedSource[];
  /** How Phase 1 ended. `cap` makes the prompt ask for an explicitly partial answer. */
  terminated: Exclude<Terminated, 'error'>;
  /**
   * The recall block Phase 1 already saw, or null.
   *
   * This is the stage the memory requirement is actually about. Phase 1 retrieves; a
   * preference like "answer in British English, under 100 words" changes nothing it does.
   * The answer is written here, so this is where the preference has to be read — which is
   * also why a recall that never reached Phase 2 would pass every automated check (the
   * trace shows the step, the row is in `GET /memory`) and still not work.
   */
  memories: string | null;
  /** Whether the model saved something this turn. Changes the empty-retrieval wording. */
  savedMemory: boolean;
  llm: LlmProvider;
  ctx: ToolContext;
  sse: SseEmitter;
  log: Log;
  /** The run's wall-clock deadline, as an absolute instant. */
  deadline: number;
};

export type SynthesizeOutcome = {
  /** The answer exactly as the client received it, guard applied. */
  text: string;
  usage: LlmUsage;
  /** Out-of-range markers the guard removed. Empty when the prompt is doing its job. */
  droppedCitations: string[];
};

export async function synthesize(args: SynthesizeArgs): Promise<SynthesizeOutcome> {
  const { query, history, cited, terminated, memories, savedMemory, llm, ctx, sse, log, deadline } = args;

  const guard = new CitationFilter(cited.map((c) => c.source.n));
  const parts: string[] = [];
  let usage = emptyUsage();

  const budgetMs = Math.max(deadline - Date.now(), SYNTH_FLOOR_MS);
  const stream = llm.stream({
    system: synthesizeSystemPrompt(),
    messages: [
      ...history,
      { role: 'user', text: synthesizeUserMessage({ query, cited, terminated, memories, savedMemory }) }
    ],
    maxTokens: ANSWER_MAX_TOKENS,
    // The client hanging up and the run running out of clock are both reasons to stop
    // paying for tokens nobody will read.
    signal: AbortSignal.any([ctx.signal, AbortSignal.timeout(budgetMs)])
  });

  const startedAt = Date.now();

  for await (const chunk of stream) {
    if (chunk.type === 'end') {
      usage = chunk.usage;
      continue;
    }
    // Send only what the guard has cleared. It holds a few characters mid-answer while a
    // bracket closes and nothing at all before the first token, so this is free against
    // the TTFT budget.
    const safe = guard.push(chunk.text);
    if (safe) {
      parts.push(safe);
      sse.emitToken(safe);
    }
  }

  // The model stopped mid-bracket. Release what is held rather than silently eat it.
  const tail = guard.flush();
  if (tail) {
    parts.push(tail);
    sse.emitToken(tail);
  }

  const text = parts.join('');

  log.info(
    {
      synthesisMs: Date.now() - startedAt,
      ttftMs: sse.ttftMs,
      sources: cited.length,
      chars: text.length,
      tokensOut: usage.outputTokens
    },
    'phase 2 finished'
  );

  return { text, usage, droppedCitations: guard.dropped };
}
