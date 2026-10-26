// apps/worker/src/tasks/ingest_chiba.test.ts
//
// Fixture is a verbatim capture (2026-09-27) of 千葉県 県内ダムの貯水状況
// (pref.chiba.lg.jp/suisei/chosui/chosuijoukyou.html), 更新日 2026-09-15.
// Its heading reads 「県内ダム貯水状況（令和8年9月14日現在）」 while the chart
// image under it still carries last week's alt text 「令和8年9月7日9時現在…」
// (the image file itself is r080914.jpg).
//
// Fixture → universe entries, no database: binding and writing belong to the
// ingest run (apps/worker/src/ingest/run.test.ts).

import { describe, expect, test } from 'bun:test';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { Entry, Observed } from '../ingest/types.ts';
import { chibaEntries, parseChibaTimestamp } from './ingest_chiba.ts';

const FIXTURE = join(
  import.meta.dir,
  '..',
  '..',
  '..',
  '..',
  'tests/fixtures/chiba_suisei/chosuijoukyou_2026-09-27.html',
);

const html = (): Promise<string> => readFile(FIXTURE, 'utf8');

describe('parseChibaTimestamp', () => {
  test('dates the table by its heading, not the stale chart alt text', async () => {
    // 2026-09-14 09:00 JST, the survey hour every earlier snapshot carried.
    expect(parseChibaTimestamp(await html())?.toISOString()).toBe('2026-09-14T00:00:00.000Z');
  });

  test('returns null when the table heading is missing', async () => {
    const withoutHeading = (await html()).replace('県内ダム貯水状況（令和8年9月14日現在）', '');
    expect(parseChibaTimestamp(withoutHeading)).toBeNull();
  });
});

function observed(entries: Entry[], key: string): Observed {
  const r = entries.find((e) => e.key === key)?.reading;
  if (!r || typeof r === 'function' || r.state !== 'values') throw new Error(`${key}: no values`);
  const [o] = r.observations;
  if (!o) throw new Error(`${key}: no observation`);
  return o;
}

describe('chibaEntries', () => {
  test('lists the 20 水道用 and 3 工業用水 dams, skipping subtotal rows', async () => {
    const entries = chibaEntries(await html());
    expect(entries).toHaveLength(23);
    expect(entries.some((e) => /小計|合計/.test(e.name))).toBe(false);
  });

  test('reads m³ volumes and % rates as published, at the heading date', async () => {
    const entries = chibaEntries(await html());
    const higashi2 = observed(entries, '東第二');
    expect(higashi2.storageVolumeM3).toBe(181_447);
    expect(higashi2.storageRate).toBeCloseTo(0.98, 6);
    expect(higashi2.observedAt.toISOString()).toBe('2026-09-14T00:00:00.000Z');
    const yamakura = observed(entries, '山倉');
    expect(yamakura.storageVolumeM3).toBe(4_118_700);
    expect(yamakura.storageRate).toBeCloseTo(0.92, 6);
  });

  test('matches the master exactly, reading 一/二/三 as digits', async () => {
    const entries = chibaEntries(await html());
    expect(entries.find((e) => e.key === '東第二')?.bind).toEqual({ name: '東第2', exact: true });
    expect(entries.find((e) => e.key === '山倉')?.bind).toEqual({ name: '山倉', exact: true });
  });

  test('every row is unreadable when the heading date is missing', async () => {
    const withoutHeading = (await html()).replace('県内ダム貯水状況（令和8年9月14日現在）', '');
    for (const e of chibaEntries(withoutHeading)) {
      expect(e.reading).toEqual({ state: 'unreadable', why: 'no 県内ダム貯水状況 heading date' });
    }
  });
});
