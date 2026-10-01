import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { sql } from '../client.ts';
import {
  coverageHeadline,
  historicalCoveragePct,
  realtimeCoveragePct,
  storageRateCoveragePct,
} from './coverage.ts';
import { upsertDamByExternalId } from './dams.ts';
import { upsertObservations } from './observations.ts';
import { classifyDamCoverage, recordUniverse } from './source_universe.ts';

// Two different questions get called "カバレッジ" on the site and they must
// stay distinct:
//   realtimeDamCount        — any non-synthetic observation (level-only counts)
//   storageRateRiverDamCount — 貯水率 available, over 河川管理ダム (height >= 15 m)
// Conflating them is what made /coverage (34 %) and the home page (23 %) look
// like a contradiction.

const EXT_IDS = [
  'COV-LEVEL-ONLY',
  'COV-RATE-RIVER',
  'COV-RATE-SMALL',
  'COV-SYNTHETIC',
  'COV-STALE',
  'COV-EMPTY',
];
const HOUR = 3600 * 1000;
const DAY = 24 * HOUR;

let damLevelOnly: bigint;
let damRateRiver: bigint;
let damRateSmall: bigint;
let damSynthetic: bigint;
let damStale: bigint;
let damEmpty: bigint;
let base: Awaited<ReturnType<typeof coverageHeadline>>;

async function cleanup(): Promise<void> {
  const stale = await sql<{ id: bigint }[]>`
    SELECT id FROM dams WHERE external_ids ->> 'ndi' = ANY(${EXT_IDS}::TEXT[])
  `;
  for (const s of stale) {
    await sql`DELETE FROM observations WHERE dam_id = ${s.id}`;
  }
  await sql`DELETE FROM dams WHERE external_ids ->> 'ndi' = ANY(${EXT_IDS}::TEXT[])`;
}

async function addDam(extId: string, slug: string, heightM: number): Promise<bigint> {
  return upsertDamByExternalId('ndi', {
    slug,
    name: `Coverage ${extId}`,
    prefCode: '13',
    heightM,
    lat: 40.5,
    lng: 157.5,
    externalIds: { ndi: extId },
  });
}

beforeAll(async () => {
  await cleanup();
  base = await coverageHeadline();

  damLevelOnly = await addDam('COV-LEVEL-ONLY', 'cov-level-only', 40);
  damRateRiver = await addDam('COV-RATE-RIVER', 'cov-rate-river', 40);
  damRateSmall = await addDam('COV-RATE-SMALL', 'cov-rate-small', 10);
  damSynthetic = await addDam('COV-SYNTHETIC', 'cov-synthetic', 40);
  damStale = await addDam('COV-STALE', 'cov-stale', 40);
  damEmpty = await addDam('COV-EMPTY', 'cov-empty', 40);

  const now = Date.now();
  await upsertObservations([
    {
      damId: damLevelOnly,
      observedAt: new Date(now - HOUR),
      sourceId: 'test',
      waterLevelM: 100,
    },
    {
      damId: damRateRiver,
      observedAt: new Date(now - HOUR),
      sourceId: 'test',
      storageRate: 0.55,
    },
    {
      damId: damRateSmall,
      observedAt: new Date(now - HOUR),
      sourceId: 'test',
      storageRate: 0.6,
    },
    {
      damId: damSynthetic,
      observedAt: new Date(now - HOUR),
      sourceId: 'synthetic',
      storageRate: 0.7,
    },
    {
      damId: damStale,
      observedAt: new Date(now - 60 * DAY),
      sourceId: 'test',
      storageRate: 0.8,
    },
    // mudam's blank CSV days and kasenbosai's 欠測 hours: a row, but no value.
    { damId: damEmpty, observedAt: new Date(now - HOUR), sourceId: 'test' },
    { damId: damEmpty, observedAt: new Date(now - 60 * DAY), sourceId: 'mudam' },
  ]);
});

afterAll(cleanup);

