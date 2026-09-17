/**
 * The per-request evidence set: the ONLY citable universe (TECHSPEC §6.1).
 *
 * Nothing that is not in here may appear as `[n]` in an answer. It is deliberately
 * in-memory and request-scoped — a citation that outlives the request it was retrieved
 * in is exactly the failure the assignment calls an automatic fail.
 */
import type { Locator } from '@lumina/contract';

export type EvidenceItem = {
  /** Dedupe key. Normalized URL for web; `docId:locator` for docs in Week 2. */
  id: string;
  kind: 'web' | 'doc';
  title: string;
  url?: string;
  docId?: string;
  locator?: Locator;
  /** Everything extraction gave us. Never sent to the model; kept for diagnostics. */
  fullText: string;
  /** The truncated window ACTUALLY sent to the model. A snippet must come from here. */
  sentText: string;
  /**
   * `sentText` broken into contiguous runs of `fullText`. A snippet may be selected from
   * within ONE of these and never across two — see lib/tokens.ts.
   */
  segments: string[];
  /** Chosen deterministically before Phase 2. Always a substring of one segment. */
  snippet?: string;
  /** Week 2: which sub-question turned this up. */
  subQuestion?: number;
};

/**
 * Collects evidence as tools produce it. Dedupe and the 1..N numbering do NOT happen
 * here — they happen in evidence/merge.ts, which is the one place allowed to mint a
 * source (TECHSPEC §13). This is a bag, on purpose.
 */
export class EvidenceStore {
  private readonly items: EvidenceItem[] = [];

  add(...next: EvidenceItem[]): void {
    this.items.push(...next);
  }

  /** Everything collected, in arrival order. */
  all(): EvidenceItem[] {
    return [...this.items];
  }

  get size(): number {
    return this.items.length;
  }
}

/**
 * The dedupe key for a web page. Two URLs that differ only by tracking parameters, a
 * trailing slash, or a fragment are one page and must not become two citations.
 */
export function evidenceIdForUrl(rawUrl: string): string {
  try {
    const u = new URL(rawUrl);
    u.hash = '';
    u.hostname = u.hostname.replace(/^www\./, '');
    for (const key of [...u.searchParams.keys()]) {
      if (/^(utm_|fbclid|gclid|ref$|ref_|mc_|igshid)/i.test(key)) u.searchParams.delete(key);
    }
    const path = u.pathname.replace(/\/+$/, '') || '/';
    const qs = u.searchParams.toString();
    return `${u.protocol}//${u.hostname}${path}${qs ? `?${qs}` : ''}`.toLowerCase();
  } catch {
    return rawUrl.trim().toLowerCase();
  }
}
