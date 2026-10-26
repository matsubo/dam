// Fixture → universe entries, no database: binding and writing belong to the
// ingest run (apps/worker/src/ingest/run.test.ts).

import { describe, expect, it } from 'bun:test';
import * as fs from 'node:fs';
import * as path from 'node:path';
import type { Reading } from '../ingest/types.ts';
import { fukuokaEntries, parseFukuokaTimestamp } from './ingest_fukuoka_bodik';

const FIXTURE_PATH = path.join(
  import.meta.dir,
  '../../../../tests/fixtures/fukuoka_bodik/202606data_2026-06-05.csv',
);

function loadFixture(): string {
  const buf = fs.readFileSync(FIXTURE_PATH);
  return new TextDecoder('shift-jis').decode(buf);
}

function observation(r: unknown) {
  const reading = r as Reading | undefined;
  if (reading?.state !== 'values') throw new Error('no values');
  const o = reading.observations[0];
  if (!o) throw new Error('no observation');
  return o;
}

describe('parseFukuokaTimestamp', () => {
  it('converts JST YYYY/MM/DD HH:MM to UTC', () => {
    const d = parseFukuokaTimestamp('2026/06/05 08:00');
    expect(d?.toISOString()).toBe('2026-06-04T23:00:00.000Z');
  });

  it('handles midnight rollover', () => {
    const d = parseFukuokaTimestamp('2026/01/01 00:00');
    expect(d?.toISOString()).toBe('2025-12-31T15:00:00.000Z');
  });

  it('returns null for garbage', () => {
    expect(parseFukuokaTimestamp('bad')).toBeNull();
  });
});

describe('fukuokaEntries', () => {
  it('one entry per dam column from the fixture (skips 合計)', () => {
    const list = fukuokaEntries(loadFixture());
    expect(list.map((e) => e.key)).toEqual([
      '南畑ダム',
      '五ケ山ダム',
      '脊振ダム',
      '曲渕ダム',
      '江川ダム',
      '久原ダム',
      '長谷ダム',
      '猪野ダム',
      '瑞梅寺ダム',
    ]);
    expect(list.every((e) => e.pref === '40')).toBe(true);
  });

  it('converts storage 千m³ → m³', () => {
    const minami = fukuokaEntries(loadFixture()).find((e) => e.key === '南畑ダム');
    // fixture: 南畑ダム = 2571 千m³ → 2,571,000 m³
    expect(observation(minami?.reading).storageVolumeM3).toBe(2571 * 1000);
  });

  it('takes the most recent row (top of file)', () => {
    const first = fukuokaEntries(loadFixture())[0];
    expect(observation(first?.reading).observedAt.toISOString()).toBe('2026-06-04T23:00:00.000Z');
  });

  it('binds 五ケ山 by the master spelling 五ヶ山 (small ヶ), keyed as printed', () => {
    const gokayama = fukuokaEntries(loadFixture()).find((e) => e.key === '五ケ山ダム');
    expect(gokayama?.bind).toEqual({ name: '五ヶ山ダム' });
    expect(fukuokaEntries(loadFixture()).find((e) => e.key === '南畑ダム')?.bind).toBeUndefined();
  });

  it('a header without a data row lists every dam as unreadable', () => {
    const list = fukuokaEntries('観測時刻,南畑ダム,合計');
    expect(list.map((e) => [e.key, (e.reading as Reading).state])).toEqual([
      ['南畑ダム', 'unreadable'],
    ]);
  });

  it('a blank cell is unreadable, not zero', () => {
    const [e] = fukuokaEntries('観測時刻,南畑ダム,合計\n2026/06/05 08:00,,0');
    expect((e?.reading as Reading | undefined)?.state).toBe('unreadable');
  });

  it('returns empty array for empty CSV', () => {
    expect(fukuokaEntries('')).toEqual([]);
  });
});
