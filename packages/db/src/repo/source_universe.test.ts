import { afterAll, beforeEach, describe, expect, test } from 'bun:test';
import { sql } from '../client.ts';
import { upsertDamByExternalId } from './dams.ts';
import { upsertObservations } from './observations.ts';
import {
  classifyDamCoverage,
  classifyOneDam,
  coverageSummary,
  recordUniverse,
  recordUniverseHasData,
} from './source_universe.ts';

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

  test('once every observation source has a run, absence means 提供元なし', async () => {
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
    for (const r of remaining)
      await recordUniverse(r.source_id, [
        { externalId: `stub-${r.source_id}`, name: 'stub', resolvedDamId: null },
      ]);
    try {
      expect(only(await classifyDamCoverage(), absent)).toBe('not_published');
    } finally {
      await sql`DELETE FROM source_universe_runs WHERE source_id IN ${sql(remaining.map((r) => r.source_id))}`;
    }
  });

  test('a historical-only source does not hold the gate open', async () => {
    // `mudam` (NILIM dump, latest observation 2024-12-30) and
    // `kagoshima-bodik` (backfill-only, no crontab entry) publish no recurring
    // list to scan, so counting them in the gate keeps it open forever and the
    // whole feature never answers. Recording their dumps instead would label
    // ~500 dams 「取り込み側の不具合」 for data that is one to two years behind
    // by design — a false accusation against ourselves.
    await sql`UPDATE source_priorities SET historical_only = TRUE WHERE source_id = ${SRC_B}`;
    await recordUniverse(SRC_A, [
      { externalId: 'a-1', name: 'univ-covered', resolvedDamId: covered },
      { externalId: 'a-2', name: 'univ-stale', resolvedDamId: stale },
    ]);

    const remaining = await sql<{ source_id: string }[]>`
      SELECT sp.source_id FROM source_priorities sp
      WHERE sp.active AND sp.provides_observations AND sp.universe_enumerable
        AND NOT sp.historical_only
        AND NOT EXISTS (SELECT 1 FROM source_universe_runs r WHERE r.source_id = sp.source_id)
    `;
    // SRC_B is historical-only, so it must not appear in the gate's backlog.
    expect(remaining.map((r) => r.source_id)).not.toContain(SRC_B);

    for (const r of remaining)
      await recordUniverse(r.source_id, [
        { externalId: `stub-${r.source_id}`, name: 'stub', resolvedDamId: null },
      ]);
    try {
      // SRC_B still has no run, and the answer lands anyway.
      expect(only(await classifyDamCoverage(), absent)).toBe('not_published');
    } finally {
      await sql`DELETE FROM source_universe_runs WHERE source_id IN ${sql(remaining.map((r) => r.source_id))}`;
    }
  });

  test('a retired source does not hold the gate open', async () => {
    // niigata-bousai and shizuoka-bousai were retired (active = false, 0101)
    // because their robots.txt disallows crawling. They will never record
    // another scan, so counting them would keep every dam 未調査 for good.
    await sql`UPDATE source_priorities SET active = FALSE WHERE source_id = ${SRC_B}`;
    await recordUniverse(SRC_A, [
      { externalId: 'a-1', name: 'univ-covered', resolvedDamId: covered },
      { externalId: 'a-2', name: 'univ-stale', resolvedDamId: stale },
    ]);

    const remaining = await sql<{ source_id: string }[]>`
      SELECT sp.source_id FROM source_priorities sp
      WHERE sp.active AND sp.provides_observations AND sp.universe_enumerable
        AND NOT sp.historical_only
        AND NOT EXISTS (SELECT 1 FROM source_universe_runs r WHERE r.source_id = sp.source_id)
    `;
    for (const r of remaining)
      await recordUniverse(r.source_id, [
        { externalId: `stub-${r.source_id}`, name: 'stub', resolvedDamId: null },
      ]);
    try {
      expect((await coverageSummary()).sourcesPendingScan).toBe(0);
      expect(only(await classifyDamCoverage(), absent)).toBe('not_published');
    } finally {
      await sql`DELETE FROM source_universe_runs WHERE source_id IN ${sql(remaining.map((r) => r.source_id))}`;
    }
  });

  test('names each source holding the gate open, and why', async () => {
    // A bare count leaves the reader hunting for which provider to fix. The
    // reason separates "its task is not producing anything" (first run
    // pending or failing) from "it ingests but never records its list" (the
    // task is missing its recordUniverse call, or every call comes back empty).
    await recordUniverse(SRC_A, [
      { externalId: 'a-1', name: 'univ-covered', resolvedDamId: covered },
    ]);
    const pendingB = async () =>
      (await coverageSummary()).pendingScanSources.find((p) => p.sourceId === SRC_B);

    const first = await coverageSummary();
    expect(first.pendingScanSources.map((p) => p.sourceId)).not.toContain(SRC_A);
    expect(first.sourcesPendingScan).toBe(first.pendingScanSources.length);
    expect((await pendingB())?.reason).toBe('no_recent_observations');

    // Same 30-day window as 取得済み: a task that stopped long ago is not ingesting.
    const DAY = 86_400_000;
    await upsertObservations([
      {
        observedAt: new Date(Date.now() - 31 * DAY),
        damId: stale,
        sourceId: SRC_B,
        storageVolumeM3: 1,
      },
    ]);
    expect((await pendingB())?.reason).toBe('no_recent_observations');

    await upsertObservations([
      {
        observedAt: new Date(Date.now() - 29 * DAY),
        damId: stale,
        sourceId: SRC_B,
        storageVolumeM3: 1,
      },
    ]);
    expect((await pendingB())?.reason).toBe('ingesting_without_list');

    // Excluded from the gate means excluded from the list too.
    await sql`UPDATE source_priorities SET historical_only = TRUE WHERE source_id = ${SRC_B}`;
    expect(await pendingB()).toBeUndefined();
    await sql`UPDATE source_priorities SET historical_only = FALSE WHERE source_id = ${SRC_B}`;

    await recordUniverse(SRC_B, [{ externalId: 'b-stub', name: 'stub', resolvedDamId: null }]);
    expect(await pendingB()).toBeUndefined();
  });

  test("a retired source's last list is neither an ingestion bug nor backlog", async () => {
    // A retired source's universe rows stay behind with the resolution of its
    // last run. Its dams must not be reported as 「取り込み側の不具合で、
    // こちらで直せる」 — we stopped on purpose — and its unmatched stations are
    // no longer work we can do.
    await recordUniverse(SRC_B, [
      { externalId: 'b-stale', name: 'univ-stale', resolvedDamId: stale },
      { externalId: 'b-unmatched', name: 'マスタ未登録', resolvedDamId: null },
    ]);
    const before = await coverageSummary();
    await sql`UPDATE source_priorities SET active = FALSE WHERE source_id = ${SRC_B}`;

    const row = (await classifyDamCoverage()).find((r) => r.damId === stale);
    expect(row?.status).not.toBe('published_not_ingested');
    expect(row?.publishedBy).toEqual([]);
    const one = await classifyOneDam(stale);
    expect(one?.status).toBe(row?.status);
    expect(one?.publishedBy).toEqual([]);
    expect((await coverageSummary()).unmatchedStations).toBe(before.unmatchedStations - 1);
  });

  test('separates "we have data" from "published but we are not ingesting it"', async () => {
    await recordUniverse(SRC_A, [
      { externalId: 'a-1', name: 'univ-covered', resolvedDamId: covered },
      { externalId: 'a-2', name: 'univ-stale', resolvedDamId: stale },
    ]);
    await recordUniverse(SRC_B, [{ externalId: 'b-stub', name: 'stub', resolvedDamId: null }]);
    const rows = await classifyDamCoverage();
    expect(only(rows, covered)).toBe('covered');
    // Published and matched, but no observation has landed — the actionable bug.
    expect(only(rows, stale)).toBe('published_not_ingested');
  });

  test('an observation row with every quantity NULL is not coverage', async () => {
    // kasenbosai-v2 used to store an all-NULL row per hour for stations whose
    // every reading is flagged 欠測, and 21 dams were "covered" by nothing but
    // those rows. A row carrying no value is not data we have.
    await recordUniverse(SRC_A, [
      { externalId: 'a-1', name: 'univ-covered', resolvedDamId: covered },
      { externalId: 'a-2', name: 'univ-stale', resolvedDamId: stale },
    ]);
    await recordUniverse(SRC_B, [{ externalId: 'b-stub', name: 'stub', resolvedDamId: null }]);
    await upsertObservations([{ observedAt: new Date(), damId: stale, sourceId: SRC_A }]);
    expect(only(await classifyDamCoverage(), stale)).toBe('published_not_ingested');
    expect((await classifyOneDam(stale))?.status).toBe('published_not_ingested');

    // Any one non-NULL quantity, rainfall included, is coverage.
    await upsertObservations([
      { observedAt: new Date(Date.now() - 3600_000), damId: stale, sourceId: SRC_A, rainfallMm: 0 },
    ]);
    expect(only(await classifyDamCoverage(), stale)).toBe('covered');
    expect((await classifyOneDam(stale))?.status).toBe('covered');
  });

  test('a dam its publishers list with no value is 提供元に値なし, not an ingestion bug', async () => {
    // 鉄山 / 坂下 (調査対象外) and 滝波 (every column "---") are on their
    // provider's page with nothing in the value cells. Calling that
    // 「取り込み側の不具合」 accuses ourselves of a bug there is no fix for.
    await recordUniverse(SRC_A, [
      { externalId: 'a-1', name: 'univ-covered', resolvedDamId: covered, hasData: false },
      { externalId: 'a-2', name: 'univ-stale', resolvedDamId: stale, hasData: false },
    ]);
    const before = await coverageSummary();
    const rows = await classifyDamCoverage();
    expect(only(rows, stale)).toBe('published_no_data');
    expect(rows.find((r) => r.damId === stale)?.publishedBy).toEqual([SRC_A]);
    // Data that does arrive (from anywhere) still wins.
    expect(only(rows, covered)).toBe('covered');
    expect((await classifyOneDam(stale))?.status).toBe('published_no_data');

    await recordUniverse(SRC_A, [
      { externalId: 'a-2', name: 'univ-stale', resolvedDamId: stale, hasData: true },
    ]);
    const after = await coverageSummary();
    expect(after.publishedNoData).toBe(before.publishedNoData - 1);
    expect(after.publishedNotIngested).toBe(before.publishedNotIngested + 1);
  });

  test('one publisher that may carry values keeps the dam an ingestion bug', async () => {
    // A provider we cannot vouch for is exactly where the missing data might
    // be, so "no data" needs every publisher to say so.
    await recordUniverse(SRC_A, [
      { externalId: 'a-2', name: 'univ-stale', resolvedDamId: stale, hasData: false },
    ]);
    await recordUniverse(SRC_B, [{ externalId: 'b-2', name: 'univ-stale', resolvedDamId: stale }]);
    expect(only(await classifyDamCoverage(), stale)).toBe('published_not_ingested');
    expect((await classifyOneDam(stale))?.status).toBe('published_not_ingested');
  });

  test('a later unreadable row clears an earlier "no data"', async () => {
    // A row that stops parsing may be our parser breaking. Keeping last
    // week's "provider marks it empty" would hide that under 提供元に値なし,
    // so the latest scan's answer always wins — unknown included.
    await recordUniverse(SRC_A, [
      { externalId: 'a-2', name: 'univ-stale', resolvedDamId: stale, hasData: false },
    ]);
    await recordUniverse(SRC_A, [
      { externalId: 'a-2', name: 'univ-stale', resolvedDamId: stale, hasData: null },
    ]);
    expect(only(await classifyDamCoverage(), stale)).toBe('published_not_ingested');
  });

  test('a value reader can say "no data" for rows the catalogue task listed', async () => {
    // kasenbosai's list comes from the weekly catalogue sweep, which sees no
    // values; the hourly value fetch is what sees 滝波 / 和知 flag every
    // reading 欠測. Its answer has to land on the rows the sweep recorded.
    await recordUniverse(SRC_A, [{ externalId: 'a-2', name: 'univ-stale', resolvedDamId: stale }]);
    await recordUniverseHasData(SRC_A, [
      { externalId: 'a-2', hasData: false },
      { externalId: 'a-not-listed', hasData: false },
    ]);
    expect(only(await classifyDamCoverage(), stale)).toBe('published_no_data');
    // It only annotates the list; it never adds a station the sweep did not see.
    const [n] = await sql<{ n: number }[]>`
      SELECT COUNT(*)::INT AS n FROM source_universe WHERE source_id = ${SRC_A}
    `;
    expect(n?.n).toBe(1);

    // The next catalogue sweep cannot tell, so it must not wipe the answer...
    await recordUniverse(SRC_A, [{ externalId: 'a-2', name: 'univ-stale', resolvedDamId: stale }], {
      keepHasData: true,
    });
    expect(only(await classifyDamCoverage(), stale)).toBe('published_no_data');
    // ...while the value reader's own later "unknown" still clears it.
    await recordUniverseHasData(SRC_A, [{ externalId: 'a-2', hasData: null }]);
    expect(only(await classifyDamCoverage(), stale)).toBe('published_not_ingested');
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

  test('unmatched published stations are reported as the actionable backlog', async () => {
    await recordUniverse(SRC_A, [
      { externalId: 'a-9', name: '提供元にあるがマスタ未登録', resolvedDamId: null },
    ]);
    const rows = await sql<{ n: bigint }[]>`
      SELECT COUNT(*)::BIGINT AS n FROM source_universe
      WHERE source_id = ${SRC_A} AND resolved_dam_id IS NULL
    `;
    expect(Number(rows[0]?.n)).toBe(1);
  });

  test('a station marked not-a-dam leaves the backlog and survives re-scans', async () => {
    const list = [
      { externalId: 'a-weir', name: '〇〇堰', resolvedDamId: null },
      { externalId: 'a-open', name: 'マスタ未登録', resolvedDamId: null },
    ];
    await recordUniverse(SRC_A, list);
    const before = await coverageSummary();

    // The convention later migrations use (AGENTS.md gotcha 7).
    await sql`
      UPDATE source_universe SET not_dam_reason = '堰: NDI master has no such dam'
      WHERE source_id = ${SRC_A} AND source_external_id = 'a-weir' AND resolved_dam_id IS NULL
    `;
    const marked = await coverageSummary();
    expect(marked.unmatchedStations).toBe(before.unmatchedStations - 1);
    expect(marked.notDamStations).toBe(before.notDamStations + 1);

    // The next scan re-records the same row; the reason is not the scan's to clear.
    await recordUniverse(SRC_A, list);
    const rows = await sql<{ reason: string | null }[]>`
      SELECT not_dam_reason AS reason FROM source_universe
      WHERE source_id = ${SRC_A} AND source_external_id = 'a-weir'
    `;
    expect(rows[0]?.reason).toBe('堰: NDI master has no such dam');
    expect((await coverageSummary()).unmatchedStations).toBe(marked.unmatchedStations);

    // A later match wins over the mark: the station is linked, not "not a dam".
    await recordUniverse(SRC_A, [{ externalId: 'a-weir', name: '〇〇堰', resolvedDamId: covered }]);
    const resolved = await coverageSummary();
    expect(resolved.notDamStations).toBe(before.notDamStations);
    expect(resolved.unmatchedStations).toBe(marked.unmatchedStations);
  });

  test('an empty list is a failed scan, not a scanned provider', async () => {
    // A transient upstream outage must not be able to close the honesty gate.
    await recordUniverse(SRC_A, []);
    const runs = await sql<{ n: bigint }[]>`
      SELECT COUNT(*)::BIGINT AS n FROM source_universe_runs WHERE source_id = ${SRC_A}
    `;
    expect(Number(runs[0]?.n)).toBe(0);
  });

  test('tolerates a provider listing the same station twice', async () => {
    // Real providers repeat: the same dam under both 水道用 and 工業用水
    // tables, or the same names in every monthly ZIP. Postgres rejects a
    // duplicate ON CONFLICT target in one statement, and callers run this
    // before upsertObservations — so a throw here would also lose the
    // observations.
    const n = await recordUniverse(SRC_A, [
      { externalId: 'dup', name: 'first', resolvedDamId: null },
      { externalId: 'dup', name: 'second', resolvedDamId: covered },
      { externalId: 'other', name: 'other', resolvedDamId: null },
    ]);
    expect(n).toBe(2);
    const rows = await sql<{ name: string; resolved: bigint | null }[]>`
      SELECT source_name AS name, resolved_dam_id AS resolved
      FROM source_universe WHERE source_id = ${SRC_A} AND source_external_id = 'dup'
    `;
    expect(rows.length).toBe(1);
    expect(rows[0]?.name).toBe('second'); // last entry wins
    expect(rows[0]?.resolved).toBe(covered);
  });

  test('a failure never propagates to the caller', async () => {
    // Callers await this before upsertObservations, so a throw here would
    // cost the run its observations to protect metadata about them.
    // `source_name` is NOT NULL, so this row is rejected by Postgres.
    const bad = [{ externalId: 'boom', name: null as unknown as string, resolvedDamId: null }];
    expect(await recordUniverse(SRC_A, bad)).toBe(0);
    // …and the failed scan is not stamped either.
    const runs = await sql<{ n: bigint }[]>`
      SELECT COUNT(*)::BIGINT AS n FROM source_universe_runs WHERE source_id = ${SRC_A}
    `;
    expect(Number(runs[0]?.n)).toBe(0);
  });
});
