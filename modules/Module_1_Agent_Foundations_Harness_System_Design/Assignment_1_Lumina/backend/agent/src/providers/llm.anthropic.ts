/**
 * Anthropic adapter. The ONLY file that knows what a `tool_use` block looks like.
 *
 * Two model settings are deliberate and both are about the latency budget in
 * `benchmark/sla.json` (`ttft_p95_ms`), which has to cover a search, three or four page
 * fetches AND the first token:
 *
 *   thinking: disabled   Sonnet 5 accepts it (adaptive is its only on-mode, and adaptive
 *                        spends seconds before the first visible token). Phase 1 picks
 *                        tools from a fixed menu and Phase 2 writes from evidence that is
 *                        already chosen and numbered — neither is a reasoning problem.
 *   effort: low          Fewer, more consolidated tool calls and less preamble, which is
 *                        exactly the three-turn shape §5.2 asks for.
 *
 * Both are per-request overrides so they can be raised when measuring, which is the only
 * honest way to decide whether they cost accuracy.
 */
import Anthropic from '@anthropic-ai/sdk';
import { env, secrets } from '../env.js';
import { ProviderError, requireSecret } from '../lib/errors.js';
import {
  addUsage,
  emptyUsage,
  type LlmCompleteRequest,
  type LlmMessage,
  type LlmProvider,
  type LlmReply,
  type LlmRequest,
  type LlmStreamChunk,
  type LlmToolDef,
  type LlmUsage,
  type ToolCall
} from './llm.js';

type Effort = 'low' | 'medium' | 'high' | 'xhigh' | 'max';

let client: Anthropic | null = null;

function anthropic(): Anthropic {
  if (!client) {
    client = new Anthropic({
      apiKey: requireSecret('anthropic', secrets.anthropic, 'ANTHROPIC_API_KEY'),
      maxRetries: 1 // one retry fits the budget; a second turns a blip into a timeout
    });
  }
  return client;
}

/** Every SDK throw becomes a ProviderError, which ends the run with terminated:"error". */
function asProviderError(e: unknown): ProviderError {
  if (e instanceof Anthropic.APIError) return new ProviderError('anthropic', e.message, e.status);
  return new ProviderError('anthropic', e instanceof Error ? e.message : String(e));
}

function toSdkTools(tools: LlmToolDef[]): Anthropic.Tool[] {
  return tools.map((t) => ({
    name: t.name,
    description: t.description,
    input_schema: t.inputSchema as Anthropic.Tool.InputSchema
  }));
}

function toSdkMessages(messages: LlmMessage[]): Anthropic.MessageParam[] {
  return messages.map((m) => {
    if (m.role === 'user') return { role: 'user', content: m.text };

    if (m.role === 'tool') {
      // All results from one assistant turn in ONE user message. Splitting them is how
      // you silently train the model to stop calling tools in parallel.
      return {
        role: 'user',
        content: m.results.map((r) => ({
          type: 'tool_result' as const,
          tool_use_id: r.toolCallId,
          content: r.content,
          is_error: r.isError
        }))
      };
    }

    const blocks: Anthropic.ContentBlockParam[] = [];
    // An empty text block is rejected, and Phase 1 assistant turns are usually text-free.
    if (m.text.trim()) blocks.push({ type: 'text', text: m.text });
    for (const c of m.toolCalls) {
      blocks.push({ type: 'tool_use', id: c.id, name: c.name, input: c.input });
    }
    return { role: 'assistant', content: blocks };
  });
}

/**
 * The system prompt and the tool list are byte-identical across every request, so they
 * are the cacheable prefix. Evidence never is — it is different every time — which is
 * why Phase 2's page text sits in `messages`, after the breakpoint.
 */
function toSdkSystem(system: string): Anthropic.TextBlockParam[] {
  return [{ type: 'text', text: system, cache_control: { type: 'ephemeral' } }];
}

const usageOf = (u: Anthropic.Usage): LlmUsage => ({
  // Cache reads and writes are still input tokens and still cost money. Counting only
  // `input_tokens` would under-report the bill the moment caching starts working.
  inputTokens:
    (u.input_tokens ?? 0) + (u.cache_read_input_tokens ?? 0) + (u.cache_creation_input_tokens ?? 0),
  outputTokens: u.output_tokens ?? 0
});

/**
 * Whether this model accepts `output_config.effort` and an explicit `thinking` block.
 *
 * Haiku 4.5 accepts NEITHER: `output_config.effort` is rejected outright, and its only
 * thinking mode is `{type:'enabled', budget_tokens:N}` — omitting the field is how you get
 * a non-thinking turn, which is exactly what Phase 1 wants. Sending the Sonnet shape at it
 * is a 400, not a degraded answer, so this is a correctness check and not a tuning knob.
 *
 * Written as "which models take the Sonnet/Opus shape" rather than a Haiku denylist so a
 * future `claude-haiku-*` inherits the right behaviour without another edit here.
 */
const takesEffortAndThinking = (model: string): boolean => !/^claude-haiku-/.test(model);

export class AnthropicProvider implements LlmProvider {
  readonly model: string;
  private readonly effort: Effort;

  constructor(model = env.llmModel, effort: Effort = 'low') {
    this.model = model;
    this.effort = effort;
  }

