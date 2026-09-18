/**
 * Sub-divide each parsed section into embedding-sized chunks, in document order.
 *
 * A section keeps ONE locator (its page, heading, or line — §5.4), so splitting it further
 * never invents a more precise locator than we actually have; every piece of a long page
 * still cites back to that same page. `ord` is assigned across the whole document, not
 * per-section, so a later re-index can trust it as the read order.
 */
import { cutOnWordBoundary } from '../lib/tokens.js';
import type { ParsedSection } from './parse.js';

/** ~4 chars/token (lib/tokens.ts's own approximation): keeps chunks well inside embedding limits. */
const CHUNK_CHARS = 1200;
/** Enough overlap that a sentence split across a chunk boundary still has a home. */
const OVERLAP_CHARS = 150;

export type ChunkPiece = { text: string; locator: ParsedSection['locator']; ord: number };

export function chunkSections(sections: ParsedSection[]): ChunkPiece[] {
  const pieces: ChunkPiece[] = [];
  let ord = 0;

  for (const section of sections) {
    for (const text of splitToChunks(section.text)) {
      pieces.push({ text, locator: section.locator, ord: ord++ });
    }
  }
  return pieces;
}

function splitToChunks(text: string): string[] {
  if (text.length <= CHUNK_CHARS) return [text];

  const out: string[] = [];
  let start = 0;
  while (start < text.length) {
    const remaining = text.slice(start);
    const piece = cutOnWordBoundary(remaining, CHUNK_CHARS);
    out.push(piece);
    if (start + piece.length >= text.length) break;
    // Step forward by less than the piece length so the tail of this chunk re-appears at
    // the head of the next one — the overlap `OVERLAP_CHARS` promises.
    start += Math.max(piece.length - OVERLAP_CHARS, 1);
  }
  return out;
}
