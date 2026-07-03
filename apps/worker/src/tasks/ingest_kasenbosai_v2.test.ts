import { describe, expect, test } from 'bun:test';
import { parseKasenbosaiObsValue, parseKasenbosaiTimestamp } from './ingest_kasenbosai_v2.ts';

describe('parseKasenbosaiTimestamp', () => {
  test('JST → UTC', () => {
    expect(parseKasenbosaiTimestamp('2026/07/03 12:00')?.toISOString()).toBe(
      '2026-07-03T03:00:00.000Z',
    );
  });
});

describe('parseKasenbosaiObsValue quality codes', () => {
  test('Ccd=160 (欠測) zeroes are dropped, valid fields kept', () => {
    // Real payload shape from 呑吐ダム: the feed reports 貯水量/貯水率 as 0
    // with Ccd=160 when the dam simply doesn't publish them, while level and
    // flow carry real values (Ccd=0).
    const parsed = parseKasenbosaiObsValue({
      storLvl: 141.79,
      storLvlCcd: 0,
      storCap: 0,
      storCapCcd: 160,
      storPcntIrr: 0,
      storPcntIrrCcd: 160,
      storPcntEff: 0,
      storPcntEffCcd: 160,
      allSink: 2.81,
      allSinkCcd: 0,
      allDisch: 2.78,
      allDischCcd: null,
      obsTime: '2026/07/03 12:00',
    });
    expect(parsed).not.toBeNull();
    expect(parsed?.storageVolumeM3).toBeNull();
    expect(parsed?.storageRate).toBeNull();
    expect(parsed?.waterLevelM).toBe(141.79);
    expect(parsed?.inflowM3s).toBe(2.81);
    expect(parsed?.outflowM3s).toBe(2.78);
  });

  test('Ccd=0 values pass through (storCap 千m³ → m³)', () => {
    const parsed = parseKasenbosaiObsValue({
      storCap: 28,
      storCapCcd: 0,
      storPcntEff: 61.5,
      storPcntEffCcd: 0,
      storLvl: 274.26,
      storLvlCcd: 0,
      obsTime: '2026/07/03 12:00',
    });
    expect(parsed?.storageVolumeM3).toBe(28_000);
    expect(parsed?.storageRate).toBeCloseTo(0.615, 6);
    expect(parsed?.waterLevelM).toBe(274.26);
  });

  test('missing Ccd is treated as valid (older payloads without codes)', () => {
    const parsed = parseKasenbosaiObsValue({
      storCap: 100,
      storPcntIrr: 50,
      obsTime: '2026/07/03 12:00',
    });
    expect(parsed?.storageVolumeM3).toBe(100_000);
    expect(parsed?.storageRate).toBeCloseTo(0.5, 6);
  });

  test('storPcntEff invalid → falls back to storPcntIrr', () => {
    const parsed = parseKasenbosaiObsValue({
      storCap: 100,
      storCapCcd: 0,
      storPcntEff: 0,
      storPcntEffCcd: 160,
      storPcntIrr: 42,
      storPcntIrrCcd: 0,
      obsTime: '2026/07/03 12:00',
    });
    expect(parsed?.storageRate).toBeCloseTo(0.42, 6);
  });

  test('unparseable obsTime → null', () => {
    expect(parseKasenbosaiObsValue({ storCap: 1, obsTime: 'garbage' })).toBeNull();
  });
});
