/**
 * Thread history → prompt turns.
 *
 * The whole job of this file is that "what is its pricing?" resolves. It is four rules,
 * and three of them exist because the obvious implementation — replay the stored messages
 * verbatim — is wrong in a way that does not show up in testing.
 *
 * 1 · CITATION MARKERS ARE STRIPPED. A stored assistant answer is full of `[1]`, `[2]`
 *     from ITS request's numbering. Replay it into Phase 2 and the model happily reuses
 *     `[2]` in the new answer — where `[2]` is in range for this request, so the guard in
 *     `citations.ts` passes it, `unresolvedCitations()` returns `[]`, the bench scores it
 *     as grounded, and the citation points at an unrelated page. That is the worst class
 *     of grounding bug: every automated check goes green and only a reader notices. The
 *     numbering is meaningful only inside the request that minted it, so it does not
 *     survive the request.
 *
 * 2 · HISTORY IS BOUNDED, HARD. `benchmark/bench.mjs` creates ONE thread and sends 40
 *     unrelated questions down it at concurrency 4. Unbounded history would put 39
 *     unrelated exchanges in front of every question — paid for twice per run, once in
 *     each phase — and `max_cost_per_answer_usd` is 0.05 against a run that already costs
 *     up to 0.045. Two exchanges, truncated.
 *
 * 3 · ONLY COMPLETE PAIRS. A run that died leaves a user message with no answer, and the
 *     Anthropic API requires messages to start with `user` and alternate. Pairing user
 *     turns with the answer that followed them drops the dangling ones structurally,
 *     rather than leaving a `user, user` sequence to be discovered as a 400 in production.
 *
 * 4 · TRUNCATION IS HEAD-ONLY, on a word boundary — the same rule as `lib/tokens.ts`, for
 *     the same reason. What resolves a pronoun is the previous question and the opening of
 *     the answer that followed it; the tail of a 180-word answer is not carrying context
 *     worth 100 tokens on the TTFT path.
 */
import type { MessageDoc } from '@lumina/contract';
import { cutOnWordBoundary } from '../lib/tokens.js';
import type { LlmMessage } from '../providers/llm.js';

/** Exchanges (a question and its answer) carried into the prompt. See rule 2. */
export const HISTORY_EXCHANGES = 2;

/**
 * How many stored messages to read to find those exchanges. Four per exchange rather than
 * two, so a thread whose recent turns include a couple of failed runs still yields two
 * complete pairs instead of silently dropping to one.
 */
export const HISTORY_FETCH = HISTORY_EXCHANGES * 4;

const USER_CHARS = 240;
const ASSISTANT_CHARS = 320;

/** `[12]` → nothing, and the space in front of it with it, so prose does not gap. */
export function stripCitations(text: string): string {
  return text
    .replace(/[ \t]*\[\d{1,3}\]/g, '')
    .replace(/[ \t]{2,}/g, ' ')
    .trim();
}

/**
 * Ordered stored messages → the turns that go in front of this request's question.
 *
 * Takes messages oldest-first (what `recentMessages` returns) and returns an alternating
 * `user, assistant, …` sequence ending in `assistant`, ready to sit in front of the
 * current user message in either phase.
 */
export function buildHistory(messages: MessageDoc[]): LlmMessage[] {
  const pairs: { question: string; answer: string }[] = [];
  let pendingUser: MessageDoc | null = null;

  for (const m of messages) {
    if (m.role === 'user') {
      // A newer question supersedes an older unanswered one: the run that was supposed to
      // answer it did not, so it is not half of an exchange.
      pendingUser = m;
      continue;
    }
    if (!pendingUser) continue; // an answer with no question in range — nothing to pair it to
    pairs.push({ question: pendingUser.content, answer: m.content });
    pendingUser = null;
  }

  return pairs.slice(-HISTORY_EXCHANGES).flatMap(({ question, answer }): LlmMessage[] => {
    const q = cutOnWordBoundary(question.trim(), USER_CHARS);
    const a = cutOnWordBoundary(stripCitations(answer), ASSISTANT_CHARS);
    // Anything empty after stripping would break the alternation the API requires, so the
    // placeholder is text rather than an omitted turn.
    return [
      { role: 'user', text: q || '(empty question)' },
      { role: 'assistant', text: a || '(no answer was produced)', toolCalls: [] }
    ];
  });
}
