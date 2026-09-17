/**
 * The memory panel: list and delete.
 *
 * These two routes are the reason the memory feature is allowed to exist. "Nothing is
 * remembered that `GET /memory` does not show" (`SPEC.md §5.3`) is only a promise if there
 * is a single, complete listing — and "DELETE removes it and the effect disappears" is only
 * a promise if deleting is the same operation as forgetting, rather than a flag the recall
 * path is trusted to honour. It is: `deleteMemory` removes the row, and the row IS the
 * memory. There is no soft delete, no tombstone, and no second copy in a cache that would
 * keep answering with a preference the user has just withdrawn.
 *
 * 404 rather than 403 on somebody else's id, for the same reason `threads.routes.ts` does
 * it: a different status code for "exists but not yours" is an oracle for which ids exist.
 */
import { Router, type Request, type Response } from 'express';
import { MemoryId, type ListMemoryResponse, type Memory } from '@lumina/contract';
import { deleteMemory, listMemories } from '../repo/memories.js';
import { requireUser } from './auth.js';

export const memoryRouter: Router = Router();

/**
 * A panel, not an export. Fifty rows is already more standing preferences than any real
 * user has; a user who has somehow accumulated more needs pruning, not a longer page.
 */
const MEMORY_LIST_LIMIT = 50;

// ---------------------------------------------------------------- GET /memory

memoryRouter.get('/memory', async (req: Request, res: Response) => {
  const userId = requireUser(req, res);
  if (!userId) return;

  const rows = await listMemories(userId, MEMORY_LIST_LIMIT);
  const body: ListMemoryResponse = {
    memories: rows.map(
      (m): Memory => ({
        id: m._id,
        text: m.text,
        // `sourceThread` is provenance — the "why did you remember that?" link in SPEC
        // §5.3 — and never a recall filter. Recall is scoped by userId alone, which is
        // what lets a memory saved in thread A reach thread B at all.
        ...(m.sourceThread ? { sourceThread: m.sourceThread } : {}),
        createdAt: isoOf(m.createdAt)
      })
    )
  };
  res.json(body);
});

// ---------------------------------------------------------------- DELETE /memory/:memoryId

memoryRouter.delete('/memory/:memoryId', async (req: Request, res: Response) => {
  const userId = requireUser(req, res);
  if (!userId) return;

  const memoryId = MemoryId.safeParse(req.params.memoryId);
  if (!memoryId.success) {
    res.status(404).json({ error: `no memory ${req.params.memoryId}`, status: 404 });
    return;
  }

  const removed = await deleteMemory(memoryId.data, userId);
  if (!removed) {
    // Either it never existed or it is somebody else's. Deliberately the same answer.
    res.status(404).json({ error: `no memory ${memoryId.data}`, status: 404 });
    return;
  }

  // 204, per the contract: there is no body worth sending about a thing that is gone.
  res.status(204).end();
});

/** Stored as an ISO string; `z.date()` is in the contract's union, so accept one either way. */
const isoOf = (v: string | Date): string => (typeof v === 'string' ? v : v.toISOString());
