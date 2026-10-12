// #122: every "newest reading" pick breaks a same-observed_at tie by the rule
// display_observation() and obs_daily follow since 0223 — the higher active
// source_priorities.priority, inactive/unlisted below every active source,
// then the greater source_id. Before, the pick was whichever row the plan met
// first, which on these tiny fixtures is insertion order: each tie below is
// seeded in both orders, so a pick that ignores the rule fails one of them.

import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { sql } from '../client.ts';
import { latestRateAndSourceByDam, storageChange, upsertDamByExternalId } from './dams.ts';
import { newestFirst, sourceRankJoin } from './newest_row.ts';
import { damSeasonalNorm, watershedSeasonalNorm } from './seasonal.ts';
import { storageTotalsByWatershed } from './storage_totals.ts';
import { upsertWatershed, watershedStorageChange } from './watersheds.ts';

const HOUR = 3600 * 1000;
const DAY = 24 * HOUR;

describe('newestFirst()', () => {
  type Row = [hoursAgo: number, sourceId: string];

  /** The pick among `rows`, against a source_priorities of exactly `priorities`. */
  async function pick(
    rows: Row[],
    priorities: [sourceId: string, priority: number, active: boolean][],
  ): Promise<string | undefined> {
    const now = Date.now();
    return sql.begin(async (tx) => {
      // Shadows the real table for this transaction only (pg_temp is searched first).
      await tx`CREATE TEMP TABLE source_priorities (source_id TEXT PRIMARY KEY, priority INT, active BOOLEAN) ON COMMIT DROP`;
      for (const [id, priority, active] of priorities) {
        await tx`INSERT INTO source_priorities VALUES (${id}, ${priority}, ${active})`;
      }
      const [row] = await tx<{ source_id: string }[]>`
        SELECT o.source_id
        FROM unnest(
          ${rows.map(([h]) => new Date(now - h * HOUR).toISOString())}::TIMESTAMPTZ[],
          ${rows.map(([, id]) => id)}::TEXT[]
        ) AS o(observed_at, source_id)
        ${sourceRankJoin()}
        ORDER BY ${newestFirst()}
        LIMIT 1
      `;
      return row?.source_id;
    });
  }

  /** Both row orders must give `expected`. */
  async function expectPick(
    rows: Row[],
    priorities: [string, number, boolean][],
    expected: string,
  ): Promise<void> {
    expect(await pick(rows, priorities)).toBe(expected);
    expect(await pick([...rows].reverse(), priorities)).toBe(expected);
  }

  test('the newest observed_at wins whatever its rank', async () => {
    await expectPick(
      [
        [1, 'a-high'],
        [0, 'b-unlisted'],
      ],
      [['a-high', 500, true]],
      'b-unlisted',
    );
  });

  test('on a tie the higher active priority wins over a greater source_id', async () => {
    await expectPick(
      [
        [0, 'a-high'],
        [0, 'b-low'],
      ],
      [
        ['a-high', 200, true],
        ['b-low', 100, true],
      ],
      'a-high',
    );
  });

  test('an inactive source ranks below every active one, whatever its priority', async () => {
    await expectPick(
      [
        [0, 'a-active'],
        [0, 'z-inactive'],
      ],
      [
        ['a-active', 1, true],
        ['z-inactive', 999, false],
      ],
      'a-active',
    );
  });

  test('an unlisted source ranks below every active one', async () => {
    await expectPick(
      [
        [0, 'a-active'],
        [0, 'z-unlisted'],
      ],
      [['a-active', 1, true]],
      'a-active',
    );
  });

  test('equal rank falls to the greater source_id', async () => {
    await expectPick(
      [
        [0, 'a-same'],
        [0, 'b-same'],
      ],
      [
        ['a-same', 50, true],
        ['b-same', 50, true],
      ],
      'b-same',
    );
    // Inactive and unlisted rank alike.
    await expectPick(
      [
        [0, 'm-inactive'],
        [0, 'n-unlisted'],
      ],
      [['m-inactive', 999, false]],
      'n-unlisted',
    );
  });
});

