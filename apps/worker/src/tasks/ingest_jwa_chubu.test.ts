// apps/worker/src/tasks/ingest_jwa_chubu.test.ts
//
// Fixture → universe entries, no database: binding and writing belong to the
// ingest run (apps/worker/src/ingest/run.test.ts).

import { describe, expect, test } from 'bun:test';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { bindEntry, type Master } from '../ingest/bind.ts';
import type { BoundDam, Entry, Observed, Reading } from '../ingest/types.ts';
import { chubuEntries, parseChubuDate, parseChubuHtml } from './ingest_jwa_chubu.ts';

// Verbatim capture of water.go.jp/mizu/chubu/report/ taken 2026-09-27
// (report of 2026年09月25日（金）; the page is not updated at weekends).
// Each dam block: <span class="dam-name">NAME</span>, 利水/有効容量,
// [EL …] (0時の貯水位), 流入量/放流量 (前日平均), then 貯水量<br>&lt;午前0時&gt;
// and (貯水率 …) in the next row.
const FIXTURE = join(
  import.meta.dir,
  '..',
  '..',
  '..',
  '..',
  'tests/fixtures/jwa_chubu/report_2026-09-27.html',
);
const fixture = (): Promise<string> => readFile(FIXTURE, 'utf8');

const SIX = ['牧尾ダム', '阿木川ダム', '味噌川ダム', '岩屋ダム', '中里ダム', '徳山ダム'];

async function readingOf(e: Entry | undefined, activeCapacityM3: number | null): Promise<Reading> {
  if (!e) throw new Error('no entry');
  if (typeof e.reading !== 'function') return e.reading;
  const dam: BoundDam = { id: 1n, name: 'x', totalCapacityM3: null, activeCapacityM3 };
  return e.reading(dam);
}

/** The single observation of an entry read against a master 有効 capacity. */
async function observed(name: string, activeM3: number | null, html?: string): Promise<Observed> {
  const entries = chubuEntries(html ?? (await fixture()));
  const r = await readingOf(
    entries.find((e) => e.key === name),
    activeM3,
  );
  if (r.state !== 'values' || !r.observations[0]) throw new Error(`${name}: ${r.state}`);
  return r.observations[0];
}

async function storage(name: string, activeM3: number | null) {
  const { storageVolumeM3, storageRate } = await observed(name, activeM3);
  return { storageVolumeM3, storageRate };
}

describe('parseChubuDate', () => {
  test('parses YYYY年MM月DD日 to JST midnight (= UTC day-1 15:00)', () => {
    const d = parseChubuDate('中部管内水源状況 2026年06月04日（木）');
    expect(d).not.toBeNull();
    expect(d?.toISOString()).toBe('2026-06-03T15:00:00.000Z');
  });

  test('parses single-digit month and day', () => {
    const d = parseChubuDate('2026年1月5日');
    expect(d?.toISOString()).toBe('2026-01-04T15:00:00.000Z');
  });

  test('returns null when no date present', () => {
    expect(parseChubuDate('no date here')).toBeNull();
  });
});

