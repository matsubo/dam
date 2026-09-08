/**
 * 国土数値情報 W05（河川）: collect the 区間種別 (W05_003) values observed for
 * each 水系域コード (W05_001) across the per-prefecture Stream attribute
 * tables. A river system may span prefectures, so callers pass every DBF
 * they have and the sets are unioned.
 *
 * 区間種別 legend (from the W05 product page):
 *   1 一級直轄区間 / 2 一級指定区間 / 3 二級河川区間 / 4 指定区間外
 *   5,6 = 1,2 + 湖沼区間 / 7 = 3 + 湖沼区間 / 8 = 4 + 湖沼区間 / 0 不明
 */
import { readDbfRecords } from './dbf.ts';

const WATER_SYSTEM_CODE = 'W05_001';
const SECTION_TYPE = 'W05_003';

export function collectW05SectionTypes(
  streamDbfs: readonly Uint8Array[],
): ReadonlyMap<string, ReadonlySet<string>> {
  const byCode = new Map<string, Set<string>>();
  for (const buf of streamDbfs) {
    for (const row of readDbfRecords(buf, [WATER_SYSTEM_CODE, SECTION_TYPE])) {
      const code = row[WATER_SYSTEM_CODE];
      const section = row[SECTION_TYPE];
      if (!code || !section) continue;
      const set = byCode.get(code) ?? new Set<string>();
      set.add(section);
      byCode.set(code, set);
    }
  }
  return byCode;
}
