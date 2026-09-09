import { afterAll, beforeAll, expect, test } from 'bun:test';
import { sql } from '@dam/db/client';
import { upsertDamByExternalId } from '@dam/db/repo/dams';
import { type ObservationInput, upsertObservations } from '@dam/db/repo/observations';
import { upsertWatershed } from '@dam/db/repo/watersheds';
import { GET } from './route.ts';

// The watershed hourly aggregate has to do two things the 1-week chart depends
// on: pick a source PER DAM (a single global pick filtered out every dam not on
// the top-priority feed, leaving the chart empty), and keep the summed cohort
// constant across buckets (dams report at different cadences, so summing only
// the dams that posted inside each hour makes the total jump by whole dams).

const SRC_TOP = 'ws-obs-top'; // highest priority, deliberately has NO observations
const SRC_HI = 'ws-obs-hi'; // ranked, wins over SRC_LO for the dam that has both
const SRC_LO = 'ws-obs-lo';
const SRC_UNRANKED = 'ws-obs-unranked'; // absent from source_priorities entirely
const TEST_SOURCES = [SRC_TOP, SRC_HI, SRC_LO, SRC_UNRANKED] as const;

const SLUG = 'ws-obs-test';
const GAP_SLUG = 'ws-obs-gap';
const LEAD_SLUG = 'ws-obs-lead';
const NULLV_SLUG = 'ws-obs-nullvol';

const FROM = '2026-05-15T00:00:00Z';
const TO = '2026-05-16T00:00:00Z';
const WINDOW_HOURS = 24;
const HOUR = new Date('2026-05-15T10:00:00Z');

const watershedIds: bigint[] = [];
const damIds: bigint[] = [];

// Far-offshore 1° squares, each in its own unused box, so these fixtures never
// win a point-in-polygon lookup in another test (ST_Area tie-breaks would
// otherwise let them beat that test's own watershed). Same convention as
// watersheds_aggregate.test.ts.
function offshoreSquare(lngWest: number) {
  return {
    type: 'Polygon',
    coordinates: [
      [
        [lngWest, 42.0],
        [lngWest + 1, 42.0],
        [lngWest + 1, 43.0],
        [lngWest, 43.0],
        [lngWest, 42.0],
      ],
    ],
  };
}

async function seedWatershed(code: string, slug: string, lngWest: number): Promise<bigint> {
  const id = await upsertWatershed({
    code,
    slug,
    name: slug,
    kind: 'first',
    boundaryGeoJSON: offshoreSquare(lngWest),
  });
  watershedIds.push(id);
  return id;
}

async function seedDam(watershedId: bigint, externalId: string, lngWest: number): Promise<bigint> {
  const slug = externalId.toLowerCase();
  const id = await upsertDamByExternalId('ndi', {
    slug,
    name: slug,
    prefCode: '13',
    lat: 42.5,
    lng: lngWest + 0.5,
    watershedId,
    externalIds: { ndi: externalId },
  });
  damIds.push(id);
  return id;
}

