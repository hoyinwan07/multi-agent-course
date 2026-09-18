/**
 * The `spaces` collection, and the only file allowed to touch it (the `repo/` rule,
 * TECHSPEC §3).
 *
 * A Space is just a name plus a `userId` — the container `documents` and `chunks` hang off
 * of by `spaceId`. Same 404-not-403 shape as `repo/threads.ts`: a Space that does not exist
 * and a Space belonging to somebody else must read back identically.
 */
import { COLLECTIONS, type SpaceDoc } from '@lumina/contract';
import { db } from '../db.js';

type SpaceRow = SpaceDoc & { _id: string };

const spaces = async () => (await db()).collection<SpaceRow>(COLLECTIONS.spaces);

export async function insertSpace(doc: SpaceDoc): Promise<void> {
  const rows = await spaces();
  const { _id, ...body } = doc;
  await rows.replaceOne({ _id }, body as SpaceRow, { upsert: true });
}

/** null means 404 — including a Space that exists but belongs to somebody else. */
export async function findSpace(spaceId: string, userId: string): Promise<SpaceDoc | null> {
  const rows = await spaces();
  return (await rows.findOne({ _id: spaceId, userId })) as SpaceDoc | null;
}

export async function listSpaces(userId: string, limit: number): Promise<SpaceDoc[]> {
  const rows = await spaces();
  return (await rows.find({ userId }).sort({ createdAt: -1 }).limit(limit).toArray()) as SpaceDoc[];
}
