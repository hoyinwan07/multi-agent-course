/**
 * plan_research — DEEP SEARCH ONLY, and never dispatched through `tools/registry.ts`.
 *
 * Every other tool is something the model CHOOSES to call, interleaved with others, over
 * however many turns the loop takes — which is exactly wrong for a decomposition that Must
 * happen exactly once, first, before any retrieval (§5.5's `plan` event ships before a
 * single `web_search`/`fetch_page`/`search_documents`). Leaving that ordering to a system
 * prompt and hoping the model calls this tool before the others is the kind of guarantee
 * this codebase's own rule calls "a request in a prompt" rather than structural.
 *
 * So `loop/deep.ts` calls the LLM ONCE, directly, with `tools: [thisToolsDef]` and
 * `toolChoice: 'plan_research'` forced — before the retrieval loop starts at all — and
 * reads the decomposition straight out of that one forced tool call. `run()` below is
 * consequently never invoked by anything: it stays as a tripwire, not a code path. It is
 * also still deliberately NOT in `tools/registry.ts`'s `REGISTRY` map, for the original
 * reason — a quick run whose trace contains `plan_research` is a red line in
 * `eval/rubric.json`, and not registering it makes calling it during the normal turn loop
 * impossible (an unknown tool name, per `registry.run`) rather than merely forbidden.
 */
import { env } from '../env.js';
import type { Tool, ToolContext, ToolResult } from './types.js';

export const planResearch: Tool = {
  name: 'plan_research',

  description: [
    `Decompose the question into ${env.deepSubQuestionsMin}-${env.deepSubQuestionsMax} sub-questions, each with a one-line reason.`,
    'Deep search only. Runs before any retrieval.'
  ].join(' '),

  inputSchema: {
    type: 'object',
    properties: {
      subQuestions: {
        type: 'array',
        minItems: env.deepSubQuestionsMin,
        maxItems: env.deepSubQuestionsMax,
        items: {
          type: 'object',
          properties: {
            question: { type: 'string' },
            reason: { type: 'string', description: 'Why this sub-question is worth asking.' }
          },
          required: ['question', 'reason'],
          additionalProperties: false
        }
      }
    },
    required: ['subQuestions'],
    additionalProperties: false
  },

  async run(_input: Record<string, unknown>, _ctx: ToolContext): Promise<ToolResult> {
    // Unreachable by construction (see header) — never registered, so `registry.run`
    // answers "unknown tool" before this could ever execute. Throwing rather than
    // returning a plausible plan is the same "fail loud" reflex as everywhere else: if
    // this is ever reached, something upstream broke the guarantee, and it must be loud.
    throw new Error('plan_research has no dispatchable run() — see this file\'s header comment');
  }
};
