import { GetObjectCommand, PutObjectCommand } from '@aws-sdk/client-s3';
import { bucket, s3 } from './client.ts';

export function rawSnapshotKey(
  source: string,
  targetId: string,
  fetchedAt: Date,
  ext: string,
): string {
  const yyyy = fetchedAt.getUTCFullYear();
  const mm = String(fetchedAt.getUTCMonth() + 1).padStart(2, '0');
  const dd = String(fetchedAt.getUTCDate()).padStart(2, '0');
  const hh = String(fetchedAt.getUTCHours()).padStart(2, '0');
  return `raw/${source}/${yyyy}/${mm}/${dd}/${hh}/${targetId}.${ext}`;
}

export async function putSnapshot(
  key: string,
  body: Uint8Array,
  contentType: string,
): Promise<void> {
  await s3.send(
    new PutObjectCommand({ Bucket: bucket, Key: key, Body: body, ContentType: contentType }),
  );
}

export async function getSnapshot(key: string): Promise<Uint8Array> {
  const r = await s3.send(new GetObjectCommand({ Bucket: bucket, Key: key }));
  if (!r.Body) throw new Error(`empty body for ${key}`);
  const chunks: Uint8Array[] = [];
  // @ts-expect-error: AsyncIterable<Uint8Array> from S3 client
  for await (const chunk of r.Body) chunks.push(chunk);
  const total = chunks.reduce((n, c) => n + c.byteLength, 0);
  const out = new Uint8Array(total);
  let o = 0;
  for (const c of chunks) {
    out.set(c, o);
    o += c.byteLength;
  }
  return out;
}
