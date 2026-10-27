// apps/worker/src/tasks/ingest_jwa_chikugo_rt.test.ts
//
// Fixture → universe entries, no database: binding and writing belong to the
// ingest run (apps/worker/src/ingest/run.test.ts).
//
// Fixtures are verbatim Shift_JIS captures of 水資源機構 筑後川局
// 水管理情報WEB (chikugo.ec-net.jp/chikugo/kyoku/pc/new/rep{EG,KB,CO}_I60.html):
// EG and KB taken 2026-09-27 21:43 JST (24 hourly rows, 2026/09/26 22:00 …
// 09/27 21:00); CO taken 2026-09-28 12:55 JST (09/27 13:00 … 09/28 12:00).

import { describe, expect, test } from 'bun:test';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { bindEntry, type Master } from '../ingest/bind.ts';
import type { Entry, Reading } from '../ingest/types.ts';
import { fixtureUpstream } from '../ingest/upstream.ts';
import {
  chikugoRtEntries,
  chikugoRtReading,
  pageUrl,
  parseChikugoRtPage,
} from './ingest_jwa_chikugo_rt.ts';

const FIXTURE_DATE: Record<string, string> = {
  EG: '2026-09-27',
  KB: '2026-09-27',
  CO: '2026-09-28',
};

function pageBytes(code: string): Promise<Uint8Array> {
  const path = join(
    import.meta.dir,
    '..',
    '..',
    '..',
    '..',
    `tests/fixtures/jwa_chikugo_rt/rep${code}_I60_${FIXTURE_DATE[code]}.shiftjis.html`,
  );
  return readFile(path);
}

async function page(code: string): Promise<string> {
  return new TextDecoder('shift_jis').decode(await pageBytes(code));
}

/** Serves the captured pages; a station without a capture answers like a dead page. */
const fixtures = fixtureUpstream((url) => {
  const code = Object.keys(FIXTURE_DATE).find((c) => url === pageUrl(c));
  return code ? pageBytes(code) : { status: 503 };
});

async function readingOf(e: Entry | undefined): Promise<Reading> {
  if (!e) throw new Error('no entry');
  return typeof e.reading === 'function' ? e.reading(null) : e.reading;
}

describe('parseChikugoRtPage', () => {
  test('reads every hourly row of 小石原川ダム in JST, oldest first', async () => {
    const { rows } = parseChikugoRtPage(await page('KB'));
    expect(rows).toHaveLength(24);
    expect(rows[0]).toEqual({
      observedAt: new Date('2026-09-26T13:00:00Z'), // 09/26 22:00 JST
      waterLevelM: 321.72,
      storageVolumeM3: 12_617_000,
      storageRate: 0.36,
      inflowM3s: 2.29,
      // 総放流量, not the 利水ゲート放流量 (0.00) printed two columns earlier.
      outflowM3s: 0.45,
      rainfallMm: 0,
    });
    expect(rows[23]?.observedAt).toEqual(new Date('2026-09-27T12:00:00Z'));
    expect(rows[23]?.storageVolumeM3).toBe(12_874_000);
  });

  test('reads "24:00" under the previous date as midnight of the next day', async () => {
    const { rows } = parseChikugoRtPage(await page('KB'));
    expect(rows[2]?.observedAt).toEqual(new Date('2026-09-26T15:00:00Z')); // 09/27 00:00 JST
    expect(rows[2]?.waterLevelM).toBe(321.75);
    expect(rows[3]?.observedAt).toEqual(new Date('2026-09-26T16:00:00Z')); // 09/27 01:00 JST
    const times = rows.map((r) => r.observedAt.getTime());
    expect(new Set(times).size).toBe(24);
  });

  test('maps the 欠測 marker to null without dropping the row', async () => {
    const { rows } = parseChikugoRtPage(await page('EG'));
    expect(rows).toHaveLength(24);
    expect(rows[0]).toMatchObject({
      waterLevelM: 188.21,
      storageVolumeM3: 3_011_000,
      storageRate: 0.125,
      outflowM3s: 0.23,
      rainfallMm: null, // ***
    });
  });

  test('reads 筑後大堰 pool level, not its 設定水位, and neither its fixed 有効貯水量 nor flows', async () => {
    // The 有効貯水量 column prints the pool's 930 千m³ capacity in every row,
    // 3.13–3.63 m alike; water-source.html gave 820 千m³ (88.2 %) for 9/25 0時.
    const { rows } = parseChikugoRtPage(await page('CO'));
    expect(rows).toHaveLength(24);
    expect(rows[0]).toEqual({
      observedAt: new Date('2026-09-27T04:00:00Z'), // 09/27 13:00 JST
      waterLevelM: 3.16,
      storageVolumeM3: null,
      storageRate: null,
      inflowM3s: null,
      outflowM3s: null,
      rainfallMm: 11,
    });
    expect(rows.filter((r) => r.storageVolumeM3 !== null)).toEqual([]);
  });
});

describe('chikugoRtReading', () => {
  test('a page whose every hour is *** in every column is provider-marked empty', async () => {
    const html = (await page('EG')).replace(
      /(<td class="data"[^>]*>)-?\d+(?:\.\d+)?(&nbsp;<\/td>)/g,
      '$1***$2',
    );
    expect(chikugoRtReading(parseChikugoRtPage(html))).toEqual({
      state: 'empty',
      mark: '*** in every column of every hour',
    });
  });

  test('a page without hourly rows is unreadable', () => {
    expect(chikugoRtReading(parseChikugoRtPage('<html>メンテナンス中</html>')).state).toBe(
      'unreadable',
    );
  });
});

describe('chikugoRtEntries', () => {
  const entries = chikugoRtEntries(fixtures);

  test('lists the menu’s five stations, keyed by screen id, in their prefectures', () => {
    expect(entries.map((e) => [e.key, e.name, e.pref])).toEqual([
      ['EG', '江川ダム', '40'],
      ['TR', '寺内ダム', '40'],
      ['KB', '小石原川ダム', '40'],
      ['OY', '大山ダム', '44'],
      ['CO', '筑後大堰', '40'],
    ]);
  });

  test('reads each station’s whole 24 h window from its own page', async () => {
    const kb = await readingOf(entries.find((e) => e.key === 'KB'));
    expect(kb.state).toBe('values');
    if (kb.state !== 'values') return;
    expect(kb.observations).toHaveLength(24);
    expect(kb.observations[0]?.storageVolumeM3).toBe(12_617_000);
  });

  test('a page that fails to fetch throws, so the run records the station unreadable', async () => {
    await expect(readingOf(entries.find((e) => e.key === 'TR'))).rejects.toThrow('HTTP 503');
  });

  test('binds by name only, never by prefix or contains: 大山 is not 大山川', () => {
    for (const e of entries) expect(e.bind).toEqual({ exact: true });
    const master = (id: number, name: string): Master => ({
      id: BigInt(id),
      name,
      completedYear: null,
      stamp: null,
      prefCode: '44',
      ndi: null,
      totalCapacityM3: null,
      activeCapacityM3: null,
    });
    const oy = entries.find((e) => e.key === 'OY');
    if (!oy) throw new Error('no OY');
    expect(bindEntry(oy, [master(1, '大山川')], false).dam).toBeNull();
    expect(bindEntry(oy, [master(1, '大山川'), master(2, '大山')], false).dam?.id).toBe(2n);
  });
});
