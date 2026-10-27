// apps/worker/src/tasks/ingest_hkd_mlit.test.ts
//
// Fixture → universe entries, no database: binding and writing belong to the
// ingest run (apps/worker/src/ingest/run.test.ts).
//
// Fixture is a verbatim capture of info-dam.hdb.hkd.mlit.go.jp/dam/dam_chubetsu.htm
// taken 2026-10-27 00:4x JST: latest row 26/10/27 00:40, 貯水位 405.20 m,
// 全流入量 15.92 / 全放流量 11.52 m³/s; summary 貯水量 35344 千m³, 貯水率 43.8 %,
// 流域平均時間雨量 0.0 mm/h. 利水放流量 prints "***".

import { describe, expect, test } from 'bun:test';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { Reading } from '../ingest/types.ts';
import { fixtureUpstream } from '../ingest/upstream.ts';
import { hkdEntries, hkdReading, parseHkdTimestamp } from './ingest_hkd_mlit.ts';

const FIXTURE = join(
  import.meta.dir,
  '../../../../tests/fixtures/hkd_mlit/dam_chubetsu_2026-10-27T0040.htm',
);
const page = () => readFile(FIXTURE, 'utf8');

function observed(r: Reading) {
  if (r.state !== 'values') throw new Error(`expected values, got ${r.state}`);
  const [o] = r.observations;
  if (!o) throw new Error('no observation');
  return o;
}

describe('parseHkdTimestamp', () => {
  test('parses the 2-digit-year JST stamp → UTC', () => {
    expect(parseHkdTimestamp('26/05/18　10:10')?.toISOString()).toBe('2026-05-18T01:10:00.000Z');
  });

  test('returns null on malformed input', () => {
    expect(parseHkdTimestamp('***')).toBeNull();
  });
});

describe('hkdReading', () => {
  test('reads the latest table row plus the summary storage, rate and rain', async () => {
    expect(observed(hkdReading(await page()))).toEqual({
      observedAt: new Date('2026-10-26T15:40:00.000Z'),
      waterLevelM: 405.2,
      inflowM3s: 15.92,
      outflowM3s: 11.52,
      storageVolumeM3: 35_344_000,
      storageRate: expect.closeTo(0.438, 6),
      rainfallMm: 0,
    });
  });

  test('"*" in every field is provider-marked empty', async () => {
    const html = (await page())
      .replace(/(<td[^>]*>)\s*\d+\.\d+\s*(<\/td>)/g, '$1***$2')
      .replace(/貯水量　35344/, '貯水量　***')
      .replace(/貯水率　43\.8/, '貯水率　***')
      .replace(/雨量　0\.0mm\/h/, '雨量　***mm/h');
    expect(hkdReading(html).state).toBe('empty');
  });

  test('a page without a timestamped row is unreadable', () => {
    expect(hkdReading('<html>メンテナンス中</html>').state).toBe('unreadable');
  });
});

describe('hkdEntries', () => {
  test('lists all 18 dams by page slug, each read from its own page', async () => {
    const urls: string[] = [];
    const entries = hkdEntries(
      fixtureUpstream(async (url) => {
        urls.push(url);
        return page();
      }),
    );
    expect(entries).toHaveLength(18);
    expect(entries.every((e) => e.pref === '01')).toBe(true);
    const chubetsu = entries.find((e) => e.key === 'chubetsu');
    expect(chubetsu?.name).toBe('忠別ダム');
    if (typeof chubetsu?.reading !== 'function') throw new Error('expected a reading function');
    expect((await chubetsu.reading(null)).state).toBe('values');
    expect(urls).toEqual(['https://info-dam.hdb.hkd.mlit.go.jp/dam/dam_chubetsu.htm']);
  });

  test('a page that fails to load makes that reading throw (the run records it unreadable)', async () => {
    const [first] = hkdEntries(fixtureUpstream(() => ({ status: 503 })));
    if (typeof first?.reading !== 'function') throw new Error('expected a reading function');
    await expect(Promise.resolve(first.reading(null))).rejects.toThrow('HTTP 503');
  });
});
