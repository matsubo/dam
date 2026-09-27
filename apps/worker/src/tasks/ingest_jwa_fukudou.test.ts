// apps/worker/src/tasks/ingest_jwa_fukudou.test.ts
//
// Fixture is a verbatim Shift_JIS capture of 水資源機構 筑後川局 福岡導水管理室
// water.go.jp/chikugo/fukudou/html/info02.html (Last-Modified 2026-09-25 04:34
// JST): 山口調整池 at 令和8年9月25日 0時 — EL 117.04 m, 総貯水量 3,758,400 m³,
// 貯水率 94.0 %.

import { describe, expect, test } from 'bun:test';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { chooseMaster, parseFukudouPage, usableVolumeM3 } from './ingest_jwa_fukudou.ts';

async function fixtureHtml(): Promise<string> {
  const path = join(
    import.meta.dir,
    '..',
    '..',
    '..',
    '..',
    'tests/fixtures/jwa_fukudou/info02_2026-09-25.shiftjis.html',
  );
  return new TextDecoder('shift_jis').decode(await readFile(path));
}

// ダム便覧 / NDI figures for 山口調整池 (ndi 2487).
const YAMAGUCHI = { totalCapacityM3: 4_000_000, activeCapacityM3: 3_900_000 };

describe('parseFukudouPage', () => {
  test('reads 山口調整池 level, gross volume and rate at the JST report hour', async () => {
    expect(parseFukudouPage(await fixtureHtml())).toEqual({
      observedAt: new Date('2026-09-24T15:00:00Z'), // 2026-09-25 00:00 JST
      waterLevelM: 117.04,
      grossVolumeM3: 3_758_400,
      ratePct: 94,
    });
  });

  test('returns null for a page without the 山口調整池 block', () => {
    expect(parseFukudouPage('<html><body>メンテナンス中</body></html>')).toBeNull();
  });
});

describe('usableVolumeM3', () => {
  test('subtracts 堆砂容量 when the rate is printed against the master 総貯水容量', () => {
    // 3,758,400 / 4,000,000 = 93.96 % → printed 94.0; stored as water above 最低水位.
    expect(usableVolumeM3({ grossVolumeM3: 3_758_400, ratePct: 94 }, YAMAGUCHI)).toBe(3_658_400);
  });

  test('stores nothing when the printed rate no longer ties to the master total', () => {
    // A master whose 総貯水容量 were the 有効 figure would put this at 96.4 %.
    expect(
      usableVolumeM3(
        { grossVolumeM3: 3_758_400, ratePct: 94 },
        { totalCapacityM3: 3_900_000, activeCapacityM3: 3_900_000 },
      ),
    ).toBeNull();
    expect(
      usableVolumeM3(
        { grossVolumeM3: 3_758_400, ratePct: 94 },
        { totalCapacityM3: null, activeCapacityM3: 3_900_000 },
      ),
    ).toBeNull();
  });
});

describe('chooseMaster', () => {
  const m = (id: number, name: string, stamp: string | null = null) => ({
    id: BigInt(id),
    name,
    completedYear: null,
    stamp,
  });

  test('binds 山口調整池, never the unrelated 山口 dam in the same prefecture', () => {
    expect(chooseMaster([m(11001, '山口'), m(11058, '山口調整池')])).toBe(11058n);
    expect(chooseMaster([m(11001, '山口')])).toBeNull();
  });

  test('keeps the row already stamped with the station', () => {
    expect(chooseMaster([m(1, '山口調整池'), m(2, '山口調整池', '山口調整池')])).toBe(2n);
  });
});
