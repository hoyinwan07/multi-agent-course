/**
 * Turn raw upload bytes into locator-tagged sections — one per PDF page, or one per
 * markdown heading / plain-text line block. `chunk.ts` sub-divides a section further if it
 * is long; it never merges two sections, because the locator is the section's identity and
 * a citation must resolve to exactly the page (or heading, or line) the text came from.
 *
 * PDF text extraction only — no rendering, so no canvas dependency needed in Node.
 */
import { createRequire } from 'node:module';
import type { Locator } from '@lumina/contract';

const require = createRequire(import.meta.url);

export type ParsedSection = { text: string; locator: Locator };
export type ParsedDocument = { sections: ParsedSection[]; pages?: number };

/** How many lines make up one citable block of a plain-text file. */
const TEXT_LINES_PER_SECTION = 40;

export async function parseDocument(data: Buffer, mimeType: string): Promise<ParsedDocument> {
  if (mimeType === 'application/pdf') return parsePdf(data);
  if (mimeType === 'text/markdown') return parseMarkdown(data.toString('utf8'));
  return parsePlainText(data.toString('utf8'));
}

async function parsePdf(data: Buffer): Promise<ParsedDocument> {
  // Imported lazily and only here: pdfjs-dist pulls in its worker script, and nothing else
  // in the service needs it. `.buffer`-free Uint8Array copy, because pdf.js takes ownership.
  const pdfjs = await import('pdfjs-dist/legacy/build/pdf.mjs');
  pdfjs.GlobalWorkerOptions.workerSrc = require.resolve('pdfjs-dist/legacy/build/pdf.worker.mjs');

  const doc = await pdfjs.getDocument({
    data: new Uint8Array(data),
    useWorkerFetch: false,
    isEvalSupported: false,
    disableFontFace: true,
    // We only call getTextContent(), never render a glyph — so a font pdf.js cannot load
    // (Node's fetch() does not serve file:// URLs, which is what its bundled standard
    // fonts resolve to) is not a real problem, just a noisy one. ERRORS-only verbosity
    // keeps that warning out of the worker's log without touching what gets extracted.
    verbosity: pdfjs.VerbosityLevel.ERRORS
  }).promise;

  const sections: ParsedSection[] = [];
  try {
    for (let page = 1; page <= doc.numPages; page++) {
      const pdfPage = await doc.getPage(page);
      const content = await pdfPage.getTextContent();
      const text = content.items
        .map((item) => ('str' in item ? item.str : ''))
        .join(' ')
        .replace(/\s+/g, ' ')
        .trim();
      if (text) sections.push({ text, locator: { page } });
    }
  } finally {
    await doc.destroy();
  }
  return { sections, pages: doc.numPages };
}

/** ATX headings (`#`..`######`) split the document; text before the first one is its own section. */
function parseMarkdown(text: string): ParsedDocument {
  const lines = text.split('\n');
  const sections: ParsedSection[] = [];
  let heading = '(untitled)';
  let buffer: string[] = [];

  const flush = () => {
    const body = buffer.join('\n').trim();
    if (body) sections.push({ text: body, locator: { heading } });
    buffer = [];
  };

  for (const line of lines) {
    const match = /^#{1,6}\s+(.+)$/.exec(line);
    if (match) {
      flush();
      heading = match[1]!.trim();
      continue;
    }
    buffer.push(line);
  }
  flush();

  return { sections };
}

function parsePlainText(text: string): ParsedDocument {
  const lines = text.split('\n');
  const sections: ParsedSection[] = [];
  for (let i = 0; i < lines.length; i += TEXT_LINES_PER_SECTION) {
    const block = lines.slice(i, i + TEXT_LINES_PER_SECTION).join('\n').trim();
    if (block) sections.push({ text: block, locator: { line: i + 1 } });
  }
  return { sections };
}
