// apps/worker/src/tasks/ingest_nagasaki_kasen.test.ts

import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { sql } from '@dam/db/client';
import type { JobHelpers } from 'graphile-worker';
import task, {
  buildNagasakiUniverse,
  buildSnapshotUrl,
  type DamMaster,
  parseAllDamsJson,
  parseNagasakiDatetime,
} from './ingest_nagasaki_kasen.ts';

describe('parseNagasakiDatetime', () => {
  test('parses "YYYY/MM/DD" + "HH:MM" JST → UTC (subtract 9h)', () => {
    const d = parseNagasakiDatetime('2026/06/05', '15:30');
    expect(d).not.toBeNull();
    // 15:30 JST = 06:30 UTC
    expect(d?.toISOString()).toBe('2026-06-05T06:30:00.000Z');
  });

  test('handles midnight crossover (JST hour < 9 → previous UTC day)', () => {
    const d = parseNagasakiDatetime('2026/06/05', '06:00');
    expect(d).not.toBeNull();
    // 06:00 JST = 2026-06-04T21:00:00Z
    expect(d?.toISOString()).toBe('2026-06-04T21:00:00.000Z');
  });

  test('returns null for malformed ymd', () => {
    expect(parseNagasakiDatetime('2026-06-05', '15:30')).toBeNull();
    expect(parseNagasakiDatetime('', '15:30')).toBeNull();
  });

  test('returns null for malformed time', () => {
    expect(parseNagasakiDatetime('2026/06/05', '1530')).toBeNull();
    expect(parseNagasakiDatetime('2026/06/05', '')).toBeNull();
  });
});

describe('buildSnapshotUrl', () => {
  test('builds correct URL from max_dt', () => {
    const url = buildSnapshotUrl('https://dam.pref.nagasaki.jp', '2026/06/05 15:30:00');
    expect(url).toBe(
      'https://dam.pref.nagasaki.jp/data/all/202606/20260605/all_20260605_1530_d.json',
    );
  });

  test('handles :00 times', () => {
    const url = buildSnapshotUrl('https://dam.pref.nagasaki.jp', '2026/06/05 09:00:00');
    expect(url).toBe(
      'https://dam.pref.nagasaki.jp/data/all/202606/20260605/all_20260605_0900_d.json',
    );
  });

  test('returns null for malformed max_dt', () => {
    expect(buildSnapshotUrl('https://example.com', 'bad')).toBeNull();
    expect(buildSnapshotUrl('https://example.com', '')).toBeNull();
  });
});

