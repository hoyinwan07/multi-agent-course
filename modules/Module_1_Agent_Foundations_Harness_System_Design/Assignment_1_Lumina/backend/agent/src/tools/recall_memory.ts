/**
 * recall_memory — what this user has told us to remember. It produces NO evidence.
 *
 * A memory is not a source. It never gets a citation number, it never enters the evidence
 * store, and the prompts that carry it say so in as many words: it shapes HOW the answer is
 * written, never WHAT the answer claims. The structural guarantee is the same one that
 * holds for search teasers — `toSources()` in `evidence/merge.ts` is the only function that
 * mints a `Source`, and nothing here ever reaches it.
 *
 * `systemOnly`: the loop fires this as step 1 of every request and the model is not shown
 * it (§5.4). The recall has to be in the prompt BEFORE the model reasons, so spending an
 * LLM round trip to be told to do a thing we always want is pure latency.
 *
 * TOP-K WITH NO SCORE FLOOR, and that is a deliberate call rather than a missing feature.
 * The obvious guard on an eager injection is a relevance threshold — drop anything below
 * some cosine score, so an unrelated memory cannot colour an unrelated answer. It is wrong
 * here, and measurably so: the graded scenario saves "always answer in British English" in
 * thread A and asks "what is the capital of Portugal?" in thread B. A preference is never
 * topically similar to the question it governs — that is what makes it a preference — so
 * any threshold high enough to filter noise filters out exactly the memories that matter
 * most. The cap is therefore k, not score.
 *
 * What that costs, stated plainly for DESIGN.md: at fifty memories the top six by
 * similarity are all topical, and the standing preference is crowded out by rows that merely
 * look like the question. The fix is a typed memory — a `kind: 'preference' | 'fact'` field,
 * preferences always injected and facts vector-searched — and it is out of scope in Week 1
 * because `MemoryDoc` is fixed by the contract and has no such field.
 *
 * Failure is TOOL-level, not provider-level, in one direction only: Atlas being unreachable
 * throws out of `repo/`, and that is a genuine outage the run should die on. What it must
 * never do is quietly return "no memories" for a user who has some — that is the Live
 * Translate shape, and it would make a deleted preference and a broken index look identical.
 */
import type { RecalledMemory } from '../repo/memories.js';
import { recallMemories } from '../repo/memories.js';
import { cutOnWordBoundary } from '../lib/tokens.js';
import { logFor } from '../obs/log.js';
import { embed } from '../providers/embed.js';
import type { Tool, ToolContext, ToolResult } from './types.js';

/**
 * The injection budget (`SPEC.md §5.3` caps it at ~10 documents / 1 000 tokens).
 *
 * Six rather than ten because this block is paid for TWICE on every request — once in
 * Phase 1's prompt and once in Phase 2's — on a cost gate that is already tight, and
 * because a user with more than six standing instructions has a preferences problem no
 * amount of k solves.
 */
const RECALL_K = 6;

/** Per memory, so one pasted essay cannot eat the whole block. */
const MEMORY_CHARS = 240;

/** And across all of them: ~1 200 chars ≈ 300 tokens, comfortably inside the §5.3 cap. */
const BLOCK_CHARS = 1200;

export const recallMemory: Tool = {
  name: 'recall_memory',
  systemOnly: true,

  description:
    'Retrieve durable facts and preferences this user has asked to be remembered. Run automatically at the start of every request; not callable by the model.',

  inputSchema: {
    type: 'object',
    properties: {
      query: { type: 'string', description: 'The question to find relevant memories for.' }
    },
    required: ['query'],
    additionalProperties: false
  },

  async run(input: Record<string, unknown>, ctx: ToolContext): Promise<ToolResult> {
    const query = typeof input.query === 'string' ? input.query.trim() : '';
    if (!query) return { ok: false, error: 'recall_memory requires a non-empty "query" string' };

    const { vector, tokens } = await embed(query);
    ctx.embeddingTokens.total += tokens;

    const found = await recallMemories(ctx.userId, vector, RECALL_K);

    if (!found.length) {
      // A user with no memories is the normal case, not a failure. `ok: true` with an
      // observation saying so keeps "nothing stored" distinguishable from "lookup broke",
      // which is the whole of rule A1.
      return {
        ok: true,
        observation: '',
        reason: 'no stored memories for this user'
      };
    }

    logFor(ctx.requestId, ctx.userId).info(
      { recalled: found.length, scores: found.map((m) => Math.round(m.score * 1000) / 1000) },
      'recalled memories'
    );

    return {
      ok: true,
      observation: renderMemories(found),
      reason: `recalled ${found.length} memor${found.length === 1 ? 'y' : 'ies'}`
    };
  }
};

/**
 * The block both phases receive. Labelled as instructions about the reader rather than as
 * retrieved material, because the failure this prevents is a model treating a remembered
 * fact as a source and attaching a citation number to it.
 */
function renderMemories(found: RecalledMemory[]): string {
  const lines: string[] = [];
  let used = 0;
  for (const m of found) {
    const text = cutOnWordBoundary(m.text.replace(/\s+/g, ' ').trim(), MEMORY_CHARS);
    if (!text) continue;
    if (used + text.length > BLOCK_CHARS) break;
    used += text.length;
    lines.push(`- ${text}`);
  }
  if (!lines.length) return '';
  return [
    'What this user has previously asked you to remember:',
    ...lines,
    '',
    'These are standing instructions and facts about the reader. They govern HOW you answer.',
    'They are NOT sources: never cite one, and never state one as a retrieved fact.'
  ].join('\n');
}
