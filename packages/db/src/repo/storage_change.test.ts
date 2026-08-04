import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { sql } from '../client.ts';
import { storageChange, upsertDamByExternalId } from './dams.ts';
import { upsertObservations } from './observations.ts';

// Safer than `!`: throws with a clear message if the assumption is ever
// wrong, instead of silently trusting it at compile time only.
function notNull<T>(v: T | null): T {
  if (v === null) throw new Error('expected non-null value');
  return v;
}

let damId: bigint;

beforeAll(async () => {
  // A prior aborted run may have left both rows AND observations behind. The
  // observations FK on dams blocks DELETE, so always clear obs first.
  const stale = await sql<{ id: bigint }[]>`
    SELECT id FROM dams WHERE external_ids ->> 'ndi' IN ('CHANGE-TEST-1', 'CHANGE-EMPTY')
  `;
  for (const s of stale) {
    await sql`DELETE FROM observations WHERE dam_id = ${s.id}`;
  }
  await sql`DELETE FROM dams WHERE external_ids ->> 'ndi' IN ('CHANGE-TEST-1', 'CHANGE-EMPTY')`;
  damId = await upsertDamByExternalId('ndi', {
    slug: 'change-test-1',
    name: 'Storage Change Test',
    prefCode: '13',
    lat: 35.5,
    lng: 139.5,
    externalIds: { ndi: 'CHANGE-TEST-1' },
  });

  // Seed observations at known offsets from now. Storage values are picked
  // so the change percentages are easy to verify.
  const now = Date.now();
  const points = [
    { offsetH: 0, vol: 100 }, // current
    { offsetH: 1, vol: 110 }, // 1h ago → +10% from then to now? wait: latest vs prev
    { offsetH: 6, vol: 120 },
    { offsetH: 12, vol: 130 },
    { offsetH: 24, vol: 140 },
    { offsetH: 24 * 7, vol: 200 },
  ];
  await upsertObservations(
    points.map((p) => ({
      damId,
      observedAt: new Date(now - p.offsetH * 3600 * 1000),
      sourceId: 'test',
      storageVolumeM3: p.vol,
      qualityFlag: 0,
    })),
  );
});

afterAll(async () => {
  // Observations have an FK on dams; delete them first.
  await sql`DELETE FROM observations WHERE dam_id = ${damId}`;
  await sql`DELETE FROM dams WHERE id = ${damId}`;
});

describe('storageChange', () => {
  test('current is the most recent observation', async () => {
    const c = await storageChange(damId);
    expect(c.current).not.toBeNull();
    expect(Number(c.current)).toBe(100);
  });
  test('h1 picks the 1-hour-ago point', async () => {
    const c = await storageChange(damId);
    expect(c.h1).not.toBeNull();
    expect(Number(c.h1)).toBe(110);
    // Age is the gap between the latest observation and the picked point.
    expect(notNull(c.h1AgeS)).toBeGreaterThan(0);
  });
  test('d7 picks the 7-day-ago point', async () => {
    const c = await storageChange(damId);
    expect(c.d7).not.toBeNull();
    expect(Number(c.d7)).toBe(200);
  });
  test('d365 has no source data → null', async () => {
    const c = await storageChange(damId);
    expect(c.d365).toBeNull();
    expect(c.d365AgeS).toBeNull();
  });
  test('age is monotonic: h1 < h6 < h12 < d1 < d7', async () => {
    const c = await storageChange(damId);
    expect(notNull(c.h1AgeS) < notNull(c.h6AgeS)).toBe(true);
    expect(notNull(c.h6AgeS) < notNull(c.h12AgeS)).toBe(true);
    expect(notNull(c.h12AgeS) < notNull(c.d1AgeS)).toBe(true);
    expect(notNull(c.d1AgeS) < notNull(c.d7AgeS)).toBe(true);
  });
  test('returns all-null shape when the dam has no observations', async () => {
    // New empty dam
    const emptyId = await upsertDamByExternalId('ndi', {
      slug: 'change-empty',
      name: 'Empty',
      prefCode: '13',
      lat: 35.0,
      lng: 139.0,
      externalIds: { ndi: 'CHANGE-EMPTY' },
    });
    try {
      const c = await storageChange(emptyId);
      expect(c.current).toBeNull();
      expect(c.h1).toBeNull();
      expect(c.d365).toBeNull();
      expect(c.d1825).toBeNull();
    } finally {
      await sql`DELETE FROM dams WHERE id = ${emptyId}`;
    }
  });
});
