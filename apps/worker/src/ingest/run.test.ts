import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'bun:test';
import { sql } from '@dam/db/client';
import { runScan } from './run.ts';
import { type Entry, IngestRunError, type Scan } from './types.ts';

// Scoped to this source id and these slugs: never touch other rows.
const SOURCE = 'ingest-run-test';
const SLUGS = ['ingest-run-a', 'ingest-run-b', 'ingest-run-c'];
const PREF = '47';
const POINT = '0101000020e6100000000000000000614000000000008045c0';
const AT = new Date('2026-10-01T00:00:00Z');
const LATER = new Date('2026-10-02T00:00:00Z');

let damA = 0n;
let damB = 0n;

async function cleanup(): Promise<void> {
  await sql`DELETE FROM observations WHERE dam_id IN (SELECT id FROM dams WHERE slug = ANY(${SLUGS}::TEXT[]))`;
  await sql`DELETE FROM source_universe WHERE source_id = ${SOURCE}`;
  await sql`DELETE FROM source_universe_runs WHERE source_id = ${SOURCE}`;
  await sql`DELETE FROM dams WHERE slug = ANY(${SLUGS}::TEXT[])`;
}

async function seedDam(slug: string, name: string): Promise<bigint> {
  const [r] = await sql<{ id: bigint }[]>`
    INSERT INTO dams (slug, name, pref_code, location, total_capacity_m3, active_capacity_m3)
    VALUES (${slug}, ${name}, ${PREF}, ${POINT}::geography, 2000000, 1000000)
    RETURNING id
  `;
  if (!r) throw new Error('seed failed');
  return r.id;
}

beforeAll(async () => {
  await cleanup();
  damA = await seedDam('ingest-run-a', '試験甲ダム');
  damB = await seedDam('ingest-run-b', '試験乙');
});

beforeEach(async () => {
  await sql`DELETE FROM observations WHERE dam_id IN (${damA}, ${damB})`;
  await sql`DELETE FROM source_universe WHERE source_id = ${SOURCE}`;
  await sql`DELETE FROM source_universe_runs WHERE source_id = ${SOURCE}`;
  await sql`UPDATE dams SET external_ids = external_ids - ${SOURCE}::TEXT WHERE slug = ANY(${SLUGS}::TEXT[])`;
});

afterAll(cleanup);

const run = (scan: Scan) =>
  runScan(
    SOURCE,
    async () => scan,
    () => {},
  );
const values = (storageVolumeM3: number, observedAt = AT) =>
  ({ state: 'values', observations: [{ observedAt, storageVolumeM3 }] }) as const;

async function universe() {
  const rows = await sql<
    { key: string; dam: bigint | null; hasData: boolean | null; publishedAt: Date | null }[]
  >`
    SELECT source_external_id AS key, resolved_dam_id AS dam, has_data AS "hasData",
           published_at AS "publishedAt"
    FROM source_universe WHERE source_id = ${SOURCE} ORDER BY 1
  `;
  return [...rows];
}
async function written() {
  const rows = await sql<{ dam: bigint; at: Date }[]>`
    SELECT dam_id AS dam, observed_at AS at FROM observations
    WHERE dam_id IN (${damA}, ${damB}) AND source_id = ${SOURCE} ORDER BY 1, 2
  `;
  return [...rows];
}
async function stamps() {
  const rows = await sql<{ slug: string; key: string | null }[]>`
    SELECT slug, external_ids->>${SOURCE} AS key FROM dams WHERE slug = ANY(${SLUGS}::TEXT[]) ORDER BY 1
  `;
  return [...rows];
}

