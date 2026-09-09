import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { sql } from '../client.ts';
import { upsertDamByExternalId } from './dams.ts';
import {
  type ObservationCursor,
  findObservationsPage,
  upsertObservations,
} from './observations.ts';

// The cross-dam feed reads every dam at once, so the fixture window is parked
// far in the future where no real (or synthetic-seed) observation can land.
const FROM = new Date('2099-01-01T00:00:00Z');
const TO = new Date('2099-01-02T00:00:00Z');
const EXT_IDS = ['OBS-PAGE-1', 'OBS-PAGE-2'];

let damA: bigint;
let damB: bigint;

function at(hour: number): Date {
  return new Date(Date.UTC(2099, 0, 1, hour));
}

beforeAll(async () => {
  await sql`DELETE FROM dams WHERE external_ids ->> 'ndi' IN ${sql(EXT_IDS)}`;
  damA = await upsertDamByExternalId('ndi', {
    slug: 'obs-page-1',
    name: 'Obs Page A',
    prefCode: '13',
    lat: 35.7,
    lng: 139.5,
    externalIds: { ndi: 'OBS-PAGE-1' },
  });
  damB = await upsertDamByExternalId('ndi', {
    slug: 'obs-page-2',
    name: 'Obs Page B',
    prefCode: '13',
    lat: 35.8,
    lng: 139.6,
    externalIds: { ndi: 'OBS-PAGE-2' },
  });
  // 3 hours × 2 dams of measured data, plus one synthetic row that the
  // default (measured-only) path must drop.
  await upsertObservations([
    ...[0, 1, 2].flatMap((h) => [
      { observedAt: at(h), damId: damA, sourceId: 'kasenbosai', storageVolumeM3: 1_000 + h },
      { observedAt: at(h), damId: damB, sourceId: 'kasenbosai', storageVolumeM3: 2_000 + h },
    ]),
    { observedAt: at(1), damId: damA, sourceId: 'synthetic', storageVolumeM3: 9_999 },
  ]);
});

afterAll(async () => {
  for (const id of [damA, damB]) {
    if (id !== undefined) {
      await sql`DELETE FROM observations WHERE dam_id = ${id}`;
      await sql`DELETE FROM dams WHERE id = ${id}`;
    }
  }
});

/** Walk every page and return the flattened rows plus the page count. */
async function drain(
  pageSize: number,
  includeSynthetic = false,
): Promise<{ keys: string[]; pages: number }> {
  const keys: string[] = [];
  let after: ObservationCursor | null = null;
  let pages = 0;
  for (;;) {
    const page = await findObservationsPage({
      from: FROM,
      to: TO,
      pageSize,
      after,
      includeSynthetic,
    });
    pages += 1;
    for (const r of page.items) {
      keys.push(`${r.observedAt.toISOString()}|${r.damSlug}|${r.sourceId}`);
    }
    if (page.nextCursor === null) return { keys, pages };
    after = page.nextCursor;
    if (pages > 20) throw new Error('pagination did not terminate');
  }
}

describe('findObservationsPage', () => {
  test('returns measured rows joined to their dam, ordered by (observedAt, damId, sourceId)', async () => {
    const page = await findObservationsPage({ from: FROM, to: TO, pageSize: 100 });
    expect(page.items.length).toBe(6);
    expect(page.nextCursor).toBeNull();

    const first = page.items[0];
    expect(first?.damSlug).toBe('obs-page-1');
    expect(first?.damName).toBe('Obs Page A');
    expect(first?.sourceId).toBe('kasenbosai');
    // NUMERIC is cast to TEXT so callers never depend on driver coercion.
    expect(first?.storageVolumeM3).toBe('1000.00');
    expect(first?.qualityFlag).toBe(0);

    const observed = page.items.map((r) => r.observedAt.toISOString());
    expect(observed).toEqual([...observed].sort());
  });

  test('excludes synthetic rows by default and includes them on request', async () => {
    const measured = await findObservationsPage({ from: FROM, to: TO, pageSize: 100 });
    expect(measured.items.some((r) => r.sourceId === 'synthetic')).toBe(false);

    const all = await findObservationsPage({
      from: FROM,
      to: TO,
      pageSize: 100,
      includeSynthetic: true,
    });
    expect(all.items.length).toBe(7);
    expect(all.items.some((r) => r.sourceId === 'synthetic')).toBe(true);
  });

  test('keyset pagination yields every row exactly once, in order', async () => {
    const whole = await drain(100);
    const paged = await drain(2);
    // 3 pages of 2. The +1 look-ahead means the last full page already
    // knows there is nothing after it, so there is no empty trailing page.
    expect(paged.pages).toBe(3);
    expect(paged.keys).toEqual(whole.keys);
    expect(new Set(paged.keys).size).toBe(6);
  });

  test('a page that exactly fills pageSize still reports no next cursor when drained', async () => {
    const page = await findObservationsPage({ from: FROM, to: TO, pageSize: 6 });
    expect(page.items.length).toBe(6);
    expect(page.nextCursor).toBeNull();
  });

  test('the cursor splits ties on (damId, sourceId) within one timestamp', async () => {
    // at(0) holds two rows with the same observed_at — paging with size 1
    // must not re-serve or skip either of them.
    const first = await findObservationsPage({ from: FROM, to: TO, pageSize: 1 });
    expect(first.items[0]?.damSlug).toBe('obs-page-1');
    expect(first.nextCursor).not.toBeNull();

    const second = await findObservationsPage({
      from: FROM,
      to: TO,
      pageSize: 1,
      after: first.nextCursor,
    });
    expect(second.items[0]?.damSlug).toBe('obs-page-2');
    expect(second.items[0]?.observedAt.toISOString()).toBe(at(0).toISOString());
  });

  test('respects the from/to window', async () => {
    const narrow = await findObservationsPage({
      from: at(1),
      to: at(2),
      pageSize: 100,
    });
    expect(narrow.items.length).toBe(2);
    for (const r of narrow.items) {
      expect(r.observedAt.toISOString()).toBe(at(1).toISOString());
    }
  });
});
