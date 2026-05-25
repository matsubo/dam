// apps/worker/src/tasks/ingest_okayama.test.ts
//
// Pure-function tests for the おかやま防災ポータル JSON parser. The
// DB-touching parts (ensureSourcePriority, matching, the upsert) are out
// of scope here — they're exercised end-to-end by the worker integration
// suite.
//
// Fixtures are verbatim captures of the live JSON feed from 2026-05-25:
//   - data/damQuantities/list/2026-05-25-11-30.json (the per-fetch snapshot)
// The asserted values are eyeballed against the feed, so a parser refactor
// that changes them should fail loudly.

import { describe, expect, test } from 'bun:test';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import {
  chooseMaster,
  normalizeName,
  parseOkayamaItems,
  parseOkayamaTimestamp,
} from './ingest_okayama.ts';

const FIXTURE = join(
  import.meta.dir,
  '..',
  '..',
  '..',
  '..',
  'tests/fixtures/okayama/list_2026-05-25-11-30.json',
);

describe('parseOkayamaTimestamp', () => {
  test('parses 「YYYY-MM-DD HH:MM:SS」 JST → UTC', () => {
    const d = parseOkayamaTimestamp('2026-05-25 11:30:00');
    expect(d).not.toBeNull();
    // 11:30 JST = 02:30 UTC same day.
    expect(d?.toISOString()).toBe('2026-05-25T02:30:00.000Z');
  });

  test('returns null on malformed input', () => {
    expect(parseOkayamaTimestamp('garbage')).toBeNull();
    expect(parseOkayamaTimestamp('')).toBeNull();
  });
});

describe('normalizeName', () => {
  test('strips ダム suffix and (国)/（国） manager annotations', () => {
    expect(normalizeName('苫田ダム(国)')).toBe('苫田');
    expect(normalizeName('苫田ダム（国）')).toBe('苫田');
    expect(normalizeName('旭川ダム')).toBe('旭川');
    expect(normalizeName('八塔寺川ダム')).toBe('八塔寺川');
  });

  test('folds the 槇/槙 kanji variant so the feed matches the master', () => {
    // Feed uses 槙 (U+69D9); master stores 槇 (U+69C7). Both must normalize equal.
    expect(normalizeName('槙谷ダム')).toBe(normalizeName('槇谷'));
  });
});

describe('parseOkayamaItems', () => {
  test('keeps only dams reporting a storage value (flg=0)', async () => {
    const json = JSON.parse(await readFile(FIXTURE, 'utf8'));
    const rows = parseOkayamaItems(json.items);
    // 15 of the 21 dams in this snapshot report an effective-storage value;
    // the other 6 carry flg=4 (no telemetry) and must be dropped.
    expect(rows.length).toBe(15);
    // No row should have a fully-null payload.
    for (const r of rows) {
      const hasValue = r.storageVolumeM3 != null || r.waterLevelM != null || r.storageRate != null;
      expect(hasValue).toBe(true);
    }
  });

  test('extracts correct values for 旭川ダム', async () => {
    const json = JSON.parse(await readFile(FIXTURE, 'utf8'));
    const rows = parseOkayamaItems(json.items);
    const asahi = rows.find((r) => r.observatoryId === '05200301');
    expect(asahi).toBeDefined();
    // damEffectiveStorageQuantities is already in m³ on this feed.
    expect(asahi?.storageVolumeM3).toBe(19_998_000);
    expect(asahi?.waterLevelM).toBe(100.21);
    expect(asahi?.observatoryName).toBe('旭川ダム');
  });

  test('drops flg=4 rows (湯原ダム carries no telemetry here)', async () => {
    const json = JSON.parse(await readFile(FIXTURE, 'utf8'));
    const rows = parseOkayamaItems(json.items);
    expect(rows.find((r) => r.observatoryId === '05200501')).toBeUndefined();
  });

  test('returns empty array for empty input', () => {
    expect(parseOkayamaItems([])).toEqual([]);
  });
});

describe('chooseMaster', () => {
  const masters = [
    { id: 1n, name: '黒谷池（元）' },
    { id: 2n, name: '黒谷（再）' },
    { id: 3n, name: '槇谷' },
    { id: 4n, name: '旭川' },
    { id: 5n, name: '苫田' },
  ];

  test('prefers the exact stem match over a longer substring collision', () => {
    // 黒谷 must land on 黒谷（再） (stem 黒谷), not 黒谷池（元） (stem 黒谷池).
    expect(chooseMaster('黒谷', masters)).toBe(2n);
  });

  test('matches across the 槇/槙 kanji variant', () => {
    expect(chooseMaster(normalizeName('槙谷ダム'), masters)).toBe(3n);
  });

  test('matches plain stems', () => {
    expect(chooseMaster('旭川', masters)).toBe(4n);
    expect(chooseMaster('苫田', masters)).toBe(5n);
  });

  test('returns null when nothing matches', () => {
    expect(chooseMaster('存在しない', masters)).toBeNull();
  });
});