describe('parseChubuHtml', () => {
  test('reads every row from its own block at the report date', async () => {
    const { reportDate, rows } = parseChubuHtml(await fixture());
    expect(reportDate?.toISOString()).toBe('2026-09-24T15:00:00.000Z');
    expect(rows.map((r) => r.name)).toEqual([
      '牧尾ダム',
      '阿木川ダム',
      '味噌川ダム',
      '岩屋ダム',
      '豊川用水(宇連ダム・大島ダム・地区内調整池合計)',
      '宇連ダム',
      '大島ダム',
      '地区内調整池',
      '長良導水',
      '三重用水(中里ダム・調整池合計)',
      '中里ダム',
      '調整池(宮川・菰野・加佐登)',
      '徳山ダム',
    ]);
    expect(rows.find((r) => r.name === '牧尾ダム')).toEqual({
      name: '牧尾ダム',
      capacityBasis: '利水',
      capacityThouM3: 68_000,
      storageVolumeThouM3: 58_534,
      storageRatePct: 86.1,
      effectiveVolumeThouM3: null,
      waterLevelM: 876.8,
      inflowM3s: 8.66,
      outflowM3s: 8.38,
    });
    expect(rows.find((r) => r.name === '味噌川ダム')?.waterLevelM).toBe(1112.7);
  });

  test('takes 貯水量 at 午前0時, not the 有効貯水量 capacity printed above it', async () => {
    const tokuyama = parseChubuHtml(await fixture()).rows.find((r) => r.name === '徳山ダム');
    expect(tokuyama?.capacityBasis).toBe('有効');
    expect(tokuyama?.capacityThouM3).toBe(257_400);
    expect(tokuyama?.storageVolumeThouM3).toBe(163_530);
    expect(tokuyama?.storageRatePct).toBe(63.5);
    expect(tokuyama?.effectiveVolumeThouM3).toBeNull();
    expect(tokuyama?.outflowM3s).toBe(21.11);
  });

  test('中里ダム is read from its own block, not the 三重用水 合計 that names it first', async () => {
    // 「三重用水 (中里ダム・調整池合計)」 21,400 千m³ / 6,429 (30.0 %) comes
    // first on the page; 中里ダム's own block is 1,760 (11.0 %).
    const nakazato = parseChubuHtml(await fixture()).rows.find((r) => r.name === '中里ダム');
    expect(nakazato).toEqual({
      name: '中里ダム',
      capacityBasis: '利水',
      capacityThouM3: 16_000,
      storageVolumeThouM3: 1_760,
      storageRatePct: 11,
      effectiveVolumeThouM3: null,
      waterLevelM: null,
      inflowM3s: 0.21,
      outflowM3s: 0.24,
    });
  });

  test('reads the 有効貯水量 that 阿木川 and 味噌川 print below their 利水 storage', async () => {
    const rows = parseChubuHtml(await fixture()).rows;
    const agigawa = rows.find((r) => r.name === '阿木川ダム');
    expect(agigawa?.storageVolumeThouM3).toBe(22_000);
    expect(agigawa?.effectiveVolumeThouM3).toBe(27_130);
    expect(rows.find((r) => r.name === '味噌川ダム')?.effectiveVolumeThouM3).toBe(42_644);
    expect(rows.find((r) => r.name === '岩屋ダム')?.effectiveVolumeThouM3).toBeNull();
  });
});

