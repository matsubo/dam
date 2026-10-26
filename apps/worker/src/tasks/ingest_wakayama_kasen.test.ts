// Fixture → universe entries, no database: binding and writing belong to the
// ingest run (apps/worker/src/ingest/run.test.ts).

import { describe, expect, test } from 'bun:test';
import type { Entry, Observed, Reading } from '../ingest/types.ts';
import { parseWakayamaTimestamp, wakayamaEntries } from './ingest_wakayama_kasen.ts';

describe('parseWakayamaTimestamp', () => {
  test('parses "YYYYMMDDHHmm" (JST) → UTC', () => {
    const d = parseWakayamaTimestamp('202606052100');
    expect(d?.toISOString()).toBe('2026-06-05T12:00:00.000Z');
  });

  test('midnight crossover: JST 00:00 → previous UTC day', () => {
    const d = parseWakayamaTimestamp('202606050000');
    expect(d?.toISOString()).toBe('2026-06-04T15:00:00.000Z');
  });

  test('returns null for wrong length', () => {
    expect(parseWakayamaTimestamp('')).toBeNull();
    expect(parseWakayamaTimestamp('20260605210')).toBeNull();
    expect(parseWakayamaTimestamp('2026060521000')).toBeNull();
  });

  test('returns null for non-numeric input', () => {
    expect(parseWakayamaTimestamp('xxxxxxxxxxxx')).toBeNull();
  });
});

const SAMPLE_CSV = `450,0,0.7,0.7,137.59,743,202606052100
470,0,14.3,16.8,186.68,6054,202606052100
601,0,42.8,45.1,116.64,****,202606052100
22077001,0,7.1,14.0,433.07,****,202606052100
550,0,****,****,****,****,202606052100
9999,0,1.0,1.0,100.00,100,202606052100
`;

function reading(entries: Entry[], key: string): Reading {
  const r = entries.find((e) => e.key === key)?.reading;
  if (!r || typeof r === 'function') throw new Error(`${key}: no reading`);
  return r;
}

function observed(entries: Entry[], key: string): Observed {
  const r = reading(entries, key);
  if (r.state !== 'values' || !r.observations[0]) throw new Error(`${key}: no values`);
  return r.observations[0];
}

describe('wakayamaEntries', () => {
  test('every mapped station is listed, plus an unknown code under its own code', () => {
    const entries = wakayamaEntries(SAMPLE_CSV);
    expect(entries).toHaveLength(20);
    expect(entries.find((e) => e.key === '450')?.name).toBe('広川ダム');
    expect(entries.find((e) => e.key === '9999')?.name).toBe('9999');
    // 熊野川/北山川 dams sit in 奈良/三重 too: lookup scope, no recorded prefCode.
    for (const e of entries) expect(e.pref).toEqual(['24', '29', '30']);
  });

  test('a station missing from the CSV is unreadable, not dropped', () => {
    expect(reading(wakayamaEntries(SAMPLE_CSV), '801')).toEqual({
      state: 'unreadable',
      why: 'not in the CSV',
    });
  });

  test('observedAt converted from JST to UTC', () => {
    const entries = wakayamaEntries(SAMPLE_CSV);
    for (const key of ['450', '470', '601', '22077001']) {
      expect(observed(entries, key).observedAt.toISOString()).toBe('2026-06-05T12:00:00.000Z');
    }
  });

  test('広川ダム: all numeric fields parsed correctly', () => {
    const r = observed(wakayamaEntries(SAMPLE_CSV), '450');
    expect(r.outflowM3s).toBeCloseTo(0.7);
    expect(r.inflowM3s).toBeCloseTo(0.7);
    expect(r.waterLevelM).toBeCloseTo(137.59);
    expect(r.storageVolumeM3).toBeCloseTo(743_000);
  });

  test('storageVolumeM3 is multiplied by 1000 (千m³ → m³)', () => {
    expect(observed(wakayamaEntries(SAMPLE_CSV), '470').storageVolumeM3).toBeCloseTo(6_054_000);
  });

  test('"****" storage volume → null', () => {
    const r = observed(wakayamaEntries(SAMPLE_CSV), '601');
    expect(r.storageVolumeM3).toBeNull();
    expect(r.outflowM3s).toBeCloseTo(42.8);
    expect(r.inflowM3s).toBeCloseTo(45.1);
  });

  test('猿谷ダム: "****" storage and inflow parsing', () => {
    const r = observed(wakayamaEntries(SAMPLE_CSV), '22077001');
    expect(r.storageVolumeM3).toBeNull();
    expect(r.outflowM3s).toBeCloseTo(7.1);
    expect(r.inflowM3s).toBeCloseTo(14.0);
  });

  test('"****" in every column is provider-marked empty', () => {
    expect(reading(wakayamaEntries(SAMPLE_CSV), '550')).toEqual({
      state: 'empty',
      mark: '**** in every column',
    });
  });

  test('an empty CSV leaves every station unreadable', () => {
    const entries = wakayamaEntries('\n\n');
    expect(entries).toHaveLength(19);
    for (const e of entries) {
      expect(typeof e.reading !== 'function' && e.reading.state).toBe('unreadable');
    }
  });
});
