/**
 * The tool registry. Seam 1 of the Week 2 ledger (TECHSPEC §13).
 *
 * Two jobs, and the second one is the one that matters:
 *
 *   forGear(gear)  decides which tools the model is even SHOWN. Not "asked not to use" —
 *                  not shown. A quick run cannot call plan_research because plan_research
 *                  is not in the request, which is a different kind of guarantee from a
 *                  sentence in a prompt. `plan_research.ts` exists on disk and is
 *                  deliberately absent from the map below; Week 2 registers it and
 *                  `forGear` filters it out for quick.
 *
 *   run(...)       is the ONE place the error taxonomy (§9) is applied. A tool-level
 *                  failure becomes { ok:false, error } and the loop continues. A
 *                  ProviderError is re-thrown untouched and ends the run. Nothing else in
 *                  the codebase gets to make that call.
 */
import type { ToolName } from '@lumina/contract';
import { errorMessage, isProviderError } from '../lib/errors.js';
import type { Gear } from '../loop/gear.js';
import type { LlmToolDef } from '../providers/llm.js';
import { fetchPage } from './fetch_page.js';
import { recallMemory } from './recall_memory.js';
import { saveMemory } from './save_memory.js';
import { webSearch } from './web_search.js';
import type { Tool, ToolContext, ToolResult } from './types.js';

/**
 * Registered tools. `plan_research` is NOT here and must not be added in Week 1: a quick
 * run whose trace contains it is a red line in eval/rubric.json, and bench.mjs checks
 * every quick run for it.
 *
 * Week 1 note: `search_documents` (Week 2) lands here as it is built. Nothing else about
 * this file changes.
 */
const REGISTRY: ReadonlyMap<string, Tool> = new Map<string, Tool>([
  [webSearch.name, webSearch],
  [fetchPage.name, fetchPage],
  [recallMemory.name, recallMemory],
  [saveMemory.name, saveMemory]
]);

/**
 * The tools this gear may see, as the LLM provider's tool definitions.
 *
 * Two filters, and they are different kinds of thing. `forbiddenTools` is a spend
 * boundary the CONTRACT owns — a quick run may not see `plan_research`. `systemOnly` is an
 * architectural one WE own: `recall_memory` is fired by the loop before the model's first
 * turn, so offering it to the model as well can only buy a duplicate call for something
 * already sitting in the prompt.
 */
export function forGear(gear: Gear): LlmToolDef[] {
  const out: LlmToolDef[] = [];
  for (const tool of REGISTRY.values()) {
    if (gear.forbiddenTools.includes(tool.name)) continue;
    if (tool.systemOnly) continue;
    out.push({ name: tool.name, description: tool.description, inputSchema: tool.inputSchema });
  }
  // Stable order: the tool list is part of the cacheable prefix, and a set iterated in a
  // different order every request silently invalidates the cache.
  return out.sort((a, b) => a.name.localeCompare(b.name));
}

export function isRegistered(name: string): name is ToolName {
  return REGISTRY.has(name);
}

/**
 * Run one tool. NEVER throws for a tool-level failure; ALWAYS throws for a provider one.
 *
 * The gear is passed so a forbidden tool is refused even if it somehow reaches here —
 * `forGear` already keeps it out of the request, and this is the second lock on the same
 * door. Belt and braces, because the failure it prevents is a red line.
 */
export async function run(
  name: string,
  input: Record<string, unknown>,
  ctx: ToolContext,
  gear: Gear
): Promise<ToolResult> {
  if (gear.forbiddenTools.includes(name)) {
    return { ok: false, error: `tool "${name}" is not available on a ${gear.depth} search` };
  }

  const tool = REGISTRY.get(name);
  if (!tool) {
    // A hallucinated tool name. The model gets told, in the tool result, that it is not
    // a tool — which is far more useful to it than an exception is to anyone.
    return { ok: false, error: `unknown tool "${name}"` };
  }

  try {
    return await tool.run(input, ctx);
  } catch (e) {
    // The one line the whole taxonomy rests on. A provider being down is not something
    // the model can work around by trying a different page.
    if (isProviderError(e)) throw e;
    return { ok: false, error: errorMessage(e) };
  }
}

/** For step 2's verification: call a tool directly from `tsx` without a loop. */
export function get(name: string): Tool | undefined {
  return REGISTRY.get(name);
}
