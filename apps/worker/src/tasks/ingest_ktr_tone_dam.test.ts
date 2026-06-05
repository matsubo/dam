// apps/worker/src/tasks/ingest_ktr_tone_dam.test.ts

import { describe, expect, test } from 'bun:test';
import { parseToneDamJson, parseToneTimestamp } from './ingest_ktr_tone_dam.ts';

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
    // Aggregate entry — should be excluded
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

describe('parseToneDamJson', () => {
  test('parses 3 rows (aggregate 5ダム excluded)', () => {
    const rows = parseToneDamJson(SAMPLE_JSON);
    expect(rows).toHaveLength(3);
    expect(rows.map((r) => r.toneName)).toEqual(['矢木沢ダム', '藤原ダム', '渡良瀬貯水池']);
  });

  test('矢木沢ダム: storage converted from 千m³ to m³, rate as ratio', () => {
    const r = parseToneDamJson(SAMPLE_JSON).find((x) => x.toneName === '矢木沢ダム');
    expect(r).toBeDefined();
    expect(r?.storageVolumeM3).toBe(43_918_000);
    expect(r?.storageRate).toBeCloseTo(0.38);
    expect(r?.inflowM3s).toBeCloseTo(17.43);
    expect(r?.outflowM3s).toBeCloseTo(0.0);
  });

  test('藤原ダム: all fields parsed correctly', () => {
    const r = parseToneDamJson(SAMPLE_JSON).find((x) => x.toneName === '藤原ダム');
    expect(r).toBeDefined();
    expect(r?.storageVolumeM3).toBe(28_319_000);
    expect(r?.storageRate).toBeCloseTo(0.913);
    expect(r?.inflowM3s).toBeCloseTo(8.58);
    expect(r?.outflowM3s).toBeCloseTo(48.81);
  });

  test('渡良瀬貯水池: "休止中" inflow and outflow → null; storage parsed', () => {
    const r = parseToneDamJson(SAMPLE_JSON).find((x) => x.toneName === '渡良瀬貯水池');
    expect(r).toBeDefined();
    expect(r?.storageVolumeM3).toBe(13_159_000);
    expect(r?.storageRate).toBeCloseTo(0.498);
    expect(r?.inflowM3s).toBeNull();
    expect(r?.outflowM3s).toBeNull();
  });

  test('５ダム aggregate excluded from results', () => {
    const rows = parseToneDamJson(SAMPLE_JSON);
    expect(rows.find((r) => r.toneName === '５ダム')).toBeUndefined();
  });

  test('observedAt parsed to correct UTC for JST 18:00', () => {
    const r = parseToneDamJson(SAMPLE_JSON)[0];
    expect(r?.observedAt.toISOString()).toBe('2026-06-05T09:00:00.000Z');
  });

  test('returns empty array for empty damDataList', () => {
    expect(parseToneDamJson({ damDataList: [] })).toHaveLength(0);
  });
});
