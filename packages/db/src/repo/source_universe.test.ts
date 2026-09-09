import { afterAll, beforeEach, describe, expect, test } from 'bun:test';
import { sql } from '../client.ts';
import { upsertDamByExternalId } from './dams.ts';
import { upsertObservations } from './observations.ts';
import { classifyDamCoverage, recordUniverse } from './source_universe.ts';

const SRC_A = 'universe-test-a';
const SRC_B = 'universe-test-b';
const EXT = ['UNIV-1', 'UNIV-2', 'UNIV-3'];
let covered: bigint;
let stale: bigint;
let absent: bigint;

async function clean(): Promise<void> {
  await sql`DELETE FROM source_universe WHERE source_id IN (${SRC_A}, ${SRC_B})`;
  await sql`DELETE FROM source_universe_runs WHERE source_id IN (${SRC_A}, ${SRC_B})`;
  await sql`DELETE FROM source_priorities WHERE source_id IN (${SRC_A}, ${SRC_B})`;
}

beforeEach(async () => {
  await clean();
  // Observations hold an FK on dams — clear them before the dam rows, and
  // stay scoped to this file's fixture ids (never a blanket source filter).
  await sql`
    DELETE FROM observations WHERE dam_id IN (
      SELECT id FROM dams WHERE external_ids ->> 'ndi' IN ${sql(EXT)}
    )`;
  await sql`DELETE FROM dams WHERE external_ids ->> 'ndi' IN ${sql(EXT)}`;
  const mk = async (slug: string, ndi: string): Promise<bigint> =>
    upsertDamByExternalId('ndi', {
      slug,
      name: slug,
      prefCode: '13',
      lat: 35.7,
      lng: 139.5,
      externalIds: { ndi },
    });
  covered = await mk('univ-covered', 'UNIV-1');
  stale = await mk('univ-stale', 'UNIV-2');
  absent = await mk('univ-absent', 'UNIV-3');

  // Two observation-producing sources exist; only SRC_A gets instrumented.
  await sql`
    INSERT INTO source_priorities (source_id, priority, description, provides_observations)
    VALUES (${SRC_A}, 1, 'universe test A', TRUE), (${SRC_B}, 1, 'universe test B', TRUE)
    ON CONFLICT (source_id) DO UPDATE SET provides_observations = EXCLUDED.provides_observations
  `;
  await upsertObservations([
    { observedAt: new Date(), damId: covered, sourceId: SRC_A, storageVolumeM3: 1 },
  ]);
});

afterAll(async () => {
  for (const id of [covered, stale, absent]) {
    if (id !== undefined) {
      await sql`DELETE FROM observations WHERE dam_id = ${id}`;
      await sql`DELETE FROM dams WHERE id = ${id}`;
    }
  }
  await clean();
});

const only = (rows: { damId: bigint; status: string }[], id: bigint): string | undefined =>
  rows.find((r) => r.damId === id)?.status;

describe('source universe coverage triage', () => {
  test('a dam with no universe row is 未調査 while any source is uninstrumented', async () => {
    // Only SRC_A has recorded its published list; SRC_B never has. We
    // therefore cannot claim nobody publishes `absent` — that is the
    // false-negative this whole table exists to prevent.
    await recordUniverse(SRC_A, [
      { externalId: 'a-1', name: 'univ-covered', resolvedDamId: covered },
      { externalId: 'a-2', name: 'univ-stale', resolvedDamId: stale },
    ]);
    const rows = await classifyDamCoverage();
    expect(only(rows, absent)).toBe('unknown');
  });

  test('once every observation source has a run, absence means 提供なし', async () => {
    await recordUniverse(SRC_A, [
      { externalId: 'a-1', name: 'univ-covered', resolvedDamId: covered },
      { externalId: 'a-2', name: 'univ-stale', resolvedDamId: stale },
    ]);
    await recordUniverse(SRC_B, [
      { externalId: 'b-1', name: 'somewhere else', resolvedDamId: null },
    ]);
    // Still 未調査: the sources seeded by migrations (kasenbosai, suimon, …)
    // have not recorded a scan, so absence still proves nothing.
    expect(only(await classifyDamCoverage(), absent)).toBe('unknown');

    // Simulate the rollout finishing — every observation source scanned.
    const remaining = await sql<{ source_id: string }[]>`
      SELECT sp.source_id FROM source_priorities sp
      WHERE sp.active AND sp.provides_observations
        AND NOT EXISTS (SELECT 1 FROM source_universe_runs r WHERE r.source_id = sp.source_id)
    `;
    for (const r of remaining) await recordUniverse(r.source_id, []);
    try {
      expect(only(await classifyDamCoverage(), absent)).toBe('no_upstream');
    } finally {
      await sql`DELETE FROM source_universe_runs WHERE source_id IN ${sql(remaining.map((r) => r.source_id))}`;
    }
  });

  test('separates "we have data" from "published but we are not ingesting it"', async () => {
    await recordUniverse(SRC_A, [
      { externalId: 'a-1', name: 'univ-covered', resolvedDamId: covered },
      { externalId: 'a-2', name: 'univ-stale', resolvedDamId: stale },
    ]);
    await recordUniverse(SRC_B, []);
    const rows = await classifyDamCoverage();
    expect(only(rows, covered)).toBe('covered');
    // Published and matched, but no observation has landed — the actionable bug.
    expect(only(rows, stale)).toBe('published_not_ingested');
  });

  test('recordUniverse is idempotent and advances last_seen_at', async () => {
    await recordUniverse(SRC_A, [{ externalId: 'a-1', name: 'univ-covered', resolvedDamId: null }]);
    const first = await sql<{ first: Date; last: Date }[]>`
      SELECT first_seen_at AS first, last_seen_at AS last
      FROM source_universe WHERE source_id = ${SRC_A} AND source_external_id = 'a-1'
    `;
    await new Promise((r) => setTimeout(r, 10));
    // A later scan resolves the match; first_seen_at must not move.
    await recordUniverse(SRC_A, [
      { externalId: 'a-1', name: 'univ-covered', resolvedDamId: covered },
    ]);
    const rows = await sql<{ first: Date; last: Date; resolved: bigint | null }[]>`
      SELECT first_seen_at AS first, last_seen_at AS last, resolved_dam_id AS resolved
      FROM source_universe WHERE source_id = ${SRC_A} AND source_external_id = 'a-1'
    `;
    expect(rows.length).toBe(1);
    expect(rows[0]?.first.toISOString()).toBe(first[0]?.first.toISOString() ?? '');
    expect(rows[0]?.last.valueOf()).toBeGreaterThan(first[0]?.last.valueOf() ?? 0);
    expect(rows[0]?.resolved).toBe(covered);
  });

  test('unresolved upstream rows are reported as the actionable backlog', async () => {
    await recordUniverse(SRC_A, [
      { externalId: 'a-9', name: '上流にあるがマスタ未登録', resolvedDamId: null },
    ]);
    const rows = await sql<{ n: bigint }[]>`
      SELECT COUNT(*)::BIGINT AS n FROM source_universe
      WHERE source_id = ${SRC_A} AND resolved_dam_id IS NULL
    `;
    expect(Number(rows[0]?.n)).toBe(1);
  });
});
