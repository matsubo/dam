import { sql } from '../client.ts';

export interface NewRawSnapshotInput {
  sourceId: string;
  targetId: string;
  fetchedAt: Date;
  storageUri: string;
  httpStatus?: number | null;
  etag?: string | null;
  bytes?: number | null;
  contentType?: string | null;
}

export async function recordRawSnapshot(input: NewRawSnapshotInput): Promise<bigint> {
  const rows = await sql<{ id: bigint }[]>`
    INSERT INTO raw_snapshots (source_id, target_id, fetched_at, storage_uri,
                               http_status, etag, bytes, content_type, parse_status)
    VALUES (${input.sourceId}, ${input.targetId}, ${input.fetchedAt}, ${input.storageUri},
            ${input.httpStatus ?? null}, ${input.etag ?? null}, ${input.bytes ?? null},
            ${input.contentType ?? null}, 'pending')
    ON CONFLICT (source_id, target_id, fetched_at) DO UPDATE SET
      storage_uri = EXCLUDED.storage_uri,
      http_status = EXCLUDED.http_status,
      etag = EXCLUDED.etag,
      bytes = EXCLUDED.bytes,
      content_type = EXCLUDED.content_type
    RETURNING id
  `;
  const row = rows[0];
  if (!row) throw new Error('recordRawSnapshot returned no row');
  return row.id;
}

export async function markParsed(id: bigint): Promise<void> {
  await sql`UPDATE raw_snapshots SET parse_status = 'parsed', parse_error = NULL WHERE id = ${id}`;
}

export async function markParseError(id: bigint, message: string): Promise<void> {
  await sql`UPDATE raw_snapshots SET parse_status = 'parse_error', parse_error = ${message} WHERE id = ${id}`;
}

export async function previousEtag(sourceId: string, targetId: string): Promise<string | null> {
  const rows = await sql<{ etag: string | null }[]>`
    SELECT etag FROM raw_snapshots
    WHERE source_id = ${sourceId} AND target_id = ${targetId}
    ORDER BY fetched_at DESC LIMIT 1
  `;
  return rows[0]?.etag ?? null;
}