  /**
   * The per-model half of a request. Spread into both `complete` and `stream` so the two
   * paths cannot drift — a shape that 400s on one and not the other is the bug this
   * prevents.
   */
  private tuning(): Record<string, unknown> {
    return takesEffortAndThinking(this.model)
      ? { thinking: { type: 'disabled' }, output_config: { effort: this.effort } }
      : // Haiku 4.5: `effort` is a 400 ("This model does not support the effort
        // parameter" — probed against the live API, not assumed), `thinking: disabled` is
        // accepted, and `temperature` IS allowed.
        //
        // `temperature: 0` is the point of this branch, not an afterthought. The search
        // cache gate is really a determinism gate: the bench asks the same 20 questions
        // twice and needs EVERY repeat to report `searchCached`, so a run that refines its
        // search has to word the refinement identically both times or the repeat misses a
        // cache key the fresh pass already warmed. Sonnet 5 rejects `temperature` outright,
        // which is why the comment below says the reason "has not gone away" — routing
        // Phase 1 to Haiku is what finally makes it reachable.
        { thinking: { type: 'disabled' }, temperature: 0 };
  }

  async complete(req: LlmCompleteRequest): Promise<LlmReply> {
    let res: Anthropic.Message;
    try {
      res = await anthropic().messages.create(
        {
          model: this.model,
          // Phase 1 emits tool calls, not prose. A big ceiling here buys nothing and
          // gives a confused model room to write an essay instead of calling a tool.
          max_tokens: req.maxTokens ?? 1536,
          ...this.tuning(),
          // NO `temperature` HERE, and it is not an oversight: Sonnet 5 rejects it with
          // `400 temperature is deprecated for this model`. It is worth recording why it
          // was wanted, because the reason has not gone away — the bench asks the same 20
          // questions twice and needs at least half of all answers to report
          // `searchCached`, which is exactly the repeat half, so every repeat must hit.
          // A run that refines its search may word the refinement differently the second
          // time, and one differently-worded refinement is one miss and a failed gate.
          // With sampling not controllable, the mitigation is that refinement is rare:
          // `effort: low` plus a prompt that allows at most one, only when the results
          // are clearly off-target.
          system: toSdkSystem(req.system),
          messages: toSdkMessages(req.messages),
          tools: toSdkTools(req.tools),
          ...(req.toolChoice ? { tool_choice: { type: 'tool' as const, name: req.toolChoice } } : {})
        },
        { signal: req.signal }
      );
    } catch (e) {
      throw asProviderError(e);
    }

    let text = '';
    const toolCalls: ToolCall[] = [];
    for (const block of res.content) {
      if (block.type === 'text') text += block.text;
      else if (block.type === 'tool_use') {
        toolCalls.push({
          id: block.id,
          name: block.name,
          // Tool inputs arrive as parsed JSON; never string-match the serialized form.
          input: (block.input ?? {}) as Record<string, unknown>
        });
      }
    }

    return { text, toolCalls, usage: usageOf(res.usage), stopReason: res.stop_reason ?? 'end_turn' };
  }

  async *stream(req: LlmRequest): AsyncGenerator<LlmStreamChunk> {
    // No `tools` parameter, and that is the point: at the moment the first token is
    // generated the citable universe is closed and already on the wire (§5.1).
    const stream = anthropic().messages.stream(
      {
        model: this.model,
        max_tokens: req.maxTokens ?? 1600,
        ...this.tuning(),
        system: toSdkSystem(req.system),
        messages: toSdkMessages(req.messages)
      },
      { signal: req.signal }
    );

    let usage: LlmUsage = emptyUsage();
    let stopReason = 'end_turn';
    try {
      for await (const event of stream) {
        if (event.type === 'content_block_delta' && event.delta.type === 'text_delta') {
          yield { type: 'text', text: event.delta.text };
        }
      }
      const final = await stream.finalMessage();
      usage = addUsage(usage, usageOf(final.usage));
      stopReason = final.stop_reason ?? 'end_turn';
    } catch (e) {
      // A throw mid-stream is still a provider failure. The caller has already sent
      // bytes, so it cannot change the status code — it emits `error` and stops. What it
      // must never do is finish the sentence itself.
      throw asProviderError(e);
    }

    yield { type: 'end', usage, stopReason };
  }
}

let singleton: LlmProvider | null = null;
let phase1Singleton: LlmProvider | null = null;

export function getLlmProvider(): LlmProvider {
  if (!singleton) singleton = new AnthropicProvider();
  return singleton;
}

/**
 * The Phase 1 (tool-choosing) provider. Separate instance, possibly a different model —
 * see `env.llmModelPhase1`.
 *
 * Returns the SAME object as `getLlmProvider()` when the two models match, so setting
 * `LLM_MODEL_PHASE1=claude-sonnet-5` restores the single-model behaviour exactly, down to
 * sharing one client and one prompt cache namespace.
 */
export function getPhase1LlmProvider(): LlmProvider {
  if (env.llmModelPhase1 === env.llmModel) return getLlmProvider();
  if (!phase1Singleton) phase1Singleton = new AnthropicProvider(env.llmModelPhase1);
  return phase1Singleton;
}
