import { sql } from '../client.ts';

export async function nextPending(
  sourceId: string,
  limit = 10,
): Promise<{ damId: bigint; year: number }[]> {
  const rows = await sql<{ damId: bigint; year: number }[]>`
    SELECT dam_id AS "damId", year FROM backfill_progress
    WHERE source_id = ${sourceId} AND status = 'pending'
    ORDER BY year DESC LIMIT ${limit}
  `;
  return rows;
}

export async function startRunning(sourceId: string, damId: bigint, year: number): Promise<void> {
  await sql`
    UPDATE backfill_progress
    SET status = 'running', started_at = NOW(), attempts = attempts + 1
    WHERE source_id = ${sourceId} AND dam_id = ${damId} AND year = ${year}
  `;
}

export async function complete(
  sourceId: string,
  damId: bigint,
  year: number,
  rowsWritten: number,
): Promise<void> {
  await sql`
    UPDATE backfill_progress
    SET status = 'completed', completed_at = NOW(), rows_written = ${rowsWritten}, last_error = NULL
    WHERE source_id = ${sourceId} AND dam_id = ${damId} AND year = ${year}
  `;
}

export async function fail(
  sourceId: string,
  damId: bigint,
  year: number,
  msg: string,
): Promise<void> {
  await sql`
    UPDATE backfill_progress
    SET status = 'failed', last_error = ${msg}
    WHERE source_id = ${sourceId} AND dam_id = ${damId} AND year = ${year}
  `;
}

export async function enqueueAllDams(
  sourceId: string,
  fromYear: number,
  toYear: number,
): Promise<number> {
  const r = await sql`
    INSERT INTO backfill_progress (source_id, dam_id, year, status)
    SELECT ${sourceId}, d.id, y.year, 'pending'
    FROM dams d
    CROSS JOIN generate_series(${fromYear}, ${toYear}) AS y(year)
    ON CONFLICT (source_id, dam_id, year) DO NOTHING
  `;
  return r.count;
}