describe('newest-row picks break timestamp ties by source priority (#122)', () => {
  // A real active source and the unlisted fixture source every other test
  // uses: on priority the real one wins, on source_id alone 'test' would.
  const RANKED = 'kasenbosai';
  const UNLISTED = 'test';
  const SLUG = 'newest-row-tie-test';
  const WS_CODE = 'TEST-NEWEST-ROW';
  const WS_SLUG = 'test-newest-row';
  // The volume each source reports at the newest hour (C) and the hour before.
  const AT_C: Record<string, number> = { [RANKED]: 1800000, [UNLISTED]: 1660000 };
  const AT_C_1H: Record<string, number> = { [RANKED]: 1700000, [UNLISTED]: 1500000 };

  let watershedId: bigint;
  let damId: bigint;
  let winner: string;
  const c = new Date(Math.floor(Date.now() / HOUR) * HOUR - HOUR);
  const c1h = new Date(c.getTime() - HOUR);
  const historyWindow = `NOW() - INTERVAL '800 days', NOW() - INTERVAL '61 days'`;

  async function cleanup(): Promise<void> {
    const rows = await sql<{ id: bigint }[]>`SELECT id FROM dams WHERE slug = ${SLUG}`;
    for (const r of rows) {
      await sql`DELETE FROM observations WHERE dam_id = ${r.id}`;
      await sql`DELETE FROM dams WHERE id = ${r.id}`;
    }
    await sql`DELETE FROM watersheds WHERE code = ${WS_CODE}`;
  }

  /** The tied rows at C and C−1h, inserted in `order` (one statement per row). */
  async function seedTies(order: string[]): Promise<void> {
    await sql`DELETE FROM observations WHERE dam_id = ${damId} AND observed_at >= ${c1h}`;
    for (const at of [c1h, c]) {
      for (const src of order) {
        const volume = (at === c ? AT_C : AT_C_1H)[src] as number;
        await sql`
          INSERT INTO observations (dam_id, observed_at, source_id, storage_volume_m3)
          VALUES (${damId}, ${at}, ${src}, ${volume})
        `;
      }
    }
  }

  beforeAll(async () => {
    await cleanup();
    // Seeded by its adapter on a real DB; a bare test DB has to insert it.
    await sql`
      INSERT INTO source_priorities (source_id, priority, trusted_rate_basis)
      VALUES (${RANKED}, 100, TRUE)
      ON CONFLICT (source_id) DO NOTHING
    `;
    const [w] = await sql<{ source_id: string }[]>`
      SELECT s.source_id
      FROM unnest(${[RANKED, UNLISTED]}::TEXT[]) AS s(source_id)
      LEFT JOIN source_priorities sp ON sp.source_id = s.source_id
      ORDER BY COALESCE(CASE WHEN sp.active THEN sp.priority END, -1) DESC, s.source_id DESC
      LIMIT 1
    `;
    winner = w?.source_id as string;

    watershedId = await upsertWatershed({
      code: WS_CODE,
      slug: WS_SLUG,
      name: 'Newest Row Test',
      kind: 'other',
      // Far offshore so it never overlaps a real watershed polygon.
      boundaryGeoJSON: {
        type: 'MultiPolygon',
        coordinates: [
          [
            [
              [160.0, 30.0],
              [161.0, 30.0],
              [161.0, 31.0],
              [160.0, 31.0],
              [160.0, 30.0],
            ],
          ],
        ],
      },
    });
    damId = await upsertDamByExternalId('ndi', {
      slug: SLUG,
      name: 'Newest Row Tie Test',
      prefCode: '13',
      watershedId,
      lat: 30.5,
      lng: 160.5,
      externalIds: { ndi: 'NEWEST-ROW-TIE' },
    });
    await sql`UPDATE dams SET active_capacity_m3 = 5000000 WHERE id = ${damId}`;

    // Same-season history in the two previous years, so the 平年比 has a norm.
    const now = Date.now();
    for (const d of [364, 365, 366, 729, 730, 731]) {
      await sql`
        INSERT INTO observations (dam_id, observed_at, source_id, storage_volume_m3)
        VALUES (${damId}, ${new Date(now - d * DAY)}, ${UNLISTED}, 1000000)
      `;
    }
    await sql.unsafe(`CALL refresh_continuous_aggregate('obs_daily', ${historyWindow})`);
  });

  afterAll(async () => {
    await cleanup();
    await sql.unsafe(`CALL refresh_continuous_aggregate('obs_daily', ${historyWindow})`);
  });

  for (const order of [
    [RANKED, UNLISTED],
    [UNLISTED, RANKED],
  ]) {
    describe(`inserted ${order.join(' then ')}`, () => {
      beforeAll(() => seedTies(order));

      test('watershedStorageChange', async () => {
        const ch = await watershedStorageChange(watershedId);
        expect(Number(ch.current)).toBe(AT_C[winner] as number);
        expect(Number(ch.h1)).toBe(AT_C_1H[winner] as number);
      });

      test('storage totals cohort', async () => {
        const t = (await storageTotalsByWatershed()).get(WS_SLUG);
        expect(Number(t?.storageM3)).toBe(AT_C[winner] as number);
      });

      test('seasonal current volume', async () => {
        expect(Number((await damSeasonalNorm(damId))?.currentVolumeM3)).toBe(
          AT_C[winner] as number,
        );
        expect(Number((await watershedSeasonalNorm(watershedId))?.currentVolumeM3)).toBe(
          AT_C[winner] as number,
        );
      });

      test('storageChange lookback', async () => {
        expect(Number((await storageChange(damId)).h1)).toBe(AT_C_1H[winner] as number);
      });

      test('latestRateAndSourceByDam realSourceId', async () => {
        const m = await latestRateAndSourceByDam([damId]);
        expect(m.get(damId.toString())?.realSourceId).toBe(winner);
      });
    });
  }
});