describe('coverageHeadline', () => {
  test('realtime counts any non-synthetic observation, level-only included', async () => {
    const c = await coverageHeadline();
    // level-only + rate-river + rate-small. Synthetic and 60-day-stale are out.
    expect(c.realtimeDamCount - base.realtimeDamCount).toBe(3);
  });

  test('synthetic observations never count as coverage', async () => {
    const c = await coverageHeadline();
    const rows = await sql<{ n: bigint }[]>`
      SELECT COUNT(*)::BIGINT AS n FROM observations
      WHERE dam_id = ${damSynthetic} AND source_id = 'synthetic'
    `;
    expect(Number(rows[0]?.n ?? 0n)).toBe(1); // the fixture really is there
    expect(c.historicalDamCount - base.historicalDamCount).toBe(4); // all but synthetic
  });

  test('historical includes dams whose only data is outside the window', async () => {
    const c = await coverageHeadline();
    const gap = c.historicalDamCount - c.realtimeDamCount;
    const baseGap = base.historicalDamCount - base.realtimeDamCount;
    expect(gap - baseGap).toBe(1); // the 60-day-old dam
  });

  test('a row with every quantity NULL counts in neither metric', async () => {
    const c = await coverageHeadline();
    const rows = await sql<{ n: bigint }[]>`
      SELECT COUNT(*)::BIGINT AS n FROM observations WHERE dam_id = ${damEmpty}
    `;
    expect(Number(rows[0]?.n ?? 0n)).toBe(2); // the fixture really is there
    expect(c.realtimeDamCount - base.realtimeDamCount).toBe(3);
    expect(c.historicalDamCount - base.historicalDamCount).toBe(4);
  });

  test('the 貯水率 numerator needs a rate AND a river dam (height >= 15 m)', async () => {
    const c = await coverageHeadline();
    // Only rate-river qualifies: level-only has no rate, rate-small is 10 m,
    // synthetic is excluded, stale is outside the 30-day window.
    expect(c.storageRateRiverDamCount - base.storageRateRiverDamCount).toBe(1);
  });

  test('the 貯水率 denominator is river dams, not every master row', async () => {
    const c = await coverageHeadline();
    // 5 of the 6 fixtures are >= 15 m.
    expect(c.riverDamCount - base.riverDamCount).toBe(5);
    expect(c.damTotal - base.damTotal).toBe(6);
    expect(c.riverDamCount).toBeLessThanOrEqual(c.damTotal);
  });

  test('no dam is 提供元なし while the gate is open', async () => {
    // While a provider is unscanned no dam is 提供元なし, only 未調査.
    const c = await coverageHeadline();
    expect(c.notPublishedDamCount).toBe(0);
  });

  test('提供元なし dams leave the denominators, and the historical numerator', async () => {
    const open = await coverageHeadline();
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
      const triage = await classifyDamCoverage();
      const notPublished = triage.filter((r) => r.status === 'not_published');
      const ids = notPublished.map((r) => r.damId);
      // The 60-day-old dam has history but no provider lists it; the empty
      // dam has nothing at all. Both are 提供元なし.
      expect(ids).toContain(damStale);
      expect(ids).toContain(damEmpty);

      const closed = await coverageHeadline();
      expect(closed.notPublishedDamCount).toBe(notPublished.length);
      const unobtainable = triage
        .filter((r) => r.status === 'not_published' || r.status === 'published_no_data')
        .map((r) => r.damId.toString());
      const [river] = await sql<{ n: number }[]>`
        SELECT COUNT(*)::INT AS n FROM dams
        WHERE id = ANY(${unobtainable}::BIGINT[]) AND height_m >= 15
      `;
      expect(closed.unobtainableRiverDamCount).toBe(river?.n ?? -1);
      // damStale's old reading no longer counts toward 歴史データ含む.
      expect(open.historicalDamCount - closed.historicalDamCount).toBeGreaterThanOrEqual(1);
      // The live numerators cannot hold a 提供元なし dam, so they do not move.
      expect(closed.realtimeDamCount).toBe(open.realtimeDamCount);
      expect(closed.storageRateRiverDamCount).toBe(open.storageRateRiverDamCount);
    } finally {
      for (const r of remaining) {
        await sql`
          DELETE FROM source_universe
          WHERE source_id = ${r.source_id} AND source_external_id = ${`stub-${r.source_id}`}
        `;
        await sql`DELETE FROM source_universe_runs WHERE source_id = ${r.source_id}`;
      }
    }
  });
});

describe('coverage percentages', () => {
  // Production on 2026-10-02: 1,045 covered, 1,667 提供元なし, 27 提供元に値なし.
  const c = {
    damTotal: 2752,
    realtimeDamCount: 1045,
    historicalDamCount: 1050,
    riverDamCount: 2725,
    storageRateRiverDamCount: 754,
    notPublishedDamCount: 1667,
    publishedNoDataDamCount: 27,
    unobtainableRiverDamCount: 1680,
  };

  test('提供元なし and 提供元に値なし dams are not part of any denominator', () => {
    // 1045 / (2752 − 1667 − 27), 754 / (2725 − 1680), 1050 / (2752 − 1667 − 27)
    expect(realtimeCoveragePct(c)).toBeCloseTo(98.77, 1);
    expect(storageRateCoveragePct(c)).toBeCloseTo(72.15, 1);
    expect(historicalCoveragePct(c)).toBeCloseTo(99.24, 1);
  });

  test('an empty master yields null, not a division by zero', () => {
    const empty = {
      damTotal: 0,
      realtimeDamCount: 0,
      historicalDamCount: 0,
      riverDamCount: 0,
      storageRateRiverDamCount: 0,
      notPublishedDamCount: 0,
      publishedNoDataDamCount: 0,
      unobtainableRiverDamCount: 0,
    };
    expect(realtimeCoveragePct(empty)).toBeNull();
    expect(storageRateCoveragePct(empty)).toBeNull();
    expect(historicalCoveragePct(empty)).toBeNull();
  });

  test('a master with nothing obtainable yields null too', () => {
    const none = {
      ...c,
      notPublishedDamCount: c.damTotal - 27,
      unobtainableRiverDamCount: c.riverDamCount,
    };
    expect(realtimeCoveragePct(none)).toBeNull();
    expect(storageRateCoveragePct(none)).toBeNull();
  });
});
