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

  test('both rate fields valid → 利水容量貯水率 (storPcntIrr) wins, not 有効容量 (#19)', () => {
    // Real 美利河ダム payload, 2026/09/08 15:00 JST. The feed's storPcntIrr
    // is the manager-published 貯水率 (denominator = current-season 利水容量,
    // 2,159 千m³ in 洪水期); storPcntEff divides by the full 有効貯水容量
    // (14,500 千m³). Official 水文水質DB shows 92.3% here, not 13.5%.
    const parsed = parseKasenbosaiObsValue({
      storLvl: 113.66,
      storLvlCcd: 0,
      storCap: 1992,
      storCapCcd: 0,
      storPcntIrr: 92.3,
      storPcntIrrCcd: 0,
      storPcntEff: 13.5,
      storPcntEffCcd: 0,
      allSink: 9.19,
      allSinkCcd: 0,
      allDisch: 12.2,
      allDischCcd: 0,
      obsTime: '2026/09/08 15:00',
    });
    expect(parsed?.storageVolumeM3).toBe(1_992_000);
    expect(parsed?.storageRate).toBeCloseTo(0.923, 6);
  });

  test('storPcntIrr invalid → falls back to storPcntEff', () => {
    const parsed = parseKasenbosaiObsValue({
      storCap: 100,
      storCapCcd: 0,
      storPcntIrr: 0,
      storPcntIrrCcd: 160,
      storPcntEff: 42,
      storPcntEffCcd: 0,
      obsTime: '2026/07/03 12:00',
    });
    expect(parsed?.storageRate).toBeCloseTo(0.42, 6);
  });

  test('storCap=0 with valid Ccd but no rate is a phantom → volume null', () => {
    // 大峠ダム pattern: publishes water level + flow, but storCap=0 with a
    // "valid" Ccd=0 and BOTH rate fields missing (Ccd=160). The 0 is a
    // non-reporting placeholder, not a real empty reservoir, so it must not
    // become a phantom 0 m³ / 0.0%.
    const parsed = parseKasenbosaiObsValue({
      storLvl: 99.51,
      storLvlCcd: 0,
      storCap: 0,
      storCapCcd: 0,
      storPcntIrr: 0,
      storPcntIrrCcd: 160,
      storPcntEff: 0,
      storPcntEffCcd: 160,
      allSink: 0.74,
      allDisch: 0.71,
      obsTime: '2026/07/03 16:40',
    });
    expect(parsed?.storageVolumeM3).toBeNull();
    expect(parsed?.storageRate).toBeNull();
    expect(parsed?.waterLevelM).toBe(99.51);
    expect(parsed?.outflowM3s).toBe(0.71);
  });

  test('storCap=0 WITH a valid 0% rate is a real empty reading → kept', () => {
    // A genuinely empty 穴あき flood-control dam reports a valid 0% rate
    // alongside the 0 volume; that must be preserved as a real observation.
    const parsed = parseKasenbosaiObsValue({
      storCap: 0,
      storCapCcd: 0,
      storPcntEff: 0,
      storPcntEffCcd: 0,
      obsTime: '2026/07/03 16:40',
    });
    expect(parsed?.storageVolumeM3).toBe(0);
    expect(parsed?.storageRate).toBe(0);
  });

  test('unparseable obsTime → null', () => {
    expect(parseKasenbosaiObsValue({ storCap: 1, obsTime: 'garbage' })).toBeNull();
  });
});