describe('chubuEntries', () => {
  test('lists every row but the 合計 totals; the six dams in their prefectures, the rest never written', async () => {
    const entries = chubuEntries(await fixture());
    expect(entries.map((e) => [e.key, e.pref, e.bind, e.dontWrite])).toEqual([
      ['牧尾ダム', '20', undefined, undefined],
      ['阿木川ダム', '21', undefined, undefined],
      ['味噌川ダム', '20', undefined, undefined],
      ['岩屋ダム', '21', undefined, undefined],
      ['宇連ダム', '23', undefined, 'not one of jwa-chubu’s six dams (豊川用水)'],
      ['大島ダム', '23', undefined, 'not one of jwa-chubu’s six dams (豊川用水)'],
      ['地区内調整池', '23', 'never', undefined],
      ['長良導水', null, 'never', undefined],
      // 中里ダム is 三重用水's いなべ市 dam (NDI 940): searched in 三重 only,
      // never the 長野 '中里' that migration 0031 invented.
      ['中里ダム', '24', undefined, undefined],
      ['調整池(宮川・菰野・加佐登)', '24', 'never', undefined],
      ['徳山ダム', '21', undefined, undefined],
    ]);
  });

  test('the 合計 rows sum the rows listed under them, so they are no entries', async () => {
    const { rows } = parseChubuHtml(await fixture());
    const volume = (name: string) => rows.find((r) => r.name === name)?.storageVolumeThouM3 ?? 0;
    expect(volume('豊川用水(宇連ダム・大島ダム・地区内調整池合計)')).toBe(
      volume('宇連ダム') + volume('大島ダム') + volume('地区内調整池'),
    );
    expect(volume('三重用水(中里ダム・調整池合計)')).toBe(
      volume('中里ダム') + volume('調整池(宮川・菰野・加佐登)'),
    );
  });

  test('every row is observed at the report date with its 0時 level and 前日 flows', async () => {
    expect(await observed('牧尾ダム', 68_000_000)).toEqual({
      observedAt: new Date('2026-09-24T15:00:00.000Z'),
      storageVolumeM3: 58_534_000,
      storageRate: 0.861,
      inflowM3s: 8.66,
      outflowM3s: 8.38,
      waterLevelM: 876.8,
    });
  });

  test('中里ダム binds the 三重 row, not a 長野 namesake that holds the stamp', async () => {
    const master = (id: number, prefCode: string, stamp: string | null): Master => ({
      id: BigInt(id),
      name: '中里',
      completedYear: null,
      stamp,
      prefCode,
      ndi: null,
      totalCapacityM3: null,
      activeCapacityM3: null,
    });
    const nakazato = chubuEntries(await fixture()).find((e) => e.key === '中里ダム');
    if (!nakazato) throw new Error('no 中里ダム');
    const masters = [master(1, '24', null), master(2, '20', '中里ダム')];
    expect(bindEntry(nakazato, masters, false).dam?.id).toBe(1n);
  });

  test('a dam whose 貯水量 or 貯水率 is not a number is unreadable', async () => {
    const html = (await fixture()).replace(
      '<div class="databox">58,534</div>',
      '<div class="databox">―</div>',
    );
    const entries = chubuEntries(html);
    expect((await readingOf(entries[0], 68_000_000)).state).toBe('unreadable');
    expect((await readingOf(entries[1], 44_000_000)).state).toBe('values');
  });

  test('a page without its report date records the six dams unreadable', async () => {
    const html = (await fixture()).replace(/\d{4}年\d{1,2}月\d{1,2}日/g, '');
    const entries = chubuEntries(html);
    expect(entries.map((e) => e.key)).toEqual(SIX);
    for (const e of entries)
      expect(typeof e.reading !== 'function' && e.reading.state).toBe('unreadable');
  });

  test('one of the six missing from the report is recorded unreadable', async () => {
    const html = (await fixture()).replace('>牧尾ダム</span>', '>牧尾</span>');
    const makio = chubuEntries(html).find((e) => e.key === '牧尾ダム');
    expect(makio?.reading).toEqual({ state: 'unreadable', why: 'not on the report' });
  });
});

describe('the stored storage, against the master 有効 capacity', () => {
  // The page's 貯水量 is the 利水 portion (footer: 「貯水量：…利水容量」).
  // jwa-chubu is untrusted, so every stored volume is divided by the master's
  // 有効 capacity; only 有効 storage may go into storage_volume_m3. Master
  // active capacities below are production's (2026-09-27).

  test('keeps volume and rate where the 利水容量 is the whole 有効 pool', async () => {
    expect(await storage('牧尾ダム', 68_000_000)).toEqual({
      storageVolumeM3: 58_534_000,
      storageRate: 0.861,
    });
    expect(await storage('中里ダム', 16_000_000)).toEqual({
      storageVolumeM3: 1_760_000,
      storageRate: 0.11,
    });
  });

  test('stores the printed 有効貯水量, not the 利水 portion, for 阿木川 and 味噌川', async () => {
    // 利水 22,000 / 100 % against a 44,000 千m³ master would read as 50 %.
    expect(await storage('阿木川ダム', 44_000_000)).toEqual({
      storageVolumeM3: 27_130_000,
      storageRate: null,
    });
    expect(await storage('味噌川ダム', 55_000_000)).toEqual({
      storageVolumeM3: 42_644_000,
      storageRate: null,
    });
  });

  test('stores nothing for 岩屋, whose 利水 61,900 is part of a 150,000 千m³ pool', async () => {
    expect(await storage('岩屋ダム', 150_000_000)).toEqual({
      storageVolumeM3: null,
      storageRate: null,
    });
  });

  test('keeps 徳山 storage but not its seasonal-basis rate', async () => {
    // Labelled 有効貯水量 and divided by the season's 257,400, not the
    // master's 380,400 千m³; the volume itself is 有効 storage.
    expect(await storage('徳山ダム', 380_400_000)).toEqual({
      storageVolumeM3: 163_530_000,
      storageRate: null,
    });
  });

  test('stores nothing when the master has no capacity to compare against', async () => {
    expect(await storage('牧尾ダム', null)).toEqual({ storageVolumeM3: null, storageRate: null });
  });
});
