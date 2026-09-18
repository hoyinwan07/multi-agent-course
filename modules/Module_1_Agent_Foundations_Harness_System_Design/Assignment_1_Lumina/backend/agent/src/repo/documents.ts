/**
 * The `documents` collection, and the only file allowed to touch it (the `repo/` rule,
 * TECHSPEC §3).
 *
 * A document is inserted once, `pending`, by the upload route, and then owned by the jobs
 * worker for every status transition after that (§5.4: parsing → embedding → indexed, or
 * failed). `updateDocumentProgress` is a `$set`, never a replace, precisely so a crashed
 * worker's partial write (e.g. `pages` set, `chunks` not yet) is never clobbered back to
 * nothing by a later stage that only cares about `status` and `pct`.
 */
import { COLLECTIONS, type DocumentDoc } from '@lumina/contract';
import { db } from '../db.js';

type DocumentRow = DocumentDoc & { _id: string };

const documents = async () => (await db()).collection<DocumentRow>(COLLECTIONS.documents);

export async function insertDocument(doc: DocumentDoc): Promise<void> {
  const rows = await documents();
  const { _id, ...body } = doc;
  await rows.replaceOne({ _id }, body as DocumentRow, { upsert: true });
}

/** null means 404 — including a document that exists but belongs to somebody else. */
export async function findDocument(docId: string, userId: string): Promise<DocumentDoc | null> {
  const rows = await documents();
  return (await rows.findOne({ _id: docId, userId })) as DocumentDoc | null;
}

/** Scoped by userId AND spaceId: the worker knows both from the job payload. */
export async function findDocumentInSpace(
  docId: string,
  spaceId: string,
  userId: string
): Promise<DocumentDoc | null> {
  const rows = await documents();
  return (await rows.findOne({ _id: docId, spaceId, userId })) as DocumentDoc | null;
}

export async function listDocuments(spaceId: string, userId: string): Promise<DocumentDoc[]> {
  const rows = await documents();
  return (await rows.find({ spaceId, userId }).sort({ createdAt: 1 }).toArray()) as DocumentDoc[];
}

/** `search_documents` gets a docId + locator from `chunks`; the citable title lives here. */
export async function documentTitles(docIds: string[], userId: string): Promise<Map<string, string>> {
  if (!docIds.length) return new Map();
  const rows = await documents();
  const found = await rows
    .find({ _id: { $in: docIds }, userId }, { projection: { title: 1 } })
    .toArray();
  return new Map(found.map((d) => [d._id, d.title]));
}

export type DocumentProgress = Partial<
  Pick<DocumentDoc, 'status' | 'pct' | 'pages' | 'chunks' | 'error'>
>;

/** A partial update from the worker as a document moves through its stages. */
export async function updateDocumentProgress(docId: string, patch: DocumentProgress): Promise<void> {
  const rows = await documents();
  await rows.updateOne({ _id: docId }, { $set: patch });
}
