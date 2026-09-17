/**
 * The `searchCache` collection — tier 2 of §7, and the only file that touches it.
 *
 * `expiresAt` is written as a BSON **Date**, not an ISO string. Mongo's TTL monitor only
 * understands a Date field: given a string it indexes it happily, sweeps nothing, and the
 * collection grows forever while every index check still says the TTL index exists. The
 * contract's `iso` is `z.union([z.string().datetime(), z.date()])`, so a Date satisfies it
 * — the union is there precisely so the storage type can be the one that works.
 */
import { COLLECTIONS, type SearchCacheDoc } from '@lumina/contract';
import { db } from '../db.js';

type SearchCacheRow = Omit<SearchCacheDoc, '_id'> & { _id: string };

export async function readSearchCache(key: string): Promise<SearchCacheDoc | null> {
  const rows = (await db()).collection<SearchCacheRow>(COLLECTIONS.searchCache);
  return (await rows.findOne({ _id: key })) as SearchCacheDoc | null;
}

export async function writeSearchCache(doc: SearchCacheDoc): Promise<void> {
  const rows = (await db()).collection<SearchCacheRow>(COLLECTIONS.searchCache);
  // `_id` travels in the filter, never in the replacement: it is immutable, and the
  // driver's types reject it in the body.
  const { _id, ...body } = doc;
  await rows.replaceOne({ _id }, body as SearchCacheRow, { upsert: true });
}
