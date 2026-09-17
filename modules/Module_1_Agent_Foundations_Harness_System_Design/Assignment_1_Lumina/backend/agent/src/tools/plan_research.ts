/**
 * plan_research — DEEP SEARCH ONLY. [W2]
 *
 * This file exists in Week 1 so the seam is visible and nothing has to be restructured
 * later. It is deliberately NOT imported by tools/registry.ts, and it must stay that way
 * until deep search is built:
 *
 *   - a quick run whose trace contains plan_research has escalated itself into a run that
 *     costs several times more. That is a red line in eval/rubric.json and bench.mjs
 *     checks every quick run for it (AGENTS.md, TECHSPEC §13);
 *   - registering it and relying on `forGear` to filter it would work, but it makes the
 *     red line depend on one boolean staying correct. Not importing it makes the failure
 *     impossible instead of unlikely.
 *
 * Week 2: implement `run`, add it to REGISTRY, and let `Gear.forbiddenTools` keep it away
 * from quick — at which point the filter is the second lock rather than the only one.
 */
import type { Tool, ToolContext, ToolResult } from './types.js';

export const planResearch: Tool = {
  name: 'plan_research',

  description: [
    'Decompose the question into 3-6 sub-questions, each with a one-line reason.',
    'Deep search only. Runs before any retrieval.'
  ].join(' '),

  inputSchema: {
    type: 'object',
    properties: {
      subQuestions: {
        type: 'array',
        minItems: 3,
        maxItems: 6,
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
    // Week 2. Throwing rather than returning a plausible plan: if this is ever reached in
    // Week 1, the run must fail loudly and visibly, not quietly produce a deep search.
    throw new Error('plan_research is not implemented in Week 1 and must not be registered');
  }
};
