// apps/worker/src/tasks/ingest_kkr_mlit.test.ts

import { describe, expect, test } from 'bun:test';
import { type ParsedRow, parseKkrDatetime, parseKkrJson } from './ingest_kkr_mlit.ts';

describe('parseKkrDatetime', () => {
  test('parses "YYYY-MM-DD HH:MM:SS" JST → UTC (subtract 9h)', () => {
    const d = parseKkrDatetime('2026-06-05 15:00:00');
    expect(d).not.toBeNull();
    // 15:00 JST = 06:00 UTC
    expect(d?.toISOString()).toBe('2026-06-05T06:00:00.000Z');
  });

  test('handles midnight crossover (JST 06:00 → previous UTC day 21:00)', () => {
    const d = parseKkrDatetime('2026-06-05 06:00:00');
    expect(d).not.toBeNull();
    // 06:00 JST = 2026-06-04T21:00:00Z
    expect(d?.toISOString()).toBe('2026-06-04T21:00:00.000Z');
  });

  test('returns null for malformed string', () => {
    expect(parseKkrDatetime('bad')).toBeNull();
    expect(parseKkrDatetime('')).toBeNull();
    expect(parseKkrDatetime('2026-06-05')).toBeNull();
    expect(parseKkrDatetime('2026/06/05 15:00:00')).toBeNull();
  });
});

describe('parseKkrJson', () => {
  const BASE_JSON = {
    datetime: '2026-06-05 15:00:00',
    lake: { biwako: { suii: { today: '7', diff: ['-4', '&darr;'] } } },
    dam: {
      managawa: { chosuiritsu: { today: '56.4', diff: ['-1.1', '&darr;'] } },
      kuzuryu: { chosuiritsu: { today: '64.1', diff: ['-0.4', '&darr;'] } },
      amagase: { chosuiritsu: { today: '71.9', diff: ['1', '&uarr;'] } },
      muro: { chosuiritsu: { today: '74.9', diff: ['2.4', '&uarr;'] } },
      syourenji: { chosuiritsu: { today: '81.2', diff: ['-2.3', '&darr;'] } },
      takayama: { chosuiritsu: { today: '30.2', diff: ['-4', '&darr;'] } },
      nunome: { chosuiritsu: { today: '81.5', diff: ['0.8', '&uarr;'] } },
      hiyoshi: { chosuiritsu: { today: '53.9', diff: ['-2.1', '&darr;'] } },
      hinati: { chosuiritsu: { today: '69.9', diff: ['-2.2', '&darr;'] } },
      hitokura: { chosuiritsu: { today: '60.6', diff: ['-2.1', '&darr;'] } },
      otaki: { chosuiritsu: { today: '47.4', diff: ['-0.5', '&darr;'] } },
      sarutani: { chosuiritsu: { today: '82.9', diff: ['-0.3', '&darr;'] } },
    },
  };

  test('parses all 12 dams from typical JSON', () => {
    const rows = parseKkrJson(BASE_JSON);
    expect(rows).toHaveLength(12);
  });

  test('converts datetime to UTC and attaches to all rows', () => {
    const rows = parseKkrJson(BASE_JSON);
    // 15:00 JST = 06:00 UTC
    expect(rows[0]?.observedAt.toISOString()).toBe('2026-06-05T06:00:00.000Z');
    expect(rows[11]?.observedAt.toISOString()).toBe('2026-06-05T06:00:00.000Z');
  });

  test('parses storageRate as floating-point percent', () => {
    const rows = parseKkrJson(BASE_JSON);
    const managawa = rows.find((r) => r.damName === '真名川ダム');
    expect(managawa?.storageRate).toBeCloseTo(56.4);
    const takayama = rows.find((r) => r.damName === '高山ダム');
    expect(takayama?.storageRate).toBeCloseTo(30.2);
  });

  test('key field matches the JSON key', () => {
    const rows = parseKkrJson(BASE_JSON);
    const amagase = rows.find((r) => r.damName === '天ヶ瀬ダム');
    expect(amagase?.key).toBe('amagase');
    const hinati = rows.find((r) => r.damName === '比奈知ダム');
    expect(hinati?.key).toBe('hinati');
  });

  test('returns empty array for invalid datetime', () => {
    const rows = parseKkrJson({ ...BASE_JSON, datetime: 'invalid' });
    expect(rows).toHaveLength(0);
  });

  test('skips missing dam entries gracefully', () => {
    const partial = {
      ...BASE_JSON,
      dam: {
        managawa: { chosuiritsu: { today: '56.4', diff: ['-1.1', '&darr;'] } },
        kuzuryu: { chosuiritsu: { today: '64.1', diff: ['-0.4', '&darr;'] } },
      },
    };
    const rows = parseKkrJson(partial);
    expect(rows).toHaveLength(2);
    expect(rows.map((r) => r.key)).toEqual(['managawa', 'kuzuryu']);
  });

  test('storageRate is null when today value is empty string', () => {
    const withEmpty = {
      ...BASE_JSON,
      dam: {
        ...BASE_JSON.dam,
        managawa: { chosuiritsu: { today: '', diff: ['', ''] } },
      },
    };
    const rows = parseKkrJson(withEmpty);
    const managawa = rows.find((r) => r.key === 'managawa');
    expect(managawa?.storageRate).toBeNull();
  });

  test('storageRate is null when chosuiritsu missing', () => {
    const withMissing = {
      ...BASE_JSON,
      dam: {
        ...BASE_JSON.dam,
        amagase: {},
      },
    };
    const rows = parseKkrJson(withMissing);
    const amagase = rows.find((r) => r.key === 'amagase');
    expect(amagase?.storageRate).toBeNull();
  });
});
