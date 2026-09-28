// apps/worker/src/tasks/ingest_sokobaru_dam.test.ts
//
// Fixtures are verbatim Shift_JIS captures of the 底原ダム管理システム pages
// (www.cosmos.ne.jp/~sokobaru/) taken 2026-09-28 15:54 JST: the menu, each
// dam's 水文量 page (「2026/09/28 15:52 現在」) and every hourly page those
// link to (newest row 15:00, back to 03:00). 底原 carries values in every
// row; 真栄里 has 貯水位/総貯水量 from 11:00 on and ** before, 放流量 ** all
// day; 石垣 is ** in every row of every page.

import { describe, expect, test } from 'bun:test';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import {
  chooseMaster,
  hasDataOf,
  type NdiMaster,
  parseFieldLinks,
  parseHourlyPage,
  readingsOf,
  usableVolumeM3,
} from './ingest_sokobaru_dam.ts';

const DIR = join(
  import.meta.dir,
  '..',
  '..',
  '..',
  '..',
  'tests/fixtures/sokobaru_dam/2026-09-28T1554',
);

async function page(name: string): Promise<string> {
  return new TextDecoder('shift_jis').decode(await readFile(join(DIR, name)));
}

async function series(...names: string[]) {
  return Promise.all(names.map(async (n) => parseHourlyPage(await page(n))));
}

describe('parseHourlyPage', () => {
  test('reads the label, unit and 13 hourly values, newest first, at JST', async () => {
    const s = parseHourlyPage(await page('00001002.html'));
    expect(s?.label).toBe('貯水位');
    expect(s?.unit).toBe('EL.m');
    expect(s?.points).toHaveLength(13);
    expect(s?.points[0]).toEqual({
      observedAt: new Date('2026-09-28T06:00:00.000Z'),
      value: 35.65,
    });
    expect(s?.points[1]).toEqual({
      observedAt: new Date('2026-09-28T05:00:00.000Z'),
      value: 38.21,
    });
    expect(s?.points[12]?.observedAt).toEqual(new Date('2026-09-27T18:00:00.000Z'));
  });

  test('reads ** as a missing value', async () => {
    const s = parseHourlyPage(await page('00004002.html'));
    expect(s?.points[4]).toEqual({ observedAt: new Date('2026-09-28T02:00:00.000Z'), value: 38 });
    expect(s?.points[5]).toEqual({ observedAt: new Date('2026-09-28T01:00:00.000Z'), value: null });
  });

  test('puts the rows before midnight on the previous day', async () => {
    const html = (await page('00001002.html'))
      .replace('2026/09/28 15:00', '2026/09/28 01:00')
      .replace(/(\d{2}):00(\u3000)/g, (_m, h: string, sp: string) => {
        const shifted = (Number(h) - 14 + 24) % 24;
        return `${String(shifted).padStart(2, '0')}:00${sp}`;
      });
    const s = parseHourlyPage(html);
    expect(s?.points[0]?.observedAt).toEqual(new Date('2026-09-27T16:00:00.000Z')); // 09/28 01:00
    expect(s?.points[1]?.observedAt).toEqual(new Date('2026-09-27T15:00:00.000Z')); // 09/28 00:00
    expect(s?.points[2]?.observedAt).toEqual(new Date('2026-09-27T14:00:00.000Z')); // 09/27 23:00
    expect(s?.points[12]?.observedAt).toEqual(new Date('2026-09-27T04:00:00.000Z')); // 09/27 13:00
  });

  test('refuses a page without the dated header', async () => {
    expect(parseHourlyPage(await page('00001001.html'))).toBeNull();
  });
});

describe('parseFieldLinks', () => {
  test("lists each reading's hourly page from a dam's 水文量 page", async () => {
    expect(parseFieldLinks(await page('00004001.html'))).toEqual([
      { href: '00004002.html', label: '貯水位' },
      { href: '00004003.html', label: '総貯水量' },
      { href: '00004004.html', label: '放流量' },
    ]);
  });
});

describe('readingsOf', () => {
  test('merges 底原 into one row per hour: level, gross volume, rate, inflow, outflow', async () => {
    const rows = readingsOf(
      await series(
        '00001002.html',
        '00001003.html',
        '00001004.html',
        '00001006.html',
        '00001007.html',
      ),
    );
    expect(rows).toHaveLength(13);
    expect(rows.find((r) => r.observedAt.toISOString() === '2026-09-28T05:00:00.000Z')).toEqual({
      observedAt: new Date('2026-09-28T05:00:00.000Z'),
      waterLevelM: 38.21,
      grossVolumeM3: 11_279_000,
      storageRate: 0.866,
      inflowM3s: 0,
      outflowM3s: 0.11,
    });
  });

  test('drops the hours where every reading is **', async () => {
    const rows = readingsOf(await series('00004002.html', '00004003.html', '00004004.html'));
    expect(rows.map((r) => r.observedAt.toISOString())).toEqual([
      '2026-09-28T06:00:00.000Z',
      '2026-09-28T05:00:00.000Z',
      '2026-09-28T04:00:00.000Z',
      '2026-09-28T03:00:00.000Z',
      '2026-09-28T02:00:00.000Z',
    ]);
    expect(rows[0]).toEqual({
      observedAt: new Date('2026-09-28T06:00:00.000Z'),
      waterLevelM: 38,
      grossVolumeM3: 1_500_000,
      storageRate: null,
      inflowM3s: null,
      outflowM3s: null,
    });
  });

  test('yields nothing for 石垣, ** on every page', async () => {
    expect(readingsOf(await series('00005002.html', '00005003.html', '00005004.html'))).toEqual([]);
  });

  test('ignores pages that are not a stored reading (放流管 is one outlet of 全放流量)', async () => {
    const outlet = (await page('00001007.html')).replaceAll('全放流量', '放流管');
    expect(readingsOf([parseHourlyPage(outlet)])).toEqual([]);
  });
});

