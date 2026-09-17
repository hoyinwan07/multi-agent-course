/**
 * save_memory — the ONLY way anything becomes durable.
 *
 * "Nothing is remembered that `GET /memory` does not show" (`SPEC.md §5.3`) is a promise
 * about this file: there is no other writer to the `memories` collection, no inference that
 * quietly stores what a user seemed to like, and no summarisation pass that files away a
 * paraphrase of the conversation. If the model did not call this tool, nothing was kept.
 *
 * Model-chosen, unlike recall, and that asymmetry is the point (§5.4): the requirement is
 * that only STABLE facts and preferences are written, and whether "I'm on a train" is a
 * stable fact is a judgement that needs the context of the conversation. A rule could not
 * make it. What a rule can do is bound the damage when the judgement is wrong, which is
 * what `MAX_SAVES` and the delete endpoint are for.
 *
 * The id is derived from the memory's own content, so this is idempotent: a user who
 * repeats a preference rewrites one row rather than accumulating a duplicate every time.
 * Same natural-id rule as every other upsert in `repo/` (§4.4).
 */
import { createHash } from 'node:crypto';
import { MemoryDoc } from '@lumina/contract';
import { normalize } from '../lib/normalize.js';
import { cutOnWordBoundary } from '../lib/tokens.js';
import { embed } from '../providers/embed.js';
import { insertMemory } from '../repo/memories.js';
import type { Tool, ToolContext, ToolResult } from './types.js';

/**
 * Writes per request. A model that decides to file away every sentence of a long answer
 * would otherwise spend an embedding call and an Atlas write per sentence, and leave the
 * user a memory panel they have to clean up by hand. Three is more than any honest turn
 * needs; the fourth is a symptom.
 */
const MAX_SAVES = 3;

/** A memory is a sentence, not a document. Longer than this is a note, and it gets cut. */
const MAX_TEXT_CHARS = 400;

export const saveMemory: Tool = {
  name: 'save_memory',

  description: [
    'Remember a durable fact or preference about this user, so it applies to every future',
    'conversation. Call it when the user states a standing preference ("always answer in',
    'British English", "I write TypeScript, show me code not prose") or a lasting fact about',
    'themselves or their work.',
    '',
    'Do NOT use it for anything about the current question, anything you just read on a page,',
    'or anything that will be stale tomorrow. Store one self-contained sentence written in',
    'the third person ("The user prefers …"), not a fragment that only makes sense in this',
    'thread. The user can see and delete everything you save here.'
  ].join('\n'),

  inputSchema: {
    type: 'object',
    properties: {
      text: {
        type: 'string',
        description:
          'The fact or preference, as one self-contained sentence that will still make sense in an unrelated conversation a month from now.'
      }
    },
    required: ['text'],
    additionalProperties: false
  },

  async run(input: Record<string, unknown>, ctx: ToolContext): Promise<ToolResult> {
    const raw = typeof input.text === 'string' ? input.text.replace(/\s+/g, ' ').trim() : '';
    if (!raw) return { ok: false, error: 'save_memory requires a non-empty "text" string' };

    if (ctx.memory.saves >= MAX_SAVES) {
      // A tool-level refusal the model can read and move on from, not an exception.
      return {
        ok: false,
        error: `memory budget spent (${MAX_SAVES} saves per request). Do not save anything further in this turn.`,
        reason: `refused a ${ctx.memory.saves + 1}th save`
      };
    }
    ctx.memory.saves += 1;

    const text = cutOnWordBoundary(raw, MAX_TEXT_CHARS);
    const { vector, tokens } = await embed(text);
    ctx.embeddingTokens.total += tokens;

    // Keyed on (user, normalized text) so the same preference saved twice is one row. The
    // `mem_` prefix is kept because every other id in the system carries its type, and a
    // bare hash in a URL tells the next reader nothing.
    const _id = `mem_${createHash('sha256').update(`${ctx.userId}|${normalize(text)}`).digest('hex').slice(0, 24)}`;

    // Parsed, not trusted: a wrong-length embedding here becomes an unusable vector index
    // later, and the symptom ("recall returns nothing") surfaces three steps from the cause.
    const doc = MemoryDoc.parse({
      _id,
      userId: ctx.userId,
      text,
      embedding: vector,
      sourceThread: ctx.threadId,
      createdAt: new Date().toISOString()
    });

    await insertMemory(doc);

    return {
      ok: true,
      // Small on purpose: this observation is billed again on every later turn, and the
      // model already knows what it just asked to save.
      observation: `Saved. This will be recalled in future conversations. Memory id: ${_id}`,
      reason: `saved a memory (${text.length} chars)`
    };
  }
};
