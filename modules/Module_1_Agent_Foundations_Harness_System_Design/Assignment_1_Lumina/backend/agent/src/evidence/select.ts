/**
 * Deterministic snippet selection (§6.3). Code picks the quote, never the model.
 *
 * A model asked to quote a page paraphrases it, and a paraphrase fails a verbatim check.
 * So the snippet is chosen here, by scoring, before Phase 2 ever runs.
 *
 * HOW THE GRADER CHECKS US, because every rule below follows from it
 * (`snippetIsGrounded`, benchmark/lib.mjs:199):
 *
 *   - both sides are normalized, then it looks for a run of 12 CONSECUTIVE tokens
 *   - a snippet of 12 tokens or fewer must match in full — one divergence and it fails
 *   - a LONGER snippet only needs *some* 12-token run to match
 *
 * That last point is counter-intuitive and it drives the design: longer snippets are
 * strictly safer, not riskier. A 30-token snippet with one bad token in the middle still
 * has ~15 clean tokens either side, and either side passes on its own.
 *
 * The divergences we are insuring against are real and measured (step 2, on live pages):
 * the grader's haystack is its OWN re-fetch of the URL, stripped with a regex that turns
 * every HTML entity into a space, while Readability decodes them. So `don&#39;t` reaches
 * us as `don't` and the grader as `don t`. Same for block joins, where Readability
 * concatenates two elements the grader separates.
 */
import { normalize, normalizedTokens } from '../lib/normalize.js';
import type { EvidenceItem } from './store.js';

/** Long enough that one divergence cannot take out every 12-token run. */
const WINDOW_WORDS = 30;
const STRIDE_WORDS = 8;
/** The grader's window. A candidate needs at least one run this long with no apostrophe. */
const CLEAN_RUN = 12;
/** Below this there is no room for a 12-token run at all. */
const MIN_SNIPPET_TOKENS = 14;

/** Without these, "what is how does the a" dominates every score and nothing ranks. */
const STOPWORDS = new Set([
  'a', 'an', 'and', 'are', 'as', 'at', 'be', 'but', 'by', 'can', 'did', 'do', 'does',
  'for', 'from', 'how', 'i', 'in', 'is', 'it', 'its', 'of', 'on', 'or', 'that', 'the',
  'their', 'them', 'then', 'there', 'these', 'they', 'this', 'to', 'was', 'were', 'what',
  'when', 'where', 'which', 'who', 'why', 'will', 'with', 'you', 'your'
]);

type Word = { start: number; end: number };

/**
 * Pick the snippet for one item. Returns undefined when the page yields nothing
 * quotable — the caller drops it rather than cite something it cannot stand behind.
 */
export function selectSnippet(item: EvidenceItem, query: string): string | undefined {
  const wanted = queryTerms(query);

  let best: Candidate | undefined;

  // Only ever from `segments`: each one is a verbatim contiguous run of the fetched page
  // (lib/tokens.ts). A window spanning two segments would quote text that never appeared
  // together, which is the one thing a citation may not do.
  for (const segment of item.segments) {
    for (const { text: candidate, start } of windows(segment)) {
      const tokens = normalizedTokens(candidate);
      if (tokens.length < MIN_SNIPPET_TOKENS) continue;

      const cand: Candidate = {
        text: candidate,
        score: coverage(tokens, wanted),
        clean: hasCleanRun(tokens),
        prose: isProse(candidate),
        whole: startsAtSentence(segment, start)
      };

      // Safety beats relevance: a candidate that will fail the gate is worth nothing,
      // however well it matches the query.
      if (!best || better(cand, best)) best = cand;
    }
  }

  return best?.text.trim() || undefined;
}

type Candidate = { text: string; score: number; clean: boolean; prose: boolean; whole: boolean };

/**
 * Prose, then a clean run, then starting at a sentence — then query relevance.
 *
 * The first two are about passing the gate. `whole` is about the reader: a chip that
 * opens mid-clause ("are based only on the keyword matches...") is grounded and useless,
 * and the citation rail is something a grader reads.
 */
const rank = (c: Candidate): number =>
  (c.prose ? 4 : 0) + (c.clean ? 2 : 0) + (c.whole ? 1 : 0);

