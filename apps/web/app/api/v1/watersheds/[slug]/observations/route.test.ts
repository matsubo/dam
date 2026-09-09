import { afterAll, beforeAll, expect, test } from 'bun:test';
import { sql } from '@dam/db/client';
import { upsertDamByExternalId } from '@dam/db/repo/dams';
import { upsertObservations } from '@dam/db/repo/observations';
import { upsertWatershed } from '@dam/db/repo/watersheds';
import { GET } from './route.ts';

// The watershed hourly aggregate must pick the preferred source PER DAM.
// A single global pick (the old `preferredSource()`) filtered every dam in the
// watershed down to one source id, so a watershed whose dams all report under
// some other source rendered an empty 1-week chart while the 1-year chart
// (which reads obs_daily and applies no source filter) still had data.

const SRC_TOP = 'ws-obs-top'; // highest priority, deliberately has NO observations
const SRC_HI = 'ws-obs-hi'; // ranked, wins over SRC_LO for the dam that has both
const SRC_LO = 'ws-obs-lo';
const SRC_UNRANKED = 'ws-obs-unranked'; // absent from source_priorities entirely

const SLUG = 'ws-obs-test';
const HOUR = new Date('2026-05-15T10:00:00Z');
const FROM = '2026-05-15T00:00:00Z';
const TO = '2026-05-16T00:00:00Z';

let watershedId: bigint;
const damIds: bigint[] = [];

async function seedDam(externalId: string, slug: string): Promise<bigint> {
  const id = await upsertDamByExternalId('ndi', {
    slug,
    name: slug,
    prefCode: '13',
    lat: 35.7,
    lng: 139.5,
    watershedId,
    externalIds: { ndi: externalId },
  });
  damIds.push(id);
  return id;
}

beforeAll(async () => {
  await sql`DELETE FROM observations WHERE source_id IN (${SRC_TOP}, ${SRC_HI}, ${SRC_LO}, ${SRC_UNRANKED})`;
  await sql`DELETE FROM dams WHERE external_ids ->> 'ndi' LIKE 'WS-OBS-%'`;
  await sql`DELETE FROM watersheds WHERE slug = ${SLUG}`;

  const topRow = await sql<{ priority: number }[]>`
    SELECT priority FROM source_priorities WHERE active ORDER BY priority DESC LIMIT 1
  `;
  const base = topRow[0]?.priority ?? 100;
  // SRC_TOP outranks everything so the old global preferredSource() resolves to
  // it — and since it carries no observations, the buggy query returns 0 rows.
  for (const [id, priority] of [
    [SRC_TOP, base + 3],
    [SRC_HI, base + 2],
    [SRC_LO, base + 1],
  ] as const) {
    await sql`
      INSERT INTO source_priorities (source_id, priority, description)
      VALUES (${id}, ${priority}, 'integration test')
      ON CONFLICT (source_id) DO UPDATE SET priority = EXCLUDED.priority, active = TRUE
    `;
  }

  watershedId = await upsertWatershed({
    code: 'WSOBS',
    slug: SLUG,
    name: SLUG,
    kind: 'first',
    boundaryGeoJSON: {
      type: 'Polygon',
      coordinates: [
        [
          [139.0, 35.0],
          [140.0, 35.0],
          [140.0, 36.0],
          [139.0, 36.0],
          [139.0, 35.0],
        ],
      ],
    },
  });

  // Dam A: only a low-priority source.
  const damA = await seedDam('WS-OBS-A', 'ws-obs-a');
  // Dam B: the same hour under two ranked sources — the higher one must win
  // so the watershed sum doesn't double-count or take the stale feed.
  const damB = await seedDam('WS-OBS-B', 'ws-obs-b');
  // Dam C: a source that isn't in source_priorities at all — must still count.
  const damC = await seedDam('WS-OBS-C', 'ws-obs-c');

  await upsertObservations([
    { observedAt: HOUR, damId: damA, sourceId: SRC_LO, storageVolumeM3: 1_000_000 },
    { observedAt: HOUR, damId: damB, sourceId: SRC_HI, storageVolumeM3: 2_000_000 },
    { observedAt: HOUR, damId: damB, sourceId: SRC_LO, storageVolumeM3: 9_000_000 },
    { observedAt: HOUR, damId: damC, sourceId: SRC_UNRANKED, storageVolumeM3: 400_000 },
  ]);
});

afterAll(async () => {
  for (const id of damIds) {
    await sql`DELETE FROM observations WHERE dam_id = ${id}`;
    await sql`DELETE FROM dams WHERE id = ${id}`;
  }
  if (watershedId !== undefined) {
    await sql`DELETE FROM watersheds WHERE id = ${watershedId}`;
  }
  await sql`DELETE FROM source_priorities WHERE source_id IN (${SRC_TOP}, ${SRC_HI}, ${SRC_LO})`;
});

function call(params: Record<string, string>) {
  const qs = new URLSearchParams({ from: FROM, to: TO, ...params }).toString();
  return GET(new Request(`http://t/api/v1/watersheds/${SLUG}/observations?${qs}`), {
    params: Promise.resolve({ slug: SLUG }),
  });
}

test('hourly aggregate sums dams whose data lives under non-top-priority sources', async () => {
  const res = await call({ interval: 'hourly' });
  expect(res.status).toBe(200);
  const body = (await res.json()) as {
    count: number;
    series: Array<{ observedAt: string; storageVolumeM3: string | null }>;
  };

  expect(body.count).toBeGreaterThan(0);
  const bucket = body.series.find((p) => p.observedAt === HOUR.toISOString());
  expect(bucket).toBeDefined();
  // 1,000,000 (A via SRC_LO) + 2,000,000 (B via SRC_HI, beating SRC_LO's
  // 9,000,000) + 400,000 (C via an unranked source) = 3,400,000.
  expect(Number(bucket?.storageVolumeM3)).toBe(3_400_000);
});

test('exclude_synthetic=1 still returns the aggregate', async () => {
  const res = await call({ interval: 'hourly', exclude_synthetic: '1' });
  expect(res.status).toBe(200);
  const body = (await res.json()) as { count: number };
  expect(body.count).toBeGreaterThan(0);
});
