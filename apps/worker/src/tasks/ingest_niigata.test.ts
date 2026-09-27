// apps/worker/src/tasks/ingest_niigata.test.ts
//
// Pure-function tests for the 新潟県河川防災情報システム dam-table parser.
// The DB-touching parts (matching, upsert) are covered by the worker
// integration suite. Fixture is a verbatim Shift_JIS capture of the
// 防災Web servletBousaiTableStatus?dk=4 response from 2026-05-25.

import { describe, expect, test } from 'bun:test';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { chooseMaster, parseNiigataTable, parseStampWithYear } from './ingest_niigata.ts';

const FIXTURE = join(
  import.meta.dir,
  '..',
  '..',
  '..',
  '..',
  'tests/fixtures/niigata/dam_table_2026-05-25.shiftjis.html',
);

async function fixtureHtml(): Promise<string> {
  const buf = await readFile(FIXTURE);
  return new TextDecoder('shift_jis').decode(buf);
}

describe('parseStampWithYear', () => {
  test('parses 「MM/DD HH:MM」 against a reference year (JST → UTC)', () => {
    const d = parseStampWithYear('05/25 11:50', new Date('2026-05-25T03:00:00Z'));
    // 11:50 JST = 02:50 UTC same day.
    expect(d?.toISOString()).toBe('2026-05-25T02:50:00.000Z');
  });

  test('rolls back to the previous year when MM/DD is in the future', () => {
    // Reference Jan 2026, stamp 12/31 → must be Dec 2025, not Dec 2026.
    const d = parseStampWithYear('12/31 23:00', new Date('2026-01-02T00:00:00Z'));
    expect(d?.getUTCFullYear()).toBe(2025);
  });

  test('returns null on malformed input', () => {
    expect(parseStampWithYear('nope', new Date())).toBeNull();
  });
});

describe('parseNiigataTable', () => {
  test('extracts one row per dam with cleaned numeric values', async () => {
    const rows = parseNiigataTable(await fixtureHtml(), new Date('2026-05-25T03:00:00Z'));
    expect(rows.length).toBe(20);
    for (const r of rows) {
      expect(r.niigataName).toMatch(/ダム$/);
      expect(r.observedAt).toBeInstanceOf(Date);
    }
  });

  test('gets values right for 奥胎内ダム (arrows + nbsp stripped)', async () => {
    const rows = parseNiigataTable(await fixtureHtml(), new Date('2026-05-25T03:00:00Z'));
    const oku = rows.find((r) => r.niigataName === '奥胎内ダム');
    expect(oku).toBeDefined();
    expect(oku?.waterLevelM).toBeCloseTo(384.01, 2);
    expect(oku?.inflowM3s).toBeCloseTo(6.37, 2);
    expect(oku?.outflowM3s).toBeCloseTo(6.7, 2);
    // 奥胎内 shows 貯水率 「---」 in this snapshot → null.
    expect(oku?.storageRate).toBeNull();
  });

  test('parses 貯水率 percentage into a 0-1 fraction (大谷ダム = 100%)', async () => {
    const rows = parseNiigataTable(await fixtureHtml(), new Date('2026-05-25T03:00:00Z'));
    const otani = rows.find((r) => r.niigataName === '大谷ダム');
    expect(otani?.storageRate).toBeCloseTo(1.0, 3);
    expect(otani?.waterLevelM).toBeCloseTo(191.58, 2);
  });

  test('returns empty array when no dam rows present', () => {
    expect(parseNiigataTable('<table><tr><td>観測所名</td></tr></table>', new Date())).toEqual([]);
  });
});

describe('chooseMaster (#57)', () => {
  test('binds 笠堀 to the completed （再）, not the lower-id （元）', () => {
    const masters = [
      { id: 10n, name: '笠堀（元）', completedYear: 1964, stamp: null },
      { id: 20n, name: '笠堀（再）', completedYear: 2017, stamp: null },
    ];
    expect(chooseMaster('笠堀', masters, '笠堀ダム')).toBe(20n);
  });
});
