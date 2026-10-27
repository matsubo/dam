// apps/worker/src/tasks/ingest_jwa_biwako.test.ts
//
// Fixture → universe entries, no database: binding and writing belong to the
// ingest run (apps/worker/src/ingest/run.test.ts).
//
// Fixture is a verbatim capture (UTF-8 with BOM) of
// http://www.biwako-mizukanri.jp/daminfo1_h.json, the data behind the 水資源機構
// 琵琶湖総合管理所 堰諸量 1時間表示 page, taken 2026-09-27 21:38 JST. 25 hourly
// rows, oldest first: 2026-09-26 21:00 … 2026-09-27 21:00. Per daminfo1_h.html
// ana0 = 琵琶湖 河川水位 [m, B.S.L.], ana1 = 総流入量, ana2 = 総流出量,
// ana3 = 洗堰全放流量 [m³/s].

import { describe, expect, test } from 'bun:test';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { Observed } from '../ingest/types.ts';
import { biwakoEntries, biwakoReading } from './ingest_jwa_biwako.ts';

const FIXTURE = join(
  import.meta.dir,
  '..',
  '..',
  '..',
  '..',
  'tests/fixtures/jwa_biwako/daminfo1_h_2026-09-27.json',
);

async function fixtureText(): Promise<string> {
  return new TextDecoder('utf-8').decode(await readFile(FIXTURE));
}

function observations(text: string): readonly Observed[] {
  const r = biwakoReading({ text });
  if (r.state !== 'values') throw new Error(`no values: ${JSON.stringify(r)}`);
  return r.observations;
}

describe('biwakoEntries', () => {
  test('lists the lake under its 局名, bound by the master name 琵琶湖開発', async () => {
    const list = biwakoEntries({ text: await fixtureText() });
    expect(list).toHaveLength(1);
    expect(list[0]).toMatchObject({
      key: '琵琶湖',
      name: '琵琶湖',
      pref: '25',
      bind: { name: '琵琶湖開発' },
      reading: { state: 'values' },
    });
  });

  test('a failed fetch still lists the lake, unreadable', () => {
    expect(biwakoEntries({ failed: 'HTTP 502' })[0]?.reading).toEqual({
      state: 'unreadable',
      why: 'HTTP 502',
    });
  });
});

describe('biwakoReading', () => {
  test('reads all 25 hourly rows with JST timestamps', async () => {
    const rows = observations(await fixtureText());
    expect(rows).toHaveLength(25);
    expect(rows[0]?.observedAt.toISOString()).toBe('2026-09-26T12:00:00.000Z');
    expect(rows[24]?.observedAt.toISOString()).toBe('2026-09-27T12:00:00.000Z');
  });

  test('converts the B.S.L. lake level to T.P. elevation', async () => {
    // B.S.L. ±0 = T.P. +84.371 m; the fixture reads B.S.L. -0.33 m.
    const latest = observations(await fixtureText()).at(-1);
    expect(latest?.waterLevelM).toBeCloseTo(84.041, 6);
  });

  test('takes the lake total inflow and total outflow, not the 洗堰 release', async () => {
    const rows = observations(await fixtureText());
    const latest = rows.at(-1);
    expect(latest?.inflowM3s).toBe(107.9);
    expect(latest?.outflowM3s).toBe(84.61);
    const midnight = rows.find((r) => r.observedAt.toISOString() === '2026-09-26T15:00:00.000Z');
    expect(midnight?.inflowM3s).toBe(92.78);
    expect(midnight?.outflowM3s).toBe(86.19);
  });

  test('maps blank or non-numeric cells to null and drops rows without a time', async () => {
    const text = (await fixtureText())
      .replace(
        '"ana0":"-0.33","ana0dir":"","ana1":"107.90"',
        '"ana0":"欠測","ana0dir":"","ana1":""',
      )
      .replace('"datestr":"2026-09-26 21:00"', '"datestr":""');
    const rows = observations(text);
    expect(rows).toHaveLength(24);
    const latest = rows.at(-1);
    expect(latest?.observedAt.toISOString()).toBe('2026-09-27T12:00:00.000Z');
    expect(latest?.waterLevelM).toBeNull();
    expect(latest?.inflowM3s).toBeNull();
    expect(latest?.outflowM3s).toBe(84.61);
  });

  test('an hour with no value at all is not an observation; none at all is unreadable', async () => {
    const text = await fixtureText();
    const blank = text.replace(/"ana[0-2]":"[^"]*"/g, (m) => m.replace(/:"[^"]*"/, ':""'));
    expect(biwakoReading({ text: blank })).toEqual({
      state: 'unreadable',
      why: 'no value in 25 hourly rows',
    });
  });

  test('a body that is not JSON is unreadable', () => {
    expect(biwakoReading({ text: '<html>503</html>' })).toMatchObject({ state: 'unreadable' });
  });
});