describe('parseAllDamsJson', () => {
  const masters = new Map<number, string>([
    [1928, '永田ダム'],
    [1927, '勝本ダム'],
    [1101, '式見ダム'],
  ]);

  const sampleJson = {
    ymd: '2026/06/05',
    time: '15:30',
    list: [
      {
        dam_cd: 1928,
        area_cd: 30,
        lv: '64.77',
        pondage: '97',
        rate: '36.7',
        rate_r: '96.2',
        rate_y: '36.6',
        rate_c: '0.0',
        in: '0.01',
        dis: '0.01',
        rain_10: '0',
        rain_h: '0',
        rain_t: '0',
        stat: 2,
        u_lv: '3',
        u_pondage: '3',
        u_rate: '3',
        u_rate_r: '3',
        u_rate_y: '3',
        u_rate_c: '3',
        u_in: '3',
        u_dis: '3',
      },
      {
        dam_cd: 1927,
        area_cd: 30,
        lv: '57.01',
        pondage: '480',
        rate: '38.6',
        rate_r: '95.0',
        rate_y: '38.7',
        rate_c: '0.0',
        in: '0.02',
        dis: '0.03',
        rain_10: '0',
        rain_h: '0',
        rain_t: '0',
        stat: 2,
        u_lv: '3',
        u_pondage: '3',
        u_rate: '3',
        u_rate_r: '3',
        u_rate_y: '3',
        u_rate_c: '3',
        u_in: '3',
        u_dis: '3',
      },
    ],
  };

  test('parses two dams with all fields', () => {
    const rows = parseAllDamsJson(sampleJson, masters);
    expect(rows).toHaveLength(2);
  });

  test('first dam has correct values', () => {
    const rows = parseAllDamsJson(sampleJson, masters);
    expect(rows[0]?.damName).toBe('永田ダム');
    expect(rows[0]?.damCd).toBe(1928);
    // 15:30 JST = 06:30 UTC
    expect(rows[0]?.observedAt.toISOString()).toBe('2026-06-05T06:30:00.000Z');
    expect(rows[0]?.waterLevelM).toBeCloseTo(64.77);
    expect(rows[0]?.storageVolumeM3).toBeCloseTo(97 * 1000);
    // rate_r is the 利水容量貯水率 the manager publishes; `rate` / rate_y
    // divide by the full 有効貯水容量. Issue #38 §2-2.
    expect(rows[0]?.storageRate).toBeCloseTo(0.962);
    expect(rows[0]?.inflowM3s).toBeCloseTo(0.01);
    expect(rows[0]?.outflowM3s).toBeCloseTo(0.01);
  });

  test('storageVolumeM3 is pondage × 1000 (千m³ → m³)', () => {
    const rows = parseAllDamsJson(sampleJson, masters);
    expect(rows[1]?.storageVolumeM3).toBeCloseTo(480 * 1000);
  });

  test('skips dams not in master map', () => {
    const singleMaster = new Map<number, string>([[1928, '永田ダム']]);
    const rows = parseAllDamsJson(sampleJson, singleMaster);
    expect(rows).toHaveLength(1);
    expect(rows[0]?.damName).toBe('永田ダム');
  });

  test('returns empty array when observedAt is unparseable', () => {
    const bad = { ymd: 'bad', time: 'bad', list: sampleJson.list };
    expect(parseAllDamsJson(bad, masters)).toHaveLength(0);
  });

  test('handles empty string fields as null', () => {
    const json = {
      ymd: '2026/06/05',
      time: '15:30',
      list: [
        {
          dam_cd: 1101,
          area_cd: 10,
          lv: '',
          pondage: '',
          rate: '',
          rate_r: '',
          rate_y: '',
          rate_c: '',
          in: '',
          dis: '',
          rain_10: '0',
          rain_h: '0',
          rain_t: '0',
          stat: 0,
          u_lv: '0',
          u_pondage: '0',
          u_rate: '0',
          u_rate_r: '0',
          u_rate_y: '0',
          u_rate_c: '0',
          u_in: '0',
          u_dis: '0',
        },
      ],
    };
    const rows = parseAllDamsJson(json, masters);
    expect(rows).toHaveLength(1);
    expect(rows[0]?.waterLevelM).toBeNull();
    expect(rows[0]?.storageVolumeM3).toBeNull();
    expect(rows[0]?.storageRate).toBeNull();
    expect(rows[0]?.inflowM3s).toBeNull();
    expect(rows[0]?.outflowM3s).toBeNull();
  });

  test('falls back to the 有効容量 rate when 利水 is unpublished', () => {
    const [base] = sampleJson.list;
    if (!base) throw new Error('fixture missing');
    const json = {
      ymd: '2026/06/05',
      time: '15:30',
      list: [{ ...base, rate_r: '-', rate_y: '36.6' }],
    };
    const rows = parseAllDamsJson(json, masters);
    expect(rows[0]?.storageRate).toBeCloseTo(0.366);
  });

  test('parses thousands separators in pondage', () => {
    const [base] = sampleJson.list;
    if (!base) throw new Error('fixture missing');
    const json = {
      ymd: '2026/06/05',
      time: '15:30',
      list: [{ ...base, pondage: '1,938' }],
    };
    const rows = parseAllDamsJson(json, masters);
    expect(rows[0]?.storageVolumeM3).toBeCloseTo(1_938_000);
  });
});

