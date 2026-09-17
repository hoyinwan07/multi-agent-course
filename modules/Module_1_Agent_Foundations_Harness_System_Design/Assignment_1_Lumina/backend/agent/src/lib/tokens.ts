/**
 * Truncation with a grounding guarantee (TECHSPEC §6.4).
 *
 * The rule that makes grounding structural: a snippet is selected from the text we
 * actually sent the model (`sentText`), and `sentText` is built only out of contiguous
 * runs of `fullText`. So `snippet ⊆ some segment ⊆ fullText` at any budget.
 *
 * `segments` is the part that matters and the part that is easy to get wrong. TECHSPEC
 * §6.4 suggests joining the head with high-scoring passages under an elision marker; the
 * moment you do that, a snippet window can straddle the marker and quote text that never
 * appeared contiguously on the page. So the joined string is what the model sees, and
 * `segments` — each one a real substring of `fullText` — is what snippet selection is
 * allowed to quote from. Week 1 produces exactly one segment (the head); the shape is
 * here so a smarter truncation later cannot silently break the gate.
 */

export const ELISION = '\n\n[…]\n\n';

/** ~4 characters per token. Good enough for a budget; we never bill from this. */
export function approxTokens(text: string): number {
  return Math.ceil(text.length / 4);
}

export type Truncated = {
  /** What goes in the prompt. Segments joined by ELISION. */
  text: string;
  /** Each one a verbatim contiguous run of the source. The only legal quote sources. */
  segments: string[];
  truncated: boolean;
};

/**
 * Week 1: keep the head. A pure prefix is a substring of `fullText` by definition, which
 * is the cheapest possible way to be correct.
 *
 * Trade-off, and it is a real one: a page whose relevant passage sits below the budget
 * loses it, and we cite something less apt from higher up. Extraction hands us main
 * content with the nav and boilerplate already gone, so the head is usually the article,
 * but on a long reference page it will not be. The alternative — stitching the best
 * passages together — buys relevance and costs the substring guarantee unless the
 * segment bookkeeping above is honoured exactly.
 */
export function truncateToBudget(fullText: string, maxTokens: number): Truncated {
  const budgetChars = maxTokens * 4;
  if (fullText.length <= budgetChars) {
    return { text: fullText, segments: [fullText], truncated: false };
  }
  const head = cutOnWordBoundary(fullText, budgetChars);
  return { text: head, segments: [head], truncated: true };
}

/** Never truncate mid-word: half a word is a token that exists on no page. */
export function cutOnWordBoundary(text: string, maxChars: number): string {
  if (text.length <= maxChars) return text;
  const slice = text.slice(0, maxChars);
  const lastBreak = slice.search(/\s\S*$/);
  return (lastBreak > maxChars * 0.5 ? slice.slice(0, lastBreak) : slice).trimEnd();
}
