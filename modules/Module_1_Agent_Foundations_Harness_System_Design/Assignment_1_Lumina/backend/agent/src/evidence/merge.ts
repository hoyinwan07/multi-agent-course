/**
 * The ONLY place a `Source` is minted. Seam 3 of the Week 2 ledger (§13), and the one
 * that pays: it takes an ARRAY OF ARRAYS and is called with one element in Week 1.
 *
 * Deep search merges five sub-question result sets into one contiguous numbering. Writing
 * that signature now costs nothing; writing `merge(items: EvidenceItem[])` and changing
 * it later costs a day, because dedupe-and-renumber across sets is exactly the
 * bookkeeping deep search is graded on.
 */
import type { Source } from '@lumina/contract';
import type { EvidenceItem } from './store.js';
import { selectSnippet } from './select.js';

/**
 * Flatten, dedupe by `id`, keep first-seen order. First wins because the earliest
 * retrieval is the one whose sub-question ordering the reader will expect in Week 2.
 */
export function mergeEvidence(sets: EvidenceItem[][]): EvidenceItem[] {
  const seen = new Map<string, EvidenceItem>();
  for (const set of sets) {
    for (const item of set) {
      if (!seen.has(item.id)) seen.set(item.id, item);
    }
  }
  return [...seen.values()];
}

/**
 * A numbered source and the evidence it was minted from, kept together.
 *
 * Phase 2 needs both halves: the `n` it may cite and the page text it may cite it for.
 * Recovering the pairing afterwards means matching on `title`, and two pages on one site
 * share a title often enough that it would eventually hand the model the wrong page under
 * the right number — a grounding failure that looks like a model mistake.
 */
export type CitedSource = { source: Source; item: EvidenceItem };

export type SourcesResult = {
  sources: Source[];
  /** The same sources, each with its evidence. Parallel to `sources`, same order. */
  cited: CitedSource[];
  /** Items that produced no quotable passage. Cited by nothing; reported, not hidden. */
  dropped: { title: string; url?: string; reason: string }[];
};

/**
 * Number the survivors 1..N and attach a deterministically selected snippet.
 *
 * An item with no selectable passage is DROPPED, not cited with an empty or invented
 * snippet: the contract requires a non-empty snippet, and a citation we cannot quote is
 * a citation we cannot defend. Numbering happens after the drop so `n` stays contiguous.
 */
export function toSources(items: EvidenceItem[], query: string): SourcesResult {
  const cited: CitedSource[] = [];
  const dropped: SourcesResult['dropped'] = [];

  for (const item of items) {
    const snippet = selectSnippet(item, query);
    if (!snippet) {
      dropped.push({
        title: item.title,
        ...(item.url ? { url: item.url } : {}),
        reason: 'no passage long enough to quote verbatim'
      });
      continue;
    }

    const source: Source = {
      n: cited.length + 1,
      kind: item.kind,
      title: item.title,
      snippet,
      ...(item.url ? { url: item.url } : {}),
      ...(item.docId ? { docId: item.docId } : {}),
      ...(item.locator ? { locator: item.locator } : {}),
      // Week 2 passes a real index here; Week 1 never has one.
      ...(item.subQuestion ? { subQuestion: item.subQuestion } : {})
    };
    cited.push({ source, item });
  }

  return { sources: cited.map((c) => c.source), cited, dropped };
}

/**
 * The self-check §6.3 asks for: is every snippet actually a substring of the page text we
 * hold? It must be, by construction — selection only ever slices a segment. If this ever
 * returns a failure, the guarantee has been broken upstream and grounding is unsafe.
 *
 * It takes the pairs rather than looking the item up again, so the check is against the
 * page the source was actually minted from and not against one that merely shares a title.
 */
export function verifySubstrings(cited: CitedSource[]): string[] {
  const problems: string[] = [];
  for (const { source, item } of cited) {
    if (!item.fullText.includes(source.snippet)) {
      problems.push(`[${source.n}] ${source.title}: snippet is not a substring of the fetched text`);
    }
  }
  return problems;
}
