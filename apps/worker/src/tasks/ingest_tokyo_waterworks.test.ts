// apps/worker/src/tasks/ingest_tokyo_waterworks.test.ts
//
// Fixture → universe entries, no database: binding and writing belong to the
// ingest run (apps/worker/src/ingest/run.test.ts).
//
// The fixture is a verbatim capture of the live page taken on Monday
// 2026-09-28, when it still carried Friday's 「令和8年9月25日(金曜日)」
// readings: 利根川水系 / 荒川水系 「0時現在」, 多摩川水系 「7時現在」.

import { describe, expect, test } from 'bun:test';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { Entry, Observed } from '../ingest/types.ts';
import { tokyoEntries } from './ingest_tokyo_waterworks.ts';

const FIXTURE_PATH = join(
  import.meta.dir,
  '..',
  '..',
  '..',
  '..',
  'tests/fixtures/tokyo-waterworks/suigen_2026-09-28.html',
);

async function entries(edit: (html: string) => string = (h) => h): Promise<Entry[]> {
  return tokyoEntries(edit(await readFile(FIXTURE_PATH, 'utf8')));
}

function observed(list: Entry[], key: string): Observed {
  const r = list.find((e) => e.key === key)?.reading;
  if (!r || typeof r === 'function' || r.state !== 'values') throw new Error(`${key}: no values`);
  const [o] = r.observations;
  if (!o) throw new Error(`${key}: no observation`);
  return o;
}

describe('tokyoEntries', () => {
  test('stamps each row with the page date and its table’s 「N時現在」, not the fetch date', async () => {
    const list = await entries();
    // 利根川 0時 on 9/25 JST = 2026-09-24 15:00 UTC.
    expect(observed(list, '矢木沢ダム')).toEqual({
      observedAt: new Date('2026-09-24T15:00:00Z'),
      storageVolumeM3: 98_272_000,
      storageRate: 0.851,
    });
    expect(observed(list, '浦山ダム').observedAt).toEqual(new Date('2026-09-24T15:00:00Z'));
    // 多摩川 7時 on 9/25 JST = 2026-09-24 22:00 UTC.
    expect(observed(list, '小河内貯水池')).toEqual({
      observedAt: new Date('2026-09-24T22:00:00Z'),
      storageVolumeM3: 162_594_000,
      storageRate: 0.877,
    });
  });

  test('clips a 貯水率 over 100 % to 1', async () => {
    // 薗原 printed 129.7 %.
    expect(observed(await entries(), '薗原ダム').storageRate).toBe(1);
  });

  test('lists the 14 dams and the 村山・山口 total, never the 以上合計 rows', async () => {
    const list = await entries();
    expect(list).toHaveLength(15);
    expect(list.map((e) => e.key)).not.toContain('以上合計');
    for (const e of list) expect(typeof e.reading !== 'function' && e.reading.state).toBe('values');
  });

  test('the 村山・山口 three-reservoir total is recorded but binds no dam', async () => {
    const total = (await entries()).find((e) => e.key === '村山・山口貯水池');
    expect(total?.bind).toBe('never');
    expect(total?.pref).toBeNull();
  });

  test('an entry spanning several prefectures searches them all and records none', async () => {
    const list = await entries();
    const watarase = list.find((e) => e.key === '渡良瀬貯水池');
    expect(watarase?.pref).toEqual(['09', '10', '11']);
    expect(watarase?.bind).toEqual({ name: '渡良瀬' });
    expect(list.find((e) => e.key === '下久保ダム')?.pref).toEqual(['10', '11']);
    expect(list.find((e) => e.key === '矢木沢ダム')).toMatchObject({ pref: '10' });
    expect(list.find((e) => e.key === '矢木沢ダム')?.bind).toBeUndefined();
  });

  test('every catalogue row is unreadable when the page date is missing', async () => {
    const list = await entries((h) => h.replace(/令和8年9月25日/g, ''));
    expect(list).toHaveLength(15);
    for (const e of list) {
      expect(e.reading).toEqual({ state: 'unreadable', why: 'no dated row on the page' });
    }
  });
});
