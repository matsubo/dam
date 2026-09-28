// apps/worker/src/tasks/ingest_jwa_chikugo.test.ts
//
// Fixture is a verbatim capture of 水資源機構 筑後川局
// water.go.jp/chikugo/chikugo/water-source.html fetched 2026-09-28 12:55 JST
// (a Monday). Its heading still reads 水源情報【令和8年9月25日】 — the page is
// not updated on 閉庁日 and the Monday edition was not out yet.

import { describe, expect, test } from 'bun:test';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { parseJwaChikugoHtml } from './ingest_jwa_chikugo.ts';

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

describe('parseJwaChikugoHtml', () => {
  test('dates the readings by the page heading, not by the day it is fetched', async () => {
    const page = parseJwaChikugoHtml(await fixtureHtml());
    expect(page?.observedAt).toEqual(new Date('2026-09-24T15:00:00Z')); // 2026-09-25 00:00 JST
    expect(page?.rows).toHaveLength(7);
    expect(page?.rows).toContainEqual({
      chikugoName: '江川ダム',
      storageRatePct: 12.1,
      storageVolumeThouM3: 2903,
    });
    expect(page?.rows).toContainEqual({
      chikugoName: '大山ダム',
      storageRatePct: 69.7,
      storageVolumeThouM3: 7667,
    });
  });

  test('returns null for a page without the dated 水源情報 heading', async () => {
    const html = (await fixtureHtml()).replace('水源情報【令和8年9月25日】', '水源情報');
    expect(parseJwaChikugoHtml(html)).toBeNull();
  });
});