describe('runScan', () => {
  test('records every entry with its state, and writes only bound values', async () => {
    const entries: Entry[] = [
      { key: 'A', name: '試験甲', pref: PREF, reading: values(500) },
      { key: 'B', name: '試験乙', pref: PREF, reading: { state: 'empty', mark: '調査対象外' } },
      { key: 'X', name: '未登録', pref: PREF, reading: values(1) },
      {
        key: 'U',
        name: '試験甲',
        pref: PREF,
        bind: 'never',
        reading: { state: 'unreadable', why: '?' },
      },
    ];
    await run({ entries });
    expect(await universe()).toEqual([
      { key: 'A', dam: damA, hasData: true, publishedAt: null },
      { key: 'B', dam: damB, hasData: false, publishedAt: null },
      { key: 'U', dam: null, hasData: null, publishedAt: null },
      { key: 'X', dam: null, hasData: true, publishedAt: null },
    ]);
    expect(await written()).toEqual([{ dam: damA, at: AT }]);
    expect(await stamps()).toEqual([
      { slug: 'ingest-run-a', key: 'A' },
      { slug: 'ingest-run-b', key: 'B' },
    ]);
  });

  test('a reading function that throws makes its entry unreadable, not missing', async () => {
    await run({
      entries: [
        { key: 'A', name: '試験甲', pref: PREF, reading: values(500) },
        {
          key: 'B',
          name: '試験乙',
          pref: PREF,
          reading: () => {
            throw new Error('HTTP 503');
          },
        },
      ],
    });
    expect((await universe()).map((r) => [r.key, r.hasData])).toEqual([
      ['A', true],
      ['B', null],
    ]);
  });

  test('a reading function receives the bound dam and its capacities', async () => {
    const seen: { id: bigint; total: number | null }[] = [];
    await run({
      entries: [
        {
          key: 'A',
          name: '試験甲',
          pref: PREF,
          reading: (dam) => {
            if (dam) seen.push({ id: dam.id, total: dam.totalCapacityM3 });
            return values(1);
          },
        },
      ],
    });
    expect(seen).toEqual([{ id: damA, total: 2_000_000 }]);
  });

  test('a dated source records the newest written observedAt as publishedAt', async () => {
    await run({
      dated: true,
      entries: [
        {
          key: 'A',
          name: '試験甲',
          pref: PREF,
          reading: {
            state: 'values',
            observations: [
              { observedAt: AT, storageVolumeM3: 1 },
              { observedAt: LATER, storageVolumeM3: 2 },
            ],
          },
        },
        { key: 'B', name: '試験乙', pref: PREF, reading: { state: 'empty', mark: '-' } },
      ],
    });
    expect((await universe()).map((r) => [r.key, r.publishedAt])).toEqual([
      ['A', LATER],
      ['B', null],
    ]);
  });

  test('a dontWrite entry is resolved but neither stamped nor written', async () => {
    await run({
      entries: [
        { key: 'A', name: '試験甲', pref: PREF, dontWrite: 'better source', reading: values(5) },
        { key: 'B', name: '試験乙', pref: PREF, reading: values(6) },
      ],
    });
    expect((await universe()).map((r) => [r.key, r.dam])).toEqual([
      ['A', damA],
      ['B', damB],
    ]);
    expect(await written()).toEqual([{ dam: damB, at: AT }]);
    expect((await stamps()).map((s) => s.key)).toEqual([null, 'B']);
  });

  test('a second entry on an already-fed dam is recorded, not written or stamped', async () => {
    await run({
      entries: [
        { key: 'A1', name: '試験甲', pref: PREF, reading: values(5) },
        { key: 'A2', name: '試験甲ダム', pref: PREF, reading: values(7, LATER) },
      ],
    });
    expect((await universe()).map((r) => [r.key, r.dam])).toEqual([
      ['A1', damA],
      ['A2', damA],
    ]);
    expect(await written()).toEqual([{ dam: damA, at: AT }]);
    expect((await stamps())[0]?.key).toBe('A1');
  });

  test('an observation with no value is not written, and alone makes the entry unreadable', async () => {
    await run({
      entries: [
        {
          key: 'A',
          name: '試験甲',
          pref: PREF,
          reading: { state: 'values', observations: [{ observedAt: AT }] },
        },
        { key: 'B', name: '試験乙', pref: PREF, reading: values(6) },
      ],
    });
    expect((await universe()).map((r) => [r.key, r.hasData])).toEqual([
      ['A', null],
      ['B', true],
    ]);
    expect(await written()).toEqual([{ dam: damB, at: AT }]);
  });

  test('when nothing could be read the universe is committed, then the job fails', async () => {
    const scan = {
      entries: [
        { key: 'A', name: '試験甲', pref: PREF, reading: { state: 'unreadable', why: 'layout' } },
      ],
    } satisfies Scan;
    const err = await run(scan).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(IngestRunError);
    expect((err as IngestRunError).kind).toBe('nothing-read');
    expect((await universe()).map((r) => r.key)).toEqual(['A']);
  });

  test('an empty scan is a contract error and writes no scan', async () => {
    const err = await run({ entries: [] }).catch((e: unknown) => e);
    expect((err as IngestRunError).kind).toBe('contract');
    const runs = await sql`SELECT 1 FROM source_universe_runs WHERE source_id = ${SOURCE}`;
    expect(runs.length).toBe(0);
  });

  test('a failed observation write rolls the universe back too', async () => {
    // storage_rate is NUMERIC(6,4): 100 overflows it.
    const err = await run({
      entries: [
        {
          key: 'A',
          name: '試験甲',
          pref: PREF,
          reading: { state: 'values', observations: [{ observedAt: AT, storageRate: 100 }] },
        },
      ],
    }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(Error);
    expect(await universe()).toEqual([]);
    expect((await stamps()).map((s) => s.key)).toEqual([null, null]);
  });
});
