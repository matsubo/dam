// The ingest run: everything a scheduled `ingest:*` task does after it has
// read the provider (docs/superpowers/plans/2026-10-26-…, §2). A task file is
//
//   export default ingestTask(SOURCE_ID, async (log) => ({ entries }));
//
// and the run owns, for every source alike:
//   1. contract check of the scan (nothing written on a task bug)
//   2. one master query, then binding each entry (./bind.ts)
//   3. reading each entry in list order, outside any transaction; a reading
//      function that throws makes the entry unreadable, never drops it
//   4. one transaction: universe (has_data from the entry's state,
//      published_at for dated sources), stamps, observations
//   5. after the commit, failing the job when no entry could be read, so
//      graphile-worker retries it while the universe still says so

import { sourceById } from '@dam/core/sources';
import { sql } from '@dam/db/client';
import { bindExternalId } from '@dam/db/repo/dams';
import { upsertObservations } from '@dam/db/repo/observations';
import { recordUniverseOrThrow } from '@dam/db/repo/source_universe';
import type { Task } from 'graphile-worker';
import { type Binding, bindEntry, type Master } from './bind.ts';
import { type Plan, planWrites, type ReadEntry } from './plan.ts';
import { type Entry, IngestRunError, type Reading, type Scan } from './types.ts';

export type Log = (line: string) => void;
export type ScanFn = (log: Log) => Promise<Scan>;

const SOURCE_OF = new WeakMap<Task, string>();

/** The scheduled `ingest:*` task for one source. */
export function ingestTask(sourceId: string, scan: ScanFn): Task {
  const task: Task = async (_payload, helpers) => {
    await runScan(sourceId, scan, (line) => helpers.logger.info(line));
  };
  SOURCE_OF.set(task, sourceId);
  return task;
}

/** The source an ingestTask-built task records, else undefined. */
export function ingestSourceOf(task: Task): string | undefined {
  return SOURCE_OF.get(task);
}

function checkScan(sourceId: string, entries: readonly Entry[]): void {
  for (const e of entries) {
    if (!e.key.trim() || !e.name.trim()) {
      throw new IngestRunError('contract', `${sourceId}: entry with an empty key or name`);
    }
  }
}

function checkReading(sourceId: string, entry: Entry, reading: Reading): void {
  if (reading.state !== 'values') return;
  for (const o of reading.observations) {
    const bad =
      Number.isNaN(o.observedAt.getTime()) ||
      Object.values(o).some((v) => typeof v === 'number' && !Number.isFinite(v));
    if (bad) {
      throw new IngestRunError(
        'contract',
        `${sourceId}: ${entry.key} has an invalid date or a non-finite value`,
      );
    }
  }
}

async function loadMasters(sourceId: string, entries: readonly Entry[]): Promise<Master[]> {
  const prefs = [...new Set(entries.flatMap((e) => (e.pref === null ? [] : [e.pref].flat())))];
  const pins = entries.flatMap((e) =>
    e.bind && e.bind !== 'never' && 'ndi' in e.bind ? [e.bind.ndi] : [],
  );
  return sql<Master[]>`
    SELECT id, name, pref_code AS "prefCode", completed_year AS "completedYear",
           external_ids->>${sourceId} AS stamp, external_ids->>'ndi' AS ndi,
           total_capacity_m3::FLOAT8 AS "totalCapacityM3",
           active_capacity_m3::FLOAT8 AS "activeCapacityM3"
    FROM dams
    WHERE pref_code = ANY(${prefs}::TEXT[])
       OR external_ids->>'ndi' = ANY(${pins}::TEXT[])
       OR external_ids ? ${sourceId}
    ORDER BY id
  `;
}

async function notDamKeys(sourceId: string): Promise<Set<string>> {
  const rows = await sql<{ key: string }[]>`
    SELECT source_external_id AS key FROM source_universe
    WHERE source_id = ${sourceId} AND not_dam_reason IS NOT NULL
  `;
  return new Set(rows.map((r) => r.key));
}

async function readEntry(entry: Entry, binding: Binding): Promise<Reading> {
  if (typeof entry.reading !== 'function') return entry.reading;
  try {
    return await entry.reading(binding.dam);
  } catch (err) {
    return { state: 'unreadable', why: err instanceof Error ? err.message : String(err) };
  }
}

async function write(sourceId: string, plan: Plan): Promise<void> {
  await sql.begin(async (tx) => {
    await recordUniverseOrThrow(sourceId, plan.universe, false, tx);
    for (const s of plan.stamps) await bindExternalId(s.damId, sourceId, s.key, tx);
    await upsertObservations(plan.observations, tx);
  });
}

/** One scan of one source. Exported for the run suite; tasks use ingestTask. */
export async function runScan(sourceId: string, scan: ScanFn, log: Log): Promise<Plan | null> {
  const { entries, dated } = await scan(log);
  if (entries.length === 0) {
    if (sourceById(sourceId)?.universeEnumerable === false) {
      log(`${sourceId}: nothing listed (expected at times for this source)`);
      return null;
    }
    throw new IngestRunError('contract', `${sourceId}: the scan listed nothing`);
  }
  checkScan(sourceId, entries);

  const [masters, notDam] = await Promise.all([
    loadMasters(sourceId, entries),
    notDamKeys(sourceId),
  ]);
  const read: ReadEntry[] = [];
  for (const entry of entries) {
    const binding = bindEntry(entry, masters, notDam.has(entry.key));
    const reading = await readEntry(entry, binding);
    checkReading(sourceId, entry, reading);
    read.push({ entry, binding, reading });
  }

  const plan = planWrites(sourceId, read, dated === true);
  await write(sourceId, plan);

  for (const note of plan.notes) log(`${sourceId}: ${note}`);
  const c = plan.counts;
  log(
    `${sourceId}: listed=${c.listed} bound=${c.bound} values=${c.values} empty=${c.empty} ` +
      `unreadable=${c.unreadable} written=${c.written}`,
  );
  if (c.values === 0 && c.empty === 0) {
    throw new IngestRunError('nothing-read', `${sourceId}: no entry could be read`);
  }
  return plan;
}
