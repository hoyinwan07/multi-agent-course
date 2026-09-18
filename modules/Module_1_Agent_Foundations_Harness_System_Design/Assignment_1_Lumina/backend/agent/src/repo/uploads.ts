/**
 * GridFS, and the only file allowed to touch the `uploads` bucket (the `repo/` rule,
 * TECHSPEC §3, extended to GridFS the same way it applies to a collection).
 *
 * The raw upload lives here so the request path never holds a parsed PDF in memory longer
 * than it takes to write the bytes: `uploadBuffer` is a store-and-forget, and everything
 * CPU-heavy (parsing, chunking, embedding) happens later, on the worker, reading the bytes
 * back out with `downloadBuffer`.
 */
import { GridFSBucket, ObjectId } from 'mongodb';
import { GRIDFS_BUCKETS } from '@lumina/contract';
import { db } from '../db.js';

const bucket = async () => new GridFSBucket(await db(), { bucketName: GRIDFS_BUCKETS.uploads });

export async function uploadBuffer(
  filename: string,
  mimeType: string,
  data: Buffer
): Promise<{ fileId: string; bytes: number }> {
  const gfs = await bucket();
  const fileId = new ObjectId();
  await new Promise<void>((resolve, reject) => {
    const stream = gfs.openUploadStreamWithId(fileId, filename, { contentType: mimeType });
    stream.end(data, (err?: Error | null) => (err ? reject(err) : resolve()));
  });
  return { fileId: fileId.toHexString(), bytes: data.length };
}

export async function downloadBuffer(fileId: string): Promise<Buffer> {
  const gfs = await bucket();
  const chunks: Buffer[] = [];
  await new Promise<void>((resolve, reject) => {
    gfs
      .openDownloadStream(new ObjectId(fileId))
      .on('data', (chunk: Buffer) => chunks.push(chunk))
      .on('error', reject)
      .on('end', resolve);
  });
  return Buffer.concat(chunks);
}