describe('usableVolumeM3', () => {
  // Real prod master capacities (沖縄 47).
  const sokobaru = { totalCapacityM3: 13_000_000, activeCapacityM3: 12_850_000 };
  const maezato = { totalCapacityM3: 2_300_000, activeCapacityM3: 2_100_000 };

  test('stores 底原 総貯水量 less 堆砂容量, the volume its printed 貯水率 divides', () => {
    // 15:00 JST fixture row: 総貯水量 8,091 千m3, 貯水率 61.8 %.
    expect(usableVolumeM3({ grossVolumeM3: 8_091_000, storageRate: 0.618 }, sokobaru)).toBe(
      7_941_000,
    );
    // 14:00: 11,279 → 86.6 %.
    expect(usableVolumeM3({ grossVolumeM3: 11_279_000, storageRate: 0.866 }, sokobaru)).toBe(
      11_129_000,
    );
  });

  test('stores nothing for 真栄里, which prints no 貯水率 to tie its 総貯水量 to the master', () => {
    expect(usableVolumeM3({ grossVolumeM3: 1_500_000, storageRate: null }, maezato)).toBeNull();
  });

  test('stores nothing when the rate does not tie to the master capacities', () => {
    // A gross over 総貯水容量 basis would print 62.2 %, not 61.8 %.
    expect(usableVolumeM3({ grossVolumeM3: 8_091_000, storageRate: 0.622 }, sokobaru)).toBeNull();
  });

  test('stores nothing when the master lacks either capacity', () => {
    expect(
      usableVolumeM3(
        { grossVolumeM3: 8_091_000, storageRate: 0.618 },
        { totalCapacityM3: null, activeCapacityM3: 12_850_000 },
      ),
    ).toBeNull();
    expect(
      usableVolumeM3(
        { grossVolumeM3: 8_091_000, storageRate: 0.618 },
        { totalCapacityM3: 13_000_000, activeCapacityM3: null },
      ),
    ).toBeNull();
  });
});

describe('hasDataOf', () => {
  test('true when any hour carries a value', async () => {
    expect(hasDataOf(await series('00004002.html', '00004003.html', '00004004.html'))).toBe(true);
  });

  test('false when every page is a stored reading and every point is **', async () => {
    expect(hasDataOf(await series('00005002.html', '00005003.html', '00005004.html'))).toBe(false);
  });

  test('unknown when a page failed to load or parse', async () => {
    const s = await series('00005002.html', '00005003.html');
    expect(hasDataOf([...s, null])).toBeNull();
  });

  test('unknown when a page carries an unexpected unit', async () => {
    const s = await series('00005002.html', '00005003.html', '00005004.html');
    const odd = s.map((x, i) => (i === 1 && x ? { ...x, unit: 'm3' } : x));
    expect(hasDataOf(odd)).toBeNull();
  });

  test('unknown when there are no pages', () => {
    expect(hasDataOf([])).toBeNull();
  });

  test('unknown when a page has no hourly rows', async () => {
    const [level, , outflow] = await series('00005002.html', '00005003.html', '00005004.html');
    const empty = parseHourlyPage(
      (await page('00005003.html')).replace(/<DIV ALIGN="left">\d{2}:00[^<]*<\/DIV>/g, ''),
    );
    expect(empty?.points).toEqual([]);
    expect(hasDataOf([level ?? null, empty, outflow ?? null])).toBeNull();
  });

  test('unknown when a cell is neither a number nor the office’s ** 欠測 mark', async () => {
    const dashed = parseHourlyPage(
      (await page('00005003.html')).replace(/(15:00[\s\u3000]+)\*\*/, '$1---'),
    );
    const [level, , outflow] = await series('00005002.html', '00005003.html', '00005004.html');
    expect(hasDataOf([level ?? null, dashed, outflow ?? null])).toBeNull();
  });
});

describe('chooseMaster', () => {
  // Real prod rows (沖縄 47).
  const masters: NdiMaster[] = [
    { id: 11488n, name: '石垣', ndi: '2751', completedYear: 1981 },
    { id: 11489n, name: '底原', ndi: '2752', completedYear: 1992 },
    { id: 11490n, name: '真栄里', ndi: '2753', completedYear: 1982 },
    { id: 11491n, name: '名蔵', ndi: '2754', completedYear: 1998 },
  ];

  test('binds each dam to its pinned NDI row', () => {
    expect(chooseMaster({ key: '底原ダム', ndi: '2752' }, masters)).toBe(11489n);
    expect(chooseMaster({ key: '真栄里ダム', ndi: '2753' }, masters)).toBe(11490n);
    expect(chooseMaster({ key: '石垣ダム', ndi: '2751' }, masters)).toBe(11488n);
  });

  test('keeps an existing stamp over the pin', () => {
    const stamped = [...masters, { id: 99n, name: '石垣', ndi: null, stamp: '石垣ダム' }];
    expect(chooseMaster({ key: '石垣ダム', ndi: '2751' }, stamped)).toBe(99n);
  });

  test('falls back to the same name when the pinned row is gone', () => {
    const noPin = masters.map((m) => ({ ...m, ndi: null }));
    expect(chooseMaster({ key: '底原ダム', ndi: '2752' }, noPin)).toBe(11489n);
  });

  test('leaves a weir unbound', () => {
    expect(chooseMaster({ key: '二又堰', ndi: null }, masters)).toBeNull();
  });
});
