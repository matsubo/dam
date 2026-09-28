// apps/worker/src/tasks/ingest_kudamatsu_suido.test.ts
//
// Fixture is a verbatim UTF-8 capture of 下松市上下水道局「水源情報」
// (city.kudamatsu.lg.jp/sui-gyoumu/~k-water/damu_001.html) taken 2026-09-28:
// 県営温見ダム 令和8年9月3日0時現在, 県営末武川ダム 令和8年9月1日0時現在.

import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { sql } from '@dam/db/client';
import type { JobHelpers } from 'graphile-worker';
import task, { parseKudamatsuSuigen } from './ingest_kudamatsu_suido.ts';

const FIXTURE = join(
  import.meta.dir,
  '..',
  '..',
  '..',
  '..',
  'tests/fixtures/kudamatsu_suido/suigen_2026-09-28.html',
);

const html = await readFile(FIXTURE, 'utf8');

function section(h3: string, stamp: string, rows: string): string {
  return `<h3>${h3}</h3>\n<p>${stamp}</p>\n<table class="datatable"><tbody>${rows}</tbody></table>`;
}

describe('parseKudamatsuSuigen', () => {
  test('lists both 状況 sections and not the 概要 block', () => {
    expect(parseKudamatsuSuigen(html).map((d) => d.name)).toEqual(['温見ダム', '末武川ダム']);
  });

  test('each section carries its own 「…0時現在」 stamp, read as JST', () => {
    const [nukumi, suetake] = parseKudamatsuSuigen(html);
    expect(nukumi?.observedAt?.toISOString()).toBe('2026-09-02T15:00:00.000Z');
    expect(suetake?.observedAt?.toISOString()).toBe('2026-08-31T15:00:00.000Z');
  });

  test('reads 水位 / 貯水量 / 貯水率, not the 満水位 / 総貯水量 / 利水量 printed beside them', () => {
    const [nukumi, suetake] = parseKudamatsuSuigen(html);
    expect(nukumi?.waterLevelM).toBe(271.57);
    expect(nukumi?.storageVolumeM3).toBe(4_319_680);
    expect(nukumi?.storageRate).toBeCloseTo(0.956, 6);
    expect(suetake?.waterLevelM).toBe(135.19);
    expect(suetake?.storageVolumeM3).toBe(12_722_000);
    expect(suetake?.storageRate).toBeCloseTo(0.921, 6);
  });

  test('令和元年 and a stamp without 時 are 00:00 JST', () => {
    const page = section(
      '県営温見ダムの状況',
      '令和元年5月1日現在',
      '<tr><th>水位</th><td><p>270.00m</p></td></tr>',
    );
    expect(parseKudamatsuSuigen(page)[0]?.observedAt?.toISOString()).toBe(
      '2019-04-30T15:00:00.000Z',
    );
  });

  test('a missing-value marker is null, not 0', () => {
    const page = section(
      '県営温見ダムの状況',
      '令和8年10月1日0時現在',
      '<tr><th>水位</th><td><p>－</p></td><th>満水位</th><td>272.2m</td></tr>' +
        '<tr><th>貯水量</th><td><p>欠測</p></td></tr>' +
        '<tr><th>貯水率</th><td><p>&nbsp;</p></td></tr>',
    );
    expect(parseKudamatsuSuigen(page)).toEqual([
      {
        name: '温見ダム',
        observedAt: new Date('2026-09-30T15:00:00.000Z'),
        waterLevelM: null,
        storageVolumeM3: null,
        storageRate: null,
      },
    ]);
  });

  test('a section without a readable 現在 stamp keeps its name but no date', () => {
    const page = section('県営温見ダムの状況', '調整中', '');
    expect(parseKudamatsuSuigen(page)[0]?.observedAt).toBeNull();
  });
});

describe('task: a section without a stamp', () => {
  // The page lists two dams; one loses its 「…現在」 line. The run must still
  // record the whole published list and write the dated dam before failing.
  const SOURCE = 'kudamatsu-suido';
  const DATED = { slug: 'kudamatsu-test-dated', name: '試験下松甲' };
  const UNDATED = { slug: 'kudamatsu-test-undated', name: '試験下松乙' };
  const KEYS = [`${DATED.name}ダム`, `${UNDATED.name}ダム`];
  const ids = new Map<string, bigint>();
  const realFetch = globalThis.fetch;
  let hadRun = false;
  let outcome: unknown;

  async function cleanup(): Promise<void> {
    await sql`
      DELETE FROM source_universe
      WHERE source_id = ${SOURCE} AND source_external_id IN ${sql(KEYS)}`;
    await sql`
      DELETE FROM observations WHERE dam_id IN (
        SELECT id FROM dams WHERE slug IN (${DATED.slug}, ${UNDATED.slug}))`;
    await sql`DELETE FROM dams WHERE slug IN (${DATED.slug}, ${UNDATED.slug})`;
  }

  beforeAll(async () => {
    await cleanup();
    const [run] = await sql`SELECT 1 FROM source_universe_runs WHERE source_id = ${SOURCE}`;
    hadRun = run !== undefined;
    for (const d of [DATED, UNDATED]) {
      const [r] = await sql<{ id: bigint }[]>`
        INSERT INTO dams (slug, name, pref_code, location)
        VALUES (${d.slug}, ${d.name}, '35',
                ST_SetSRID(ST_MakePoint(131.9, 34.1), 4326)::geography)
        RETURNING id`;
      ids.set(d.slug, r?.id ?? 0n);
    }
    const page =
      section(
        `県営${DATED.name}ダムの状況`,
        '令和8年9月3日0時現在',
        '<tr><th>水位</th><td><p>271.57m</p></td></tr>' +
          '<tr><th>貯水量</th><td><p>4,319,680立法メートル</p></td></tr>',
      ) + section(`県営${UNDATED.name}ダムの状況`, '調整中', '');
    globalThis.fetch = (async () => new Response(page)) as unknown as typeof fetch;
    const helpers = { logger: { info: () => {} } } as unknown as JobHelpers;
    try {
      await task({}, helpers);
    } catch (e) {
      outcome = e;
    }
  });

  afterAll(async () => {
    globalThis.fetch = realFetch;
    await cleanup();
    if (!hadRun) await sql`DELETE FROM source_universe_runs WHERE source_id = ${SOURCE}`;
  });

  test('still fails the run, naming the undated dam', () => {
    expect(String(outcome)).toContain(`${UNDATED.name}ダム`);
  });

  test('records both published dams in the universe', async () => {
    const rows = await sql<{ key: string; resolved: bigint | null }[]>`
      SELECT source_external_id AS key, resolved_dam_id AS resolved FROM source_universe
      WHERE source_id = ${SOURCE} AND source_external_id IN ${sql(KEYS)}
      ORDER BY source_external_id`;
    expect([...rows]).toEqual([
      { key: `${UNDATED.name}ダム`, resolved: ids.get(UNDATED.slug) ?? null },
      { key: `${DATED.name}ダム`, resolved: ids.get(DATED.slug) ?? null },
    ]);
  });

  test('writes the dated dam', async () => {
    const rows = await sql<{ at: Date; level: number }[]>`
      SELECT observed_at AS at, water_level_m::float8 AS level FROM observations
      WHERE source_id = ${SOURCE} AND dam_id = ${ids.get(DATED.slug) ?? 0n}`;
    expect([...rows]).toEqual([{ at: new Date('2026-09-02T15:00:00.000Z'), level: 271.57 }]);
  });
});