// Live captures, 2026-09-28: dam_m.json and the 14:10 JST all-dams snapshot.
// 樋口 / つづら / 笛吹 (佐世保市) print 「-」 in every field, stat 0.
const fixture = async (name: string) =>
  Bun.file(`${import.meta.dir}/../../../../tests/fixtures/nagasaki_kasen/${name}`).json();
const liveCatalogue = (await fixture('dam_m_2026-09-28.json')) as DamMaster[];
const liveSnapshot = await fixture('all_20260928_1410_d.json');

describe('parseAllDamsJson hasData', () => {
  const rows = parseAllDamsJson(
    liveSnapshot,
    new Map(liveCatalogue.map((m) => [m.dam_cd, m.dam_nm])),
  );

  test('marks the dams printed with 「-」 in every field as publishing nothing', () => {
    expect(rows.filter((r) => r.hasData !== true).map((r) => [r.damName, r.hasData])).toEqual([
      ['樋口ダム', false],
      ['つづらダム', false],
      ['笛吹ダム', false],
    ]);
    expect(rows).toHaveLength(35);
  });

  test('an empty or unreadable field is unknown, not "no value"', () => {
    const [base] = liveSnapshot.list.filter((i: { dam_cd: number }) => i.dam_cd === 1421);
    for (const lv of ['', 'x']) {
      const [row] = parseAllDamsJson(
        { ...liveSnapshot, list: [{ ...base, lv }] },
        new Map([[1421, '樋口ダム']]),
      );
      expect(row?.hasData).toBeNull();
    }
  });
});

describe('buildNagasakiUniverse', () => {
  // dam_m.json is 長崎県's own catalogue, so it is what the source publishes —
  // not the subset that carried a reading in this run's snapshot.
  const catalogue = [
    { dam_cd: 1928, dam_nm: '永田ダム' },
    { dam_cd: 1927, dam_nm: '勝本ダム' },
    { dam_cd: 1101, dam_nm: '式見ダム' },
  ];
  const resolved = new Map<number, bigint>([
    [1928, 11n],
    [1927, 12n],
  ]);
  const snapshot = parseAllDamsJson(
    liveSnapshot,
    new Map([
      [1928, '永田ダム'],
      [1101, '式見ダム'],
    ]),
  );
  const universe = buildNagasakiUniverse(catalogue, (cd) => resolved.get(cd), snapshot);

  test('records the whole published catalogue, matched or not', () => {
    expect(universe).toHaveLength(3);
  });

  test('uses dam_cd as the external id and tags the prefecture', () => {
    expect(universe[0]).toEqual({
      externalId: '1928',
      name: '永田ダム',
      prefCode: '42',
      resolvedDamId: 11n,
      hasData: true,
    });
  });

  test('a catalogued dam with no parsed snapshot row is unknown, not empty', () => {
    expect(universe.find((u) => u.externalId === '1927')?.hasData).toBeNull();
  });

  test('keeps an unmatched dam with resolvedDamId null', () => {
    // A published dam we cannot tie to a master is the matching backlog —
    // dropping it would read as "nobody publishes this dam".
    const shikimi = universe.find((u) => u.externalId === '1101');
    expect(shikimi?.resolvedDamId).toBeNull();
  });

  test('records nothing extra for an empty catalogue', () => {
    // An empty list is how recordUniverse recognises a failed fetch, so the
    // builder must not invent rows.
    expect(buildNagasakiUniverse([], () => undefined, [])).toEqual([]);
  });
});

