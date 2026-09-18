/**
 * Spaces + document upload.
 *
 * Same 404-not-403 shape as `threads.routes.ts`: every lookup filters by `{_id, userId}`,
 * so a Space or document that does not exist and one that belongs to somebody else read
 * back identically.
 *
 * The upload route does the LEAST possible work in the request path — store the bytes in
 * GridFS, insert a `pending` document row and a `jobs` row, answer `202` — and nothing
 * else. Parsing, chunking, and embedding all happen on the worker (`worker.ts`), which is
 * the whole point of §5.4's "never in the request path": `accept_202_p95_ms` in
 * `benchmark/sla.json` is measured on THIS handler, not on how long indexing takes.
 */
import { Router, type Request, type Response } from 'express';
import multer, { MulterError } from 'multer';
import {
  ACCEPTED_UPLOAD_TYPES,
  CreateSpaceBody,
  MAX_UPLOAD_BYTES,
  SpaceId,
  newId,
  type CreateSpaceResponse,
  type DocumentRow,
  type ListDocumentsResponse,
  type ListSpacesResponse,
  type SpaceDoc,
  type DocumentDoc,
  type UploadDocumentResponse
} from '@lumina/contract';
import { insertDocument, listDocuments } from '../repo/documents.js';
import { insertJob } from '../repo/jobs.js';
import { findSpace, insertSpace, listSpaces } from '../repo/spaces.js';
import { uploadBuffer } from '../repo/uploads.js';
import { requireUser } from './auth.js';

export const spacesRouter: Router = Router();

/** A picker, same reasoning as `THREAD_LIST_LIMIT` in threads.routes.ts. */
const SPACE_LIST_LIMIT = 50;

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: MAX_UPLOAD_BYTES },
  fileFilter: (_req, file, cb) => {
    if ((ACCEPTED_UPLOAD_TYPES as readonly string[]).includes(file.mimetype)) {
      cb(null, true);
      return;
    }
    cb(new Error(`unsupported file type: ${file.mimetype}. Accepted: ${ACCEPTED_UPLOAD_TYPES.join(', ')}`));
  }
});

/**
 * Wraps `upload.single('file')` so a bad upload answers the contract's own status codes
 * (400 bad type, 413 too big) instead of falling through to the generic 502 handler in
 * `index.ts`, which is reserved for a provider or driver throwing, not a malformed request.
 */
function handleUpload(req: Request, res: Response, next: (err?: unknown) => void): void {
  upload.single('file')(req, res, (err: unknown) => {
    if (!err) {
      next();
      return;
    }
    if (err instanceof MulterError && err.code === 'LIMIT_FILE_SIZE') {
      res.status(413).json({ error: `file too large, limit ${MAX_UPLOAD_BYTES} bytes`, status: 413 });
      return;
    }
    res.status(400).json({ error: err instanceof Error ? err.message : String(err), status: 400 });
  });
}

// ---------------------------------------------------------------- POST /spaces

spacesRouter.post('/spaces', async (req: Request, res: Response) => {
  const userId = requireUser(req, res);
  if (!userId) return;

  const body = CreateSpaceBody.safeParse(req.body ?? {});
  if (!body.success) {
    res.status(400).json({ error: body.error.issues[0]?.message ?? 'invalid body', status: 400 });
    return;
  }

  const space: SpaceDoc = {
    _id: newId('spc'),
    userId,
    name: body.data.name.trim(),
    createdAt: new Date().toISOString()
  };
  await insertSpace(space);

  const response: CreateSpaceResponse = { spaceId: space._id, name: space.name };
  res.status(201).json(response);
});

// ---------------------------------------------------------------- GET /spaces

spacesRouter.get('/spaces', async (req: Request, res: Response) => {
  const userId = requireUser(req, res);
  if (!userId) return;

  const rows = await listSpaces(userId, SPACE_LIST_LIMIT);
  const body: ListSpacesResponse = {
    spaces: rows.map((s) => ({ spaceId: s._id, name: s.name, createdAt: isoOf(s.createdAt) }))
  };
  res.json(body);
});

// ---------------------------------------------------------------- POST /spaces/:spaceId/documents

spacesRouter.post('/spaces/:spaceId/documents', handleUpload, async (req: Request, res: Response) => {
  const userId = requireUser(req, res);
  if (!userId) return;

  const spaceId = SpaceId.safeParse(req.params.spaceId);
  if (!spaceId.success) {
    res.status(404).json({ error: `no space ${req.params.spaceId}`, status: 404 });
    return;
  }
  const space = await findSpace(spaceId.data, userId);
  if (!space) {
    res.status(404).json({ error: `no space ${spaceId.data}`, status: 404 });
    return;
  }

  const file = req.file;
  if (!file) {
    res.status(400).json({ error: 'multipart field "file" is required', status: 400 });
    return;
  }

  const { fileId, bytes } = await uploadBuffer(file.originalname, file.mimetype, file.buffer);

  const doc: DocumentDoc = {
    _id: newId('doc'),
    spaceId: spaceId.data,
    userId,
    title: file.originalname,
    mimeType: file.mimetype,
    bytes,
    status: 'pending',
    pct: 0,
    fileId,
    createdAt: new Date().toISOString()
  };
  await insertDocument(doc);
  await insertJob('index_document', userId, {
    docId: doc._id,
    spaceId: spaceId.data,
    userId,
    fileId,
    mimeType: file.mimetype
  });

  const response: UploadDocumentResponse = { docId: doc._id, status: 'pending' };
  res.status(202).json(response);
});

// ---------------------------------------------------------------- GET /spaces/:spaceId/documents

spacesRouter.get('/spaces/:spaceId/documents', async (req: Request, res: Response) => {
  const userId = requireUser(req, res);
  if (!userId) return;

  const spaceId = SpaceId.safeParse(req.params.spaceId);
  if (!spaceId.success) {
    res.status(404).json({ error: `no space ${req.params.spaceId}`, status: 404 });
    return;
  }
  const space = await findSpace(spaceId.data, userId);
  if (!space) {
    res.status(404).json({ error: `no space ${spaceId.data}`, status: 404 });
    return;
  }

  const rows = await listDocuments(spaceId.data, userId);
  const body: ListDocumentsResponse = {
    documents: rows.map(
      (d): DocumentRow => ({
        docId: d._id,
        title: d.title,
        status: d.status,
        pct: d.pct,
        ...(d.pages !== undefined ? { pages: d.pages } : {}),
        ...(d.chunks !== undefined ? { chunks: d.chunks } : {}),
        ...(d.error ? { error: d.error } : {})
      })
    )
  };
  res.json(body);
});

/** Stored as an ISO string; `z.date()` is in the contract's union, so accept one either way. */
const isoOf = (v: string | Date): string => (typeof v === 'string' ? v : v.toISOString());
