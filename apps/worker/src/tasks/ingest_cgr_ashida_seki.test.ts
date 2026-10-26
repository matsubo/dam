// apps/worker/src/tasks/ingest_cgr_ashida_seki.test.ts
//
// Fixture → universe entries, no database: binding and writing belong to the
// ingest run (apps/worker/src/ingest/run.test.ts).
//
// Fixture is a verbatim capture (UTF-8 with BOM) of 福山河川国道事務所
// mobile_ashidagawa/sekisyoryou.php taken 2026-09-27 21:40 JST, 観測日時
// 21:30: 流入量 5.89 / 放流量 5.97 m³/s, 貯水量 4988 千m³, 堰上水位 2.01 m,
// 堰下水位 1.30 m, 堰取水量 1.04 m³/s.

import { describe, expect, test } from 'bun:test';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { Reading } from '../ingest/types.ts';
import { ashidaSekiEntries, ashidaSekiReading } from './ingest_cgr_ashida_seki.ts';

const FIXTURE = join(
  import.meta.dir,
  '..',
  '..',
  '..',
  '..',
  'tests/fixtures/cgr_ashida_seki/sekisyoryou_2026-09-27T2130.html',
);
const page = () => readFile(FIXTURE, 'utf8');

function observed(r: Reading) {
  if (r.state !== 'values') throw new Error(`expected values, got ${r.state}`);
  const [o] = r.observations;
  if (!o) throw new Error('no observation');
  return o;
}

describe('ashidaSekiEntries', () => {
  test('lists the one weir under its printed name, read from the page', async () => {
    const [entry, ...rest] = ashidaSekiEntries(page);
    expect(rest).toEqual([]);
    expect(entry?.key).toBe('芦田川河口堰');
    expect(entry?.name).toBe('芦田川河口堰');
    expect(entry?.pref).toBe('34');
    if (typeof entry?.reading !== 'function') throw new Error('expected a reading function');
    expect((await entry.reading(null)).state).toBe('values');
  });

  test('a page that fails to load makes the reading throw (the run records it unreadable)', async () => {
    const [entry] = ashidaSekiEntries(() => Promise.reject(new Error('HTTP 503')));
    if (typeof entry?.reading !== 'function') throw new Error('expected a reading function');
    await expect(Promise.resolve(entry.reading(null))).rejects.toThrow('HTTP 503');
  });
});

describe('ashidaSekiReading', () => {
  test('reads the weir pool level, 千m³ volume and flows at the JST 観測日時', async () => {
    const o = observed(ashidaSekiReading(await page()));
    expect(o.observedAt.toISOString()).toBe('2026-09-27T12:30:00.000Z');
    // 堰上水位 (pool side), not 堰下水位 1.30 m.
    expect(o.waterLevelM).toBe(2.01);
    expect(o.inflowM3s).toBe(5.89);
    // 放流量, not 堰取水量 1.04 m³/s.
    expect(o.outflowM3s).toBe(5.97);
    expect(o.storageVolumeM3).toBe(4_988_000);
  });

  test('a 欠測 cell reads as missing without touching the others', async () => {
    // Simulated outage marker on 貯水量; the live page shows none today.
    const html = (await page()).replace(
      '<td class="data"　align="right">4988</td>',
      '<td class="data"　align="right">欠測</td>',
    );
    const o = observed(ashidaSekiReading(html));
    expect(o.storageVolumeM3).toBeNull();
    expect(o.waterLevelM).toBe(2.01);
  });

  test('欠測 on every stored cell is provider-marked empty', async () => {
    let html = await page();
    for (const v of ['5.89', '5.97', '4988', '2.01']) {
      html = html.replace(
        `<td class="data"　align="right">${v}</td>`,
        '<td class="data"　align="right">欠測</td>',
      );
    }
    expect(ashidaSekiReading(html).state).toBe('empty');
  });

  test('a page without 観測日時 is unreadable', () => {
    expect(ashidaSekiReading('<html><body>メンテナンス中</body></html>')).toEqual({
      state: 'unreadable',
      why: 'no 観測日時 on the page',
    });
  });
});
