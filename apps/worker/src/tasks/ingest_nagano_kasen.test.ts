import { describe, expect, test } from 'bun:test';
import { buildNaganoUrl, parseNaganoJson, parseNaganoTimestamp } from './ingest_nagano_kasen.ts';

describe('parseNaganoTimestamp', () => {
  test('parses "YYYY-MM-DD-HH-mm" (JST) → UTC', () => {
    const d = parseNaganoTimestamp('2026-06-05-20-00');
    expect(d?.toISOString()).toBe('2026-06-05T11:00:00.000Z');
  });

  test('handles midnight crossover (JST 00:00 → previous UTC day)', () => {
    const d = parseNaganoTimestamp('2026-06-05-00-00');
    expect(d?.toISOString()).toBe('2026-06-04T15:00:00.000Z');
  });

  test('returns null for malformed input', () => {
    expect(parseNaganoTimestamp('')).toBeNull();
    expect(parseNaganoTimestamp('2026-06-05')).toBeNull();
    expect(parseNaganoTimestamp('bad')).toBeNull();
  });
});

describe('buildNaganoUrl', () => {
  test('generates correct URL using JST date', () => {
    // 2026-06-05 17:00 UTC = 2026-06-06 02:00 JST → date 20260606
    const url = buildNaganoUrl(
      new Date('2026-06-05T17:00:00.000Z'),
      'https://www.sabo-nagano.jp/dyn/json/dat/pc',
    );
    expect(url).toBe('https://www.sabo-nagano.jp/dyn/json/dat/pc/20260606/20260606_1_dam_60.json');
  });

  test('same-day when UTC still within JST date', () => {
    // 2026-06-05 08:00 UTC = 2026-06-05 17:00 JST → date 20260605
    const url = buildNaganoUrl(
      new Date('2026-06-05T08:00:00.000Z'),
      'https://www.sabo-nagano.jp/dyn/json/dat/pc',
    );
    expect(url).toBe('https://www.sabo-nagano.jp/dyn/json/dat/pc/20260605/20260605_1_dam_60.json');
  });
});

// Sample JSON — uses "value"/"level" (not "val"/"lvl" like Fukushima).
// Includes 釜口水門 (2001_7_3) which must be excluded.
const SAMPLE_JSON = {
  observationTime: '2026-06-05-20-00',
  updateTime: '2026-06-05-20-59',
  // 松川ダム: all fields present
  '2001_7_1': {
    data60: [
      {
        time: '2026-06-05-20-00',
        item_10: { value: '681.32', level: 0 },
        item_20: { value: '446', level: 0 },
        item_50: { value: '2.47', level: 0 },
        item_70: { value: '2.50', level: 0 },
      },
    ],
  },
  // 横川ダム: missing storage volume ("--")
  '2001_7_5': {
    data60: [
      {
        time: '2026-06-05-20-00',
        item_10: { value: '903.09', level: 2 },
        item_20: { value: '--', level: -3 },
        item_50: { value: '1.47', level: 0 },
        item_70: { value: '1.47', level: 0 },
      },
    ],
  },
  // 釜口水門: sluice gate — must be excluded (not in STATION_MAP)
  '2001_7_3': {
    data60: [
      {
        time: '2026-06-05-20-00',
        item_10: { value: '762.44', level: 0 },
      },
    ],
  },
};

describe('parseNaganoJson', () => {
  test('returns 2 rows (釜口水門 excluded)', () => {
    const rows = parseNaganoJson(SAMPLE_JSON);
    expect(rows).toHaveLength(2);
    expect(rows.map((r) => r.naganoName)).toEqual(['松川ダム', '横川ダム']);
  });

  test('observedAt converted from JST to UTC', () => {
    const rows = parseNaganoJson(SAMPLE_JSON);
    for (const r of rows) {
      expect(r.observedAt.toISOString()).toBe('2026-06-05T11:00:00.000Z');
    }
  });

  test('松川ダム: storage volume multiplied by 1000', () => {
    const r = parseNaganoJson(SAMPLE_JSON).find((x) => x.naganoName === '松川ダム');
    expect(r).toBeDefined();
    expect(r?.waterLevelM).toBeCloseTo(681.32);
    expect(r?.storageVolumeM3).toBeCloseTo(446_000);
    expect(r?.inflowM3s).toBeCloseTo(2.47);
    expect(r?.outflowM3s).toBeCloseTo(2.5);
  });

  test('横川ダム: "--" storage volume → null', () => {
    const r = parseNaganoJson(SAMPLE_JSON).find((x) => x.naganoName === '横川ダム');
    expect(r).toBeDefined();
    expect(r?.waterLevelM).toBeCloseTo(903.09);
    expect(r?.storageVolumeM3).toBeNull();
    expect(r?.inflowM3s).toBeCloseTo(1.47);
  });

  test('釜口水門 excluded (not in STATION_MAP)', () => {
    const rows = parseNaganoJson(SAMPLE_JSON);
    expect(rows.find((r) => r.naganoName.includes('釜口'))).toBeUndefined();
  });

  test('returns empty array for empty JSON', () => {
    expect(parseNaganoJson({ observationTime: '2026-06-05-20-00' })).toHaveLength(0);
  });
});