beforeAll(async () => {
  await sql`DELETE FROM observations WHERE source_id IN ${sql(TEST_SOURCES)}`;
  await sql`DELETE FROM dams WHERE external_ids ->> 'ndi' LIKE 'WS-OBS-%'`;
  await sql`DELETE FROM watersheds WHERE slug IN (${SLUG}, ${GAP_SLUG}, ${LEAD_SLUG}, ${NULLV_SLUG})`;

  const topRow = await sql<{ priority: number }[]>`
    SELECT priority FROM source_priorities WHERE active ORDER BY priority DESC LIMIT 1
  `;
  const base = topRow[0]?.priority ?? 100;
  // SRC_TOP outranks everything so the old global preferredSource() resolves to
  // it — and since it carries no observations, the buggy query returned 0 rows.
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

  const obs: ObservationInput[] = [];

  // --- Source-selection fixture ---
  const wsSource = await seedWatershed('WSOBS', SLUG, 157.0);
  // Dam A: only a low-priority source.
  const damA = await seedDam(wsSource, 'WS-OBS-A', 157.0);
  // Dam B: the same hour under two ranked sources — the higher one must win so
  // the watershed sum doesn't take the stale feed.
  const damB = await seedDam(wsSource, 'WS-OBS-B', 157.0);
  // Dam C: a source that isn't in source_priorities at all — must still count.
  const damC = await seedDam(wsSource, 'WS-OBS-C', 157.0);
  obs.push(
    { observedAt: HOUR, damId: damA, sourceId: SRC_LO, storageVolumeM3: 1_000_000 },
    { observedAt: HOUR, damId: damB, sourceId: SRC_HI, storageVolumeM3: 2_000_000 },
    { observedAt: HOUR, damId: damB, sourceId: SRC_LO, storageVolumeM3: 9_000_000 },
    { observedAt: HOUR, damId: damC, sourceId: SRC_UNRANKED, storageVolumeM3: 400_000 },
  );

  // --- Mixed-cadence fixture: P hourly, Q every third hour ---
  const wsGap = await seedWatershed('WSOBSGAP', GAP_SLUG, 158.0);
  const damP = await seedDam(wsGap, 'WS-OBS-P', 158.0);
  const damQ = await seedDam(wsGap, 'WS-OBS-Q', 158.0);
  for (let h = 0; h < WINDOW_HOURS; h++) {
    const at = new Date(Date.UTC(2026, 4, 15, h));
    obs.push({ observedAt: at, damId: damP, sourceId: SRC_LO, storageVolumeM3: 1_000_000 });
    if (h % 3 === 0) {
      obs.push({ observedAt: at, damId: damQ, sourceId: SRC_LO, storageVolumeM3: 5_000_000 });
    }
  }

  // --- NULL-volume fixture: T posts a row every hour but only carries a volume
  // every third hour. A row that exists with no volume is still "no measurement",
  // so it has to be filled like a missing row rather than dropping the dam. ---
  const wsNull = await seedWatershed('WSOBSNULL', NULLV_SLUG, 160.0);
  const damS = await seedDam(wsNull, 'WS-OBS-S', 160.0);
  const damT = await seedDam(wsNull, 'WS-OBS-T', 160.0);
  for (let h = 0; h < WINDOW_HOURS; h++) {
    const at = new Date(Date.UTC(2026, 4, 15, h));
    obs.push({ observedAt: at, damId: damS, sourceId: SRC_LO, storageVolumeM3: 1_000_000 });
    obs.push({
      observedAt: at,
      damId: damT,
      sourceId: SRC_LO,
      storageVolumeM3: h % 3 === 0 ? 5_000_000 : null,
    });
  }

  // --- Leading-edge fixture: R's only report predates the window ---
  const wsLead = await seedWatershed('WSOBSLEAD', LEAD_SLUG, 159.0);
  const damR = await seedDam(wsLead, 'WS-OBS-R', 159.0);
  obs.push({
    observedAt: new Date('2026-05-14T22:00:00Z'),
    damId: damR,
    sourceId: SRC_LO,
    storageVolumeM3: 3_000_000,
  });

  await upsertObservations(obs);
});

afterAll(async () => {
  for (const id of damIds) {
    await sql`DELETE FROM observations WHERE dam_id = ${id}`;
    await sql`DELETE FROM dams WHERE id = ${id}`;
  }
  for (const id of watershedIds) {
    await sql`DELETE FROM watersheds WHERE id = ${id}`;
  }
  await sql`DELETE FROM source_priorities WHERE source_id IN (${SRC_TOP}, ${SRC_HI}, ${SRC_LO})`;
});

interface SeriesBody {
  count: number;
  series: Array<{ observedAt: string; storageVolumeM3: string | null }>;
}

async function fetchSeries(
  slug: string,
  params: Record<string, string> = {},
): Promise<{ status: number; body: SeriesBody }> {
  const qs = new URLSearchParams({ from: FROM, to: TO, interval: 'hourly', ...params }).toString();
  const res = await GET(new Request(`http://t/api/v1/watersheds/${slug}/observations?${qs}`), {
    params: Promise.resolve({ slug }),
  });
  return { status: res.status, body: (await res.json()) as SeriesBody };
}