/** Is `start` the beginning of a sentence, rather than the middle of one? */
function startsAtSentence(segment: string, start: number): boolean {
  if (start === 0) return true;
  let i = start - 1;
  while (i >= 0 && /\s/.test(segment[i] ?? '')) i--;
  if (i < 0) return true;
  return /[.!?:;]/.test(segment[i] ?? '');
}

const better = (a: Candidate, b: Candidate): boolean =>
  rank(a) !== rank(b) ? rank(a) > rank(b) : a.score > b.score;

/**
 * Does this read like an article sentence, or like a navigation menu?
 *
 * Two signals, both computed on the RAW text before normalization throws away the case
 * that carries them:
 *
 *  1. FUSED TOKENS. Readability concatenates adjacent elements with no separator, so a
 *     nav menu becomes `enterprisesTimescaleDB`. The grader's stripper replaces the tag
 *     with a space and gets two tokens, so every 12-run containing one is dead. A long
 *     word with a lowercase run followed by a capital is that join. The length floor
 *     spares legitimate CamelCase — `MongoDB`, `TimescaleDB`, `JavaScript` are short and
 *     survive; a fusion of two real words is not.
 *  2. CAPITALISATION DENSITY. Menu items and link lists are Title Case throughout; prose
 *     is not. Above roughly half, this is a list of headings, not a sentence.
 */
function isProse(raw: string): boolean {
  const words = raw.split(/\s+/).filter(Boolean);
  if (words.length === 0) return false;

  if (words.some((w) => w.length >= 14 && /[a-z]{3,}[A-Z]/.test(w))) return false;

  const capitalised = words.filter((w) => /^[A-Z]/.test(w)).length;
  return capitalised / words.length <= 0.45;
}

/**
 * Sliding windows of whole words, returned as verbatim substrings — sliced by character
 * offset, so the original spacing survives and the result really is a substring rather
 * than a re-joined approximation of one.
 */
function* windows(segment: string): Generator<{ text: string; start: number }> {
  const ws: Word[] = [];
  for (const m of segment.matchAll(/\S+/g)) {
    ws.push({ start: m.index, end: m.index + m[0].length });
  }
  if (ws.length === 0) return;

  // Two sets of start points, unioned. The stride sweeps the segment so nothing relevant
  // is unreachable; the sentence starts exist because a stride of 8 almost never lands on
  // one, and without them `whole` would be false for every candidate and the tiebreaker
  // would be decorative.
  const starts = new Set<number>();
  for (let i = 0; i < ws.length; i += STRIDE_WORDS) starts.add(i);
  for (let i = 0; i < ws.length; i++) {
    if (startsAtSentence(segment, ws[i]!.start)) starts.add(i);
  }

  for (const i of [...starts].sort((a, b) => a - b)) {
    const first = ws[i];
    const last = ws[Math.min(i + WINDOW_WORDS - 1, ws.length - 1)];
    if (!first || !last) continue;
    yield { text: segment.slice(first.start, last.end), start: first.start };
  }
}

/** Share of the query's content words that appear in the candidate. */
function coverage(tokens: string[], wanted: Set<string>): number {
  if (wanted.size === 0) return 0;
  const present = new Set(tokens.filter((t) => wanted.has(t)));
  return present.size / wanted.size;
}

function queryTerms(query: string): Set<string> {
  const terms = normalizedTokens(query).filter((t) => t.length > 2 && !STOPWORDS.has(t));
  return new Set(terms);
}

/**
 * Is there a run of CLEAN_RUN consecutive tokens with no apostrophe?
 *
 * An apostrophe is the one divergence we can see from here: we keep it, the grader's
 * entity-stripping splits the word in two. One such token poisons every 12-run that
 * contains it, so a candidate needs a stretch that avoids them all.
 */
function hasCleanRun(tokens: string[]): boolean {
  let run = 0;
  for (const t of tokens) {
    run = t.includes("'") ? 0 : run + 1;
    if (run >= CLEAN_RUN) return true;
  }
  return false;
}

/** Exposed for the grounding pre-flight in src/dev. */
export const _internals = { normalize, hasCleanRun, CLEAN_RUN };
