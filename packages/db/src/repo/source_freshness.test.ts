import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { sql } from '../client.ts';
import { upsertDamByExternalId } from './dams.ts';
import { type StaleSource, staleSources } from './source_freshness.ts';

// Fixture sources. Each gets its own observation history on one fixture dam;
// the cron map and the overrides are injected so the cases don't depend on
// the real crontab.
const FAST = 'freshness-test-fast'; // hourly cron, 10-min data
const DAILY = 'freshness-test-daily'; // daily cron, 00:00 JST stamps fetched at noon JST
const WEEKLY = 'freshness-test-weekly'; // daily cron, weekly survey dates
const NO_CRON = 'freshness-test-no-cron'; // no cron line: cadence from the data
const OVERRIDDEN = 'freshness-test-override';
const SILENT = 'freshness-test-silent'; // override null: silence is normal
const HISTORICAL = 'freshness-test-historical';
const INACTIVE = 'freshness-test-inactive';
const UNREGISTERED = 'freshness-test-unregistered'; // cron line, never registered
const REGISTERED = [FAST, DAILY, WEEKLY, NO_CRON, OVERRIDDEN, SILENT, HISTORICAL, INACTIVE];

const CRON: Record<string, number> = {
  [FAST]: 1,
  [DAILY]: 24,
  [WEEKLY]: 24,
  [OVERRIDDEN]: 24,
  [SILENT]: 1,
  [INACTIVE]: 1,
  [UNREGISTERED]: 24,
};
const OVERRIDES: Record<string, number | null> = { [OVERRIDDEN]: 30, [SILENT]: null };

const HOUR = 3_600_000;
// A whole UTC hour a day ago, so the fixture rows land in recent chunks.
const T = new Date(Math.floor(Date.now() / HOUR) * HOUR - 24 * HOUR);
const at = (hoursFromT: number): Date => new Date(T.getTime() + hoursFromT * HOUR);

let damId: bigint;

async function insertSeries(
  sourceId: string,
  stamps: Date[],
  publicationLagHours: number,
): Promise<void> {
  const rows = stamps.map((observedAt) => ({
    observed_at: observedAt,
    dam_id: damId,
    source_id: sourceId,
    water_level_m: 100,
    created_at: new Date(observedAt.getTime() + publicationLagHours * HOUR),
  }));
  await sql`INSERT INTO observations ${sql(rows)}`;
}

const series = (count: number, stepHours: number, newest: number): Date[] =>
  Array.from({ length: count }, (_, i) => at(newest - i * stepHours));

async function clean(): Promise<void> {
  if (damId !== undefined) await sql`DELETE FROM observations WHERE dam_id = ${damId}`;
  await sql`DELETE FROM dams WHERE external_ids ->> 'ndi' = 'FRESHNESS-TEST-1'`;
  await sql`DELETE FROM source_priorities WHERE source_id IN ${sql(REGISTERED)}`;
}

beforeAll(async () => {
  await clean();
  damId = await upsertDamByExternalId('ndi', {
    slug: 'freshness-test-1',
    name: 'Freshness Test',
    prefCode: '13',
    lat: 35.7,
    lng: 139.5,
    externalIds: { ndi: 'FRESHNESS-TEST-1' },
  });
  await sql`
    INSERT INTO source_priorities ${sql(
      REGISTERED.map((source_id) => ({
        source_id,
        priority: 1,
        description: 'freshness test',
        active: source_id !== INACTIVE,
        historical_only: source_id === HISTORICAL,
      })),
    )}
  `;
  await insertSeries(FAST, series(30, 1 / 6, 0), 5 / 60);
  await insertSeries(DAILY, series(20, 24, 0), 12);
  await insertSeries(WEEKLY, series(5, 168, 0), 24);
  await insertSeries(NO_CRON, series(20, 6, 0), 1);
  await insertSeries(OVERRIDDEN, series(20, 24, 0), 12);
  await insertSeries(HISTORICAL, series(20, 24, -24 * 400), 24 * 400);
  await insertSeries(INACTIVE, series(20, 1, -500), 0);
});

afterAll(clean);

async function staleAt(hoursAfterNewest: number): Promise<Map<string, StaleSource>> {
  const rows = await staleSources({
    now: at(hoursAfterNewest),
    cronIntervalHours: CRON,
    overrideHours: OVERRIDES,
  });
  return new Map(rows.map((r) => [r.sourceId, r]));
}

describe('staleSources', () => {
  test('a fast source is stale after three missed runs plus its publication lag', async () => {
    // 10-minute stamps, polled hourly: the cron line, not the 10-minute data
    // spacing, is how often new rows can arrive.
    expect((await staleAt(3)).has(FAST)).toBe(false);
    const stale = (await staleAt(3.2)).get(FAST);
    expect(stale).toMatchObject({
      newestObservedAt: T,
      expectedIntervalHours: 1,
      cadenceBasis: 'cron',
    });
    expect(stale?.thresholdHours).toBeCloseTo(3 + 5 / 60, 5);
    expect(stale?.ageHours).toBeCloseTo(3.2, 5);
  });

  test('a daily source tolerates its noon fetch of a midnight stamp', async () => {
    // 3 × 24 h + the 12 h between the 00:00 JST stamp and the fetch.
    expect((await staleAt(84)).has(DAILY)).toBe(false);
    expect((await staleAt(85)).get(DAILY)).toMatchObject({
      expectedIntervalHours: 24,
      thresholdHours: 84,
      cadenceBasis: 'cron',
    });
  });

  test('a source polled daily but published weekly takes its cadence from the data', async () => {
    // With the cron's 24 h it would be flagged after 96 h, every week.
    expect((await staleAt(5 * 24)).has(WEEKLY)).toBe(false);
    expect((await staleAt(3 * 168 + 25)).get(WEEKLY)).toMatchObject({
      expectedIntervalHours: 168,
      thresholdHours: 3 * 168 + 24,
      cadenceBasis: 'observed',
    });
  });

  test('a source with no cron line takes its cadence from the data', async () => {
    expect((await staleAt(19)).has(NO_CRON)).toBe(false);
    expect((await staleAt(19.5)).get(NO_CRON)).toMatchObject({
      expectedIntervalHours: 6,
      thresholdHours: 19,
      cadenceBasis: 'observed',
    });
  });

  test('an override replaces the derived threshold', async () => {
    // Derived: 3 × 24 + 12 = 84 h. The override flags it at 30 h.
    expect((await staleAt(30)).has(OVERRIDDEN)).toBe(false);
    expect((await staleAt(31)).get(OVERRIDDEN)).toMatchObject({
      expectedIntervalHours: 24,
      thresholdHours: 30,
      cadenceBasis: 'override',
    });
  });

  test('a scheduled source that never wrote a row is stale, registered or not', async () => {
    const stale = await staleAt(0);
    expect(stale.get(UNREGISTERED)).toMatchObject({
      newestObservedAt: null,
      ageHours: null,
      expectedIntervalHours: 24,
      thresholdHours: 72,
      cadenceBasis: 'cron',
    });
  });

  test('silent-by-design, historical-only and inactive sources are never listed', async () => {
    const stale = await staleAt(24 * 365);
    expect(stale.has(SILENT)).toBe(false);
    expect(stale.has(HISTORICAL)).toBe(false);
    expect(stale.has(INACTIVE)).toBe(false);
    // …while the others are, by then.
    expect([FAST, DAILY, WEEKLY, NO_CRON, OVERRIDDEN].every((s) => stale.has(s))).toBe(true);
  });
});
