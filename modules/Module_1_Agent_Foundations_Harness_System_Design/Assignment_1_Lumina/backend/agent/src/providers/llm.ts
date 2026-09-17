/**
 * The LLM provider interface. Two methods, because the loop has exactly two shapes:
 *
 *   complete()  Phase 1 — tools on, no prose wanted, we need the tool calls back
 *   stream()    Phase 2 — tools OFF, prose streaming, first token on the clock
 *
 * Deliberately provider-neutral. The message type below is not a re-declaration of the
 * SDK's `MessageParam` for its own sake: it is the smallest shape both phases need, and
 * keeping it here is what lets `llm.anthropic.ts` be the only file that knows a
 * `tool_use` block from a `tool_result` block. Everything SDK-shaped lives in there.
 */

export type ToolCall = {
  /** The provider's id for this call. The tool result must quote it back verbatim. */
  id: string;
  name: string;
  input: Record<string, unknown>;
};

export type ToolResultBlock = {
  toolCallId: string;
  /** What the model sees. For a failure this is the error text, not a silence. */
  content: string;
  /** Marks the result as a failure to the model. A dropped failure teaches it nothing. */
  isError: boolean;
};

export type LlmMessage =
  | { role: 'user'; text: string }
  | { role: 'assistant'; text: string; toolCalls: ToolCall[] }
  /** Every result from ONE assistant turn, together. Splitting them across messages
   *  trains the model out of calling tools in parallel, which is the 2s-vs-6s decision. */
  | { role: 'tool'; results: ToolResultBlock[] };

export type LlmToolDef = {
  name: string;
  description: string;
  /** JSON Schema. The contract owns the tool NAMES; the shapes are ours. */
  inputSchema: Record<string, unknown>;
};

export type LlmUsage = { inputTokens: number; outputTokens: number };

export type LlmReply = {
  text: string;
  toolCalls: ToolCall[];
  usage: LlmUsage;
  stopReason: string;
};

export type LlmStreamChunk =
  | { type: 'text'; text: string }
  /** Always last, exactly once. Cost accounting reads it (§10.2). */
  | { type: 'end'; usage: LlmUsage; stopReason: string };

export type LlmRequest = {
  system: string;
  messages: LlmMessage[];
  maxTokens?: number;
  signal?: AbortSignal;
};

export type LlmCompleteRequest = LlmRequest & { tools: LlmToolDef[] };

export interface LlmProvider {
  /** What /health names and what the `done` event reports. Never a key. */
  readonly model: string;
  /** Throws ProviderError on any upstream failure. Never a fallback answer. */
  complete(req: LlmCompleteRequest): Promise<LlmReply>;
  /** Tools are not a parameter here, on purpose: Phase 2 cannot retrieve. §5.1. */
  stream(req: LlmRequest): AsyncGenerator<LlmStreamChunk>;
}

export const emptyUsage = (): LlmUsage => ({ inputTokens: 0, outputTokens: 0 });

export function addUsage(a: LlmUsage, b: LlmUsage): LlmUsage {
  return { inputTokens: a.inputTokens + b.inputTokens, outputTokens: a.outputTokens + b.outputTokens };
}
