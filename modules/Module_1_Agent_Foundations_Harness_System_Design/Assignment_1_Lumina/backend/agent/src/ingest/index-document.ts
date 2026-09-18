/**
 * The `index_document` job (§5.4, TECHSPEC): GridFS read → parse → chunk → embed →
 * `chunks` upsert → read-your-write probe → `indexed`. The only job kind LUMINA has
 * (`worker.ts`'s header comment). Every stage updates the document's `status`/`pct` so
 * `GET /spaces/{id}/documents` reflects real progress, not a guess.
 *
 * Anything thrown here is caught by the caller (`worker.ts`), which fails the job AND
 * writes the same message onto the document as `error` — "fail loud" applies to a
 * background job exactly as it does to a request (`lib/errors.ts`).
 */
import type { ChunkDoc, JobDoc } from '@lumina/contract';
import { embedBatch } from '../providers/embed.js';
import { downloadBuffer } from '../repo/uploads.js';
import { updateDocumentProgress } from '../repo/documents.js';
import { probeChunkIndexed, upsertChunks } from '../repo/chunks.js';
import { chunkSections } from './chunk.js';
import { parseDocument } from './parse.js';

type IndexDocumentPayload = {
  docId: string;
  spaceId: string;
  userId: string;
  fileId: string;
  mimeType: string;
};

/** OpenAI accepts far more per call; batching keeps one big PDF from becoming one giant request. */
const EMBED_BATCH_SIZE = 64;

/** The probe is polled, not asked once — Atlas Search indexes are eventually consistent. */
const PROBE_INTERVAL_MS = 1500;
const PROBE_TIMEOUT_MS = 30_000;

export async function indexDocument(job: JobDoc): Promise<void> {
  const payload = job.payload as IndexDocumentPayload;
  const { docId, spaceId, userId, fileId, mimeType } = payload;

  await updateDocumentProgress(docId, { status: 'parsing', pct: 10 });
  const data = await downloadBuffer(fileId);
  const { sections, pages } = await parseDocument(data, mimeType);

  const pieces = chunkSections(sections);
  if (!pieces.length) {
    throw new Error('no extractable text — the file may be a scanned image or empty');
  }
  await updateDocumentProgress(docId, { status: 'parsing', pct: 30, ...(pages ? { pages } : {}) });

  await updateDocumentProgress(docId, { status: 'embedding', pct: 40 });
  const vectors: number[][] = [];
  for (let i = 0; i < pieces.length; i += EMBED_BATCH_SIZE) {
    const batch = pieces.slice(i, i + EMBED_BATCH_SIZE);
    const embedded = await embedBatch(batch.map((p) => p.text));
    vectors.push(...embedded.map((e) => e.vector));
    await updateDocumentProgress(docId, {
      status: 'embedding',
      pct: 40 + Math.round((40 * Math.min(i + batch.length, pieces.length)) / pieces.length)
    });
  }

  const now = new Date().toISOString();
  const chunkDocs: ChunkDoc[] = pieces.map((piece, i) => ({
    _id: `${docId}_${piece.ord}`,
    docId,
    spaceId,
    userId,
    text: piece.text,
    locator: piece.locator,
    ord: piece.ord,
    embedding: vectors[i]!,
    createdAt: now
  }));
  await upsertChunks(chunkDocs);
  await updateDocumentProgress(docId, { status: 'embedding', pct: 90 });

  const probeTarget = chunkDocs[chunkDocs.length - 1]!;
  const indexed = await pollUntilIndexed({
    chunkId: probeTarget._id,
    spaceId,
    userId,
    vector: probeTarget.embedding
  });
  if (!indexed) {
    throw new Error(`chunk not searchable within ${PROBE_TIMEOUT_MS}ms of being written`);
  }

  await updateDocumentProgress(docId, {
    status: 'indexed',
    pct: 100,
    chunks: chunkDocs.length,
    ...(pages ? { pages } : {})
  });
}

async function pollUntilIndexed(args: {
  chunkId: string;
  spaceId: string;
  userId: string;
  vector: number[];
}): Promise<boolean> {
  const deadline = Date.now() + PROBE_TIMEOUT_MS;
  for (;;) {
    if (await probeChunkIndexed(args)) return true;
    if (Date.now() >= deadline) return false;
    await new Promise((resolve) => setTimeout(resolve, PROBE_INTERVAL_MS));
  }
}
