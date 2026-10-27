// apps/worker/src/tasks/ingest_ktr_tone_dam.test.ts
//
// Fixture → universe entries, no database: binding and writing belong to the
// ingest run (apps/worker/src/ingest/run.test.ts).
//
// SAMPLE_JSON is a trimmed feed; the fixture is a verbatim capture of
// realtime2/json/E007010.json taken 2026-10-27 (00:00 JST).

import { describe, expect, test } from 'bun:test';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { Entry, Reading } from '../ingest/types.ts';
import { parseToneTimestamp, toneEntries, toneReading } from './ingest_ktr_tone_dam.ts';

const FIXTURE = join(
  import.meta.dir,
  '../../../../tests/fixtures/ktr_tone_dam/E007010_2026-10-27T0000.json',
);

describe('parseToneTimestamp', () => {
  test('parses "YYYY/MM/DD HH:MM:SS" (JST) → UTC', () => {
    const d = parseToneTimestamp('2026/06/05 18:00:00');
    expect(d?.toISOString()).toBe('2026-06-05T09:00:00.000Z');
  });

  test('handles midnight crossover (JST 01:00 → previous UTC day)', () => {
    const d = parseToneTimestamp('2026/06/05 01:00:00');
    expect(d?.toISOString()).toBe('2026-06-04T16:00:00.000Z');
  });

  test('returns null for malformed input', () => {
    expect(parseToneTimestamp('')).toBeNull();
    expect(parseToneTimestamp('2026-06-05 18:00:00')).toBeNull();
    expect(parseToneTimestamp('bad')).toBeNull();
  });
});

const SAMPLE_JSON = {
  damDataList: [
    {
      officeCD: '21289',
      observationCD: '1',
      observationName: '矢木沢ダム',
      dataList: [
        {
          observationTime: '2026/06/05 18:00:00',
          waterCapacity: '43,918',
          waterRate: '38.0',
          inflow: '17.43',
          totalDischarge: '0.00',
        },
      ],
    },
    {
      officeCD: '21289',
      observationCD: '3',
      observationName: '藤原ダム',
      dataList: [
        {
          observationTime: '2026/06/05 18:00:00',
          waterCapacity: '28,319',
          waterRate: '91.3',
          inflow: '8.58',
          totalDischarge: '48.81',
        },
      ],
    },
    {
      officeCD: '21259',
      observationCD: '1',
      observationName: '渡良瀬貯水池',
      dataList: [
        {
          observationTime: '2026/06/05 18:00:00',
          waterCapacity: '13,159',
          waterRate: '49.8',
          inflow: '休止中',
          totalDischarge: '休止中',
        },
      ],
    },
    // Aggregate entry — a sum of dams listed alongside, not a universe entry
    {
      officeCD: '21289',
      observationCD: '8',
      observationName: '５ダム',
      dataList: [
        {
          observationTime: '2026/06/05 18:00:00',
          waterCapacity: '154,878',
          waterRate: '58.5',
          inflow: '33.20',
          totalDischarge: '74.81',
        },
      ],
    },
  ],
};

function readingOf(e: Entry | undefined): Reading {
  if (!e || typeof e.reading === 'function') throw new Error('expected a static reading');
  return e.reading;
}
function observed(e: Entry | undefined) {
  const r = readingOf(e);
  if (r.state !== 'values') throw new Error(`expected values, got ${r.state}`);
  const [o] = r.observations;
  if (!o) throw new Error('no observation');
  return o;
}
const byName = (name: string) => toneEntries(SAMPLE_JSON).find((e) => e.name === name);

describe('toneEntries', () => {
  test('lists every damDataList row, then the configured dams the feed left out', () => {
    const entries = toneEntries(SAMPLE_JSON);
    expect(entries.map((e) => e.key)).toEqual([
      '21289/1',
      '21289/3',
      '21259/1',
      '21289/2',
      '21289/4',
      '21289/5',
      '21289/27',
      '21289/6',
      '21289/7',
    ]);
    expect(readingOf(entries.find((e) => e.key === '21289/2'))).toEqual({
      state: 'unreadable',
      why: 'not in damDataList',
    });
  });

  test('the ５ダム aggregate sums listed dams and is not an entry', () => {
    expect(toneEntries(SAMPLE_JSON).find((e) => e.key === '21289/8')).toBeUndefined();
  });

  test('scopes each dam to its prefectures (下久保 群馬/埼玉, 渡良瀬 four)', () => {
    expect(byName('矢木沢ダム')?.pref).toBe('10');
    expect(toneEntries(SAMPLE_JSON).find((e) => e.key === '21289/6')?.pref).toEqual(['10', '11']);
    expect(byName('渡良瀬貯水池')?.pref).toEqual(['09', '10', '11', '08']);
  });

  test("渡良瀬貯水池 binds by its master's name, 渡良瀬遊水地", () => {
    expect(byName('渡良瀬貯水池')?.bind).toEqual({ name: '渡良瀬遊水地' });
    expect(byName('矢木沢ダム')?.bind).toBeUndefined();
  });

  test('矢木沢ダム: storage converted from 千m³ to m³, rate as ratio, JST 18:00 → UTC', () => {
    const o = observed(byName('矢木沢ダム'));
    expect(o.observedAt.toISOString()).toBe('2026-06-05T09:00:00.000Z');
    expect(o.storageVolumeM3).toBe(43_918_000);
    expect(o.storageRate).toBeCloseTo(0.38);
    expect(o.inflowM3s).toBeCloseTo(17.43);
    expect(o.outflowM3s).toBeCloseTo(0.0);
  });

  test('藤原ダム: all fields parsed correctly', () => {
    const o = observed(byName('藤原ダム'));
    expect(o.storageVolumeM3).toBe(28_319_000);
    expect(o.storageRate).toBeCloseTo(0.913);
    expect(o.inflowM3s).toBeCloseTo(8.58);
    expect(o.outflowM3s).toBeCloseTo(48.81);
  });

  test('渡良瀬貯水池: "休止中" inflow and outflow → null; storage parsed', () => {
    const o = observed(byName('渡良瀬貯水池'));
    expect(o.storageVolumeM3).toBe(13_159_000);
    expect(o.storageRate).toBeCloseTo(0.498);
    expect(o.inflowM3s).toBeNull();
    expect(o.outflowM3s).toBeNull();
  });

  test('"休止中" in every field is provider-marked empty', () => {
    const r = toneReading({
      dataList: [
        {
          observationTime: '2026/06/05 18:00:00',
          waterCapacity: '休止中',
          waterRate: '休止中',
          inflow: '休止中',
          totalDischarge: '休止中',
        },
      ],
    });
    expect(r.state).toBe('empty');
  });

  test('an entry without a parseable observationTime is unreadable', () => {
    expect(toneReading({ dataList: [] }).state).toBe('unreadable');
    expect(toneReading({ dataList: [{ observationTime: 'bad' }] }).state).toBe('unreadable');
  });

  test('the live feed lists nine dams; both aggregates are skipped (fixture 2026-10-27 00:00)', async () => {
    const json = JSON.parse((await readFile(FIXTURE, 'utf8')).replace(/^\uFEFF/, ''));
    const entries = toneEntries(json);
    expect(entries).toHaveLength(9);
    expect(entries.map((e) => e.name)).not.toContain('５ダム');
    expect(entries.map((e) => e.name)).not.toContain('９ダム');
    expect(entries.every((e) => e.bind !== 'never')).toBe(true);
    expect(entries.every((e) => readingOf(e).state === 'values')).toBe(true);
  });
});