test('hourly aggregate sums dams whose data lives under non-top-priority sources', async () => {
  const { status, body } = await fetchSeries(SLUG);
  expect(status).toBe(200);
  expect(body.count).toBeGreaterThan(0);

  const bucket = body.series.find((p) => p.observedAt === HOUR.toISOString());
  expect(bucket).toBeDefined();
  // 1,000,000 (A via SRC_LO) + 2,000,000 (B via SRC_HI, beating SRC_LO's
  // 9,000,000) + 400,000 (C via an unranked source) = 3,400,000.
  expect(Number(bucket?.storageVolumeM3)).toBe(3_400_000);
});

test('exclude_synthetic=1 still returns the aggregate', async () => {
  const { status, body } = await fetchSeries(SLUG, { exclude_synthetic: '1' });
  expect(status).toBe(200);
  expect(body.count).toBeGreaterThan(0);
});

// Dams in one watershed don't share a reporting cadence. Summing only the dams
// that happen to report inside each hour makes the total jump by whole dams — in
// production 信濃川 alternated between 13.5M and 4.3M m³, and every watershed's
// final bucket (the in-progress hour) collapsed to whichever dams had already
// posted. Each dam's last known volume has to carry forward.
test('hourly aggregate holds the cohort steady when dams report at different cadences', async () => {
  const { status, body } = await fetchSeries(GAP_SLUG);
  expect(status).toBe(200);

  // Dam P posts 1,000,000 every hour; dam Q posts 5,000,000 only every third
  // hour. Every bucket must total 6,000,000 — not sawtooth down to 1,000,000.
  expect(body.series).toHaveLength(WINDOW_HOURS);
  expect(body.series.map((p) => Number(p.storageVolumeM3))).toEqual(
    Array.from({ length: WINDOW_HOURS }, () => 6_000_000),
  );
});

// The window's first bucket must not dip either: a dam that last reported
// shortly BEFORE `from` is still holding that water, so its value carries into
// the window rather than leaving the dam out until its next post.
test('hourly aggregate seeds the first bucket from before the window', async () => {
  const { status, body } = await fetchSeries(LEAD_SLUG);
  expect(status).toBe(200);
  expect(body.series.length).toBeGreaterThan(0);
  // Dam R reported 3,000,000 two hours before `from` and not since.
  expect(body.series[0]?.observedAt).toBe(new Date(FROM).toISOString());
  expect(Number(body.series[0]?.storageVolumeM3)).toBe(3_000_000);
});

// A feed can post a row on schedule but leave storage_volume_m3 NULL (the
// kasenbosai phantom-zero migrations null out bogus values, for one). locf()
// treats such a NULL as a real value and stops carrying forward unless told
// otherwise, which reproduced the same sawtooth as a missing row.
test('hourly aggregate fills rows that exist with no volume', async () => {
  const { status, body } = await fetchSeries(NULLV_SLUG);
  expect(status).toBe(200);

  // Dam S posts 1,000,000 hourly; dam T posts a row hourly but only carries
  // 5,000,000 every third hour. Every bucket must still total 6,000,000.
  expect(body.series).toHaveLength(WINDOW_HOURS);
  expect(body.series.map((p) => Number(p.storageVolumeM3))).toEqual(
    Array.from({ length: WINDOW_HOURS }, () => 6_000_000),
  );
});

// Gapfill over an empty input must stay empty rather than erroring — otherwise
// a watershed with nothing in the window renders a 500 instead of a blank chart.
test('hourly aggregate returns an empty series when nothing was observed', async () => {
  const { status, body } = await fetchSeries(LEAD_SLUG, {
    from: '2026-01-01T00:00:00Z',
    to: '2026-01-02T00:00:00Z',
  });
  expect(status).toBe(200);
  expect(body.series).toEqual([]);
  expect(body.count).toBe(0);
});
