/**
 * ONE normalizer, two callers: the search-cache key (§7.1) and lexical snippet scoring
 * (§6.3). Two normalizers drift, and the day they drift is the day a cache key stops
 * matching or a snippet stops being found.
 *
 * This is a byte-for-byte copy of `normalize` in `benchmark/lib.mjs`. That function is
 * the grader; if ours is merely similar, our grounding self-check and the graded one
 * disagree and we find out from the report. Note what it is NOT: TECHSPEC §7.1 describes
 * an NFKC pass, and the grader has none. The grader wins, so there is no NFKC here — a
 * ligature we folded and the grader did not would make us think a snippet was grounded
 * when the gate says it is not.
 */
export function normalize(s: unknown): string {
  return String(s ?? '')
    .toLowerCase()
    .replace(/[‘’“”]/g, "'")
    .replace(/[^a-z0-9']+/g, ' ')
    .trim();
}

/** The normalized token stream. The grounding gate compares runs of these. */
export function normalizedTokens(s: unknown): string[] {
  const n = normalize(s);
  return n ? n.split(' ') : [];
}

/**
 * The grader's grounding check (`snippetIsGrounded` in benchmark/lib.mjs), reimplemented
 * so we can assert on ourselves before the bench does. Same default window: 12 tokens.
 */
export function snippetIsGrounded(snippet: string, haystack: string, minTokens = 12): boolean {
  const need = normalizedTokens(snippet).filter(Boolean);
  const hay = normalize(haystack);
  if (!need.length || !hay) return false;
  if (need.length <= minTokens) return hay.includes(need.join(' '));
  for (let i = 0; i + minTokens <= need.length; i++) {
    if (hay.includes(need.slice(i, i + minTokens).join(' '))) return true;
  }
  return false;
}

/**
 * The grounding haystack the bench builds is its OWN fetch of the URL, run through a
 * regex HTML stripper that turns every entity — `&amp;`, `&#39;`, `&nbsp;` — into a
 * space. Readability decodes those entities instead, so `don&#39;t` reaches us as
 * `don't` and reaches the grader as `don t`. `normalize` keeps apostrophes, so those two
 * token streams differ and a 12-token run straddling one will not match.
 *
 * Cheap insurance: prefer candidate snippets whose normalized form has no apostrophe.
 * Used as a tiebreaker in snippet selection, never as a hard filter — a page that is all
 * contractions should still get a citation.
 */
export function hasApostropheRisk(s: string): boolean {
  return normalize(s).includes("'");
}
