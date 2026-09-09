import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { sql } from '../client.ts';
import { coverageHeadline, realtimeCoveragePct, storageRateCoveragePct } from './coverage.ts';
import { upsertDamByExternalId } from './dams.ts';
import { upsertObservations } from './observations.ts';

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
];
const HOUR = 3600 * 1000;
const DAY = 24 * HOUR;

let damLevelOnly: bigint;
let damRateRiver: bigint;
let damRateSmall: bigint;
let damSynthetic: bigint;
let damStale: bigint;
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

  test('the 貯水率 numerator needs a rate AND a river dam (height >= 15 m)', async () => {
    const c = await coverageHeadline();
    // Only rate-river qualifies: level-only has no rate, rate-small is 10 m,
    // synthetic is excluded, stale is outside the 30-day window.
    expect(c.storageRateRiverDamCount - base.storageRateRiverDamCount).toBe(1);
  });

  test('the 貯水率 denominator is river dams, not every master row', async () => {
    const c = await coverageHeadline();
    // 4 of the 5 fixtures are >= 15 m.
    expect(c.riverDamCount - base.riverDamCount).toBe(4);
    expect(c.damTotal - base.damTotal).toBe(5);
    expect(c.riverDamCount).toBeLessThanOrEqual(c.damTotal);
  });

  test('honours a custom window', async () => {
    // The 60-day-old dam is inside a 90-day window but outside the default one.
    const wide = await coverageHeadline(90);
    const narrow = await coverageHeadline(30);
    expect(wide.realtimeDamCount - narrow.realtimeDamCount).toBeGreaterThanOrEqual(1);
    expect(wide.storageRateRiverDamCount - narrow.storageRateRiverDamCount).toBeGreaterThanOrEqual(
      1,
    );
  });
});

describe('coverage percentages', () => {
  const c = {
    damTotal: 2754,
    realtimeDamCount: 947,
    historicalDamCount: 966,
    riverDamCount: 2725,
    storageRateRiverDamCount: 623,
  };

  test('the two metrics use their own denominators', () => {
    expect(realtimeCoveragePct(c)).toBeCloseTo(34.38, 1);
    expect(storageRateCoveragePct(c)).toBeCloseTo(22.86, 1);
  });

  test('an empty master yields null, not a division by zero', () => {
    const empty = {
      damTotal: 0,
      realtimeDamCount: 0,
      historicalDamCount: 0,
      riverDamCount: 0,
      storageRateRiverDamCount: 0,
    };
    expect(realtimeCoveragePct(empty)).toBeNull();
    expect(storageRateCoveragePct(empty)).toBeNull();
  });
});