describe('task: universe resolution for a catalogue dam absent from the snapshot', () => {
  // Issue #82: a dam listed in dam_m.json that carries no reading this run is
  // still published. When the master already holds its nagasaki-kasen stamp,
  // the universe row must resolve to it — otherwise a bound, published dam
  // shows up as unmatched backlog until it happens to report.
  const SOURCE = 'nagasaki-kasen';
  const REPORTING = { slug: 'nagasaki-univ-test-reporting', cd: 990001, name: '試験報告ダム' };
  const SILENT = { slug: 'nagasaki-univ-test-silent', cd: 990002, name: '試験欠測ダム' };
  const FIXTURE_CDS = [String(REPORTING.cd), String(SILENT.cd)];
  const ids = new Map<string, bigint>();
  const realFetch = globalThis.fetch;
  let hadRun = false;

  const json = (body: unknown): Response =>
    new Response(JSON.stringify(body), { headers: { 'content-type': 'application/json' } });

  async function cleanup(): Promise<void> {
    await sql`
      DELETE FROM source_universe
      WHERE source_id = ${SOURCE} AND source_external_id IN ${sql(FIXTURE_CDS)}`;
    await sql`
      DELETE FROM observations WHERE dam_id IN (
        SELECT id FROM dams WHERE slug IN (${REPORTING.slug}, ${SILENT.slug}))`;
    await sql`DELETE FROM dams WHERE slug IN (${REPORTING.slug}, ${SILENT.slug})`;
  }

  beforeAll(async () => {
    await cleanup();
    const [run] = await sql`SELECT 1 FROM source_universe_runs WHERE source_id = ${SOURCE}`;
    hadRun = run !== undefined;
    for (const d of [REPORTING, SILENT]) {
      const [r] = await sql<{ id: bigint }[]>`
        INSERT INTO dams (slug, name, pref_code, location, external_ids)
        VALUES (${d.slug}, ${d.name}, '42',
                ST_SetSRID(ST_MakePoint(129.9, 32.9), 4326)::geography,
                ${sql.json({ [SOURCE]: String(d.cd) })})
        RETURNING id`;
      ids.set(d.slug, r?.id ?? 0n);
    }

    // The upstream: both dams are catalogued, only one carries a reading.
    globalThis.fetch = (async (input: string | URL | Request) => {
      const url = String(input instanceof Request ? input.url : input);
      if (url.endsWith('/data/dt_range.json')) {
        return json({ min_dt: '2026/06/01 00:00:00', max_dt: '2026/06/05 15:30:00' });
      }
      if (url.endsWith('/data/dam_m.json')) {
        return json([
          { dam_cd: REPORTING.cd, dam_nm: REPORTING.name },
          { dam_cd: SILENT.cd, dam_nm: SILENT.name },
        ]);
      }
      if (url.endsWith('/data/all/202606/20260605/all_20260605_1530_d.json')) {
        return json({
          ymd: '2026/06/05',
          time: '15:30',
          list: [
            {
              dam_cd: REPORTING.cd,
              lv: '64.77',
              pondage: '97',
              rate: '36.7',
              rate_r: '96.2',
              rate_y: '36.6',
              in: '0.01',
              dis: '0.01',
            },
          ],
        });
      }
      return new Response('not found', { status: 404 });
    }) as typeof fetch;

    const helpers = { logger: { info: () => {} } } as unknown as JobHelpers;
    await task({}, helpers);
  });

  afterAll(async () => {
    globalThis.fetch = realFetch;
    await cleanup();
    if (!hadRun) await sql`DELETE FROM source_universe_runs WHERE source_id = ${SOURCE}`;
  });

  const resolvedFor = async (cd: number): Promise<bigint | null | undefined> => {
    const [row] = await sql<{ resolved: bigint | null }[]>`
      SELECT resolved_dam_id AS resolved FROM source_universe
      WHERE source_id = ${SOURCE} AND source_external_id = ${String(cd)}`;
    return row?.resolved;
  };

  test('resolves the dam that reported this run', async () => {
    expect(await resolvedFor(REPORTING.cd)).toBe(ids.get(REPORTING.slug) as bigint);
  });

  test('resolves a stamped dam that did not report this run', async () => {
    expect(await resolvedFor(SILENT.cd)).toBe(ids.get(SILENT.slug) as bigint);
  });
});
