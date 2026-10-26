// apps/worker/src/tasks/ingest_jwa_chikugo.test.ts
//
// Fixture → universe entries, no database: binding and writing belong to the
// ingest run (apps/worker/src/ingest/run.test.ts).
//
// Fixture is a verbatim capture of 水資源機構 筑後川局
// water.go.jp/chikugo/chikugo/water-source.html fetched 2026-09-28 12:55 JST
// (a Monday). Its heading still reads 水源情報【令和8年9月25日】 — the page is
// not updated on 閉庁日 and the Monday edition was not out yet.

import { describe, expect, test } from 'bun:test';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { Entry, Observed } from '../ingest/types.ts';
import { jwaChikugoEntries, parseJwaChikugoHtml } from './ingest_jwa_chikugo.ts';

async function fixtureHtml(): Promise<string> {
  const path = join(
    import.meta.dir,
    '..',
    '..',
    '..',
    '..',
    'tests/fixtures/jwa_chikugo/water-source_2026-09-28.html',
  );
  return readFile(path, 'utf8');
}

function observed(list: Entry[], key: string): Observed {
  const r = list.find((e) => e.key === key)?.reading;
  if (!r || typeof r === 'function' || r.state !== 'values') throw new Error(`${key}: no values`);
  expect(r.observations).toHaveLength(1);
  const o = r.observations[0];
  if (!o) throw new Error(`${key}: no observation`);
  return o;
}

describe('jwaChikugoEntries', () => {
  test('lists the seven dams; 下筌 searches both 熊本 and 大分', async () => {
    const list = jwaChikugoEntries({ html: await fixtureHtml() });
    expect(list.map((e) => [e.key, e.name, e.pref])).toEqual([
      ['松原ダム', '松原ダム', '44'],
      ['下筌ダム', '下筌ダム', ['43', '44']],
      ['大山ダム', '大山ダム', '44'],
      ['合所ダム', '合所ダム', '40'],
      ['江川ダム', '江川ダム', '40'],
      ['寺内ダム', '寺内ダム', '40'],
      ['小石原川ダム', '小石原川ダム', '40'],
    ]);
    for (const e of list) expect(e.reading).toMatchObject({ state: 'values' });
  });

  test('dates the readings by the page heading, not by the day it is fetched', async () => {
    const list = jwaChikugoEntries({ html: await fixtureHtml() });
    // 2026-09-25 00:00 JST
    expect(observed(list, '江川ダム').observedAt).toEqual(new Date('2026-09-24T15:00:00Z'));
  });

  test('reads 千m³ volume as m³ and % rate as a fraction (pattern A and B blocks)', async () => {
    const list = jwaChikugoEntries({ html: await fixtureHtml() });
    const egawa = observed(list, '江川ダム');
    expect(egawa.storageVolumeM3).toBe(2_903_000);
    expect(egawa.storageRate).toBeCloseTo(0.121, 6);
    const oyama = observed(list, '大山ダム');
    expect(oyama.storageVolumeM3).toBe(7_667_000);
    expect(oyama.storageRate).toBeCloseTo(0.697, 6);
  });

  test('a page without the dated 水源情報 heading leaves every dam unreadable', async () => {
    const html = (await fixtureHtml()).replace('水源情報【令和8年9月25日】', '水源情報');
    expect(parseJwaChikugoHtml(html)).toBeNull();
    const list = jwaChikugoEntries({ html });
    expect(list).toHaveLength(7);
    for (const e of list) {
      expect(e.reading).toEqual({
        state: 'unreadable',
        why: 'no dated 水源情報 heading on the page',
      });
    }
  });

  test('a failed fetch still lists every dam, unreadable', () => {
    const list = jwaChikugoEntries({ failed: 'HTTP 404' });
    expect(list).toHaveLength(7);
    for (const e of list) expect(e.reading).toEqual({ state: 'unreadable', why: 'HTTP 404' });
  });
});
