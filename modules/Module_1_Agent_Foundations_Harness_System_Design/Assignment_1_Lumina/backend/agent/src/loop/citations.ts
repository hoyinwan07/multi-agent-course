/**
 * The structural citation guard (TECHSPEC §6.5).
 *
 * The prompt tells the model the exact valid range, and the model mostly listens. "Mostly"
 * is not a grounding guarantee: `unresolvedCitations()` in the contract is the check the
 * bench runs, and one `[7]` in a four-source answer is the automatic-fail case.
 *
 * So the range is enforced on the wire rather than in the prompt. The stream is fed
 * through this filter character by character: output is held the moment a `[` appears and
 * released when the bracket closes. If the enclosed number is not one we emitted in
 * `sources`, the marker is dropped and the surrounding prose flows on.
 *
 * Why this does not cost TTFT: the hold engages only when a `[` arrives, which is never
 * the first character of an answer. The first token is released as soon as it exists.
 *
 * Why `dropped` is kept rather than silently swallowed: if the guard ever fires, the
 * prompt is not doing its job, and that belongs in the logs. A guard that quietly cleans
 * up after a misbehaving model is a guard that hides a regression.
 */

/** `citationNumbers()` in the contract matches `\[(\d{1,3})\]`. More digits is not a citation. */
const MAX_DIGITS = 3;

export class CitationFilter {
  /** Held output. Always starts with `[` and holds only digits after it. */
  private pending = '';
  private readonly valid: Set<number>;

  /** Every marker that was removed, verbatim. Empty on a well-behaved run. */
  readonly dropped: string[] = [];

  constructor(validNumbers: Iterable<number>) {
    this.valid = new Set(validNumbers);
  }

  /** Feed a stream chunk; get back the text that is safe to send. May be empty. */
  push(chunk: string): string {
    let out = '';

    for (const ch of chunk) {
      if (this.pending) {
        if (ch === ']') {
          out += this.close();
          continue;
        }
        if (ch >= '0' && ch <= '9' && this.pending.length <= MAX_DIGITS) {
          this.pending += ch;
          continue;
        }
        // What we were holding is not a citation after all — `[see also`, `[12x`, `[1234`.
        // Release it verbatim, then handle this character as a fresh one.
        out += this.pending;
        this.pending = '';
      }

      if (ch === '[') this.pending = '[';
      else out += ch;
    }

    return out;
  }

  /** The stream ended mid-hold (`…as reported [`). Release it rather than lose it. */
  flush(): string {
    const rest = this.pending;
    this.pending = '';
    return rest;
  }

  /** A `]` arrived while holding. Decide whether the marker survives. */
  private close(): string {
    const digits = this.pending.slice(1);
    this.pending = '';

    // `[]` is not a citation and never was. Pass it through untouched: rewriting prose
    // this class was only meant to police is a different bug from the one it prevents.
    if (!digits) return '[]';

    const marker = `[${digits}]`;
    if (this.valid.has(Number(digits))) return marker;

    this.dropped.push(marker);
    return '';
  }
}
