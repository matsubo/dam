/**
 * 河川法上の水系区分 (一級 / 二級 / その他) derived from 国土数値情報 codes.
 *
 * 水系域コード (6 digits) = the upper 6 digits of the 河川コード:
 *   - prefix 81–89: systems managed by a 地方整備局 — exactly the 109 一級水系
 *   - prefix 01–47: prefecture-managed systems (二級水系, or 準用/普通河川-only
 *     systems that are neither); W05 区間種別 tells the two apart
 *   - "xx0000": placeholder for "no code known"
 */

export type WatershedKind = 'first' | 'second' | 'other';

const KIND_RANK: Record<WatershedKind, number> = { first: 0, second: 1, other: 2 };

/** W05_003 values that mean the reach is a 二級河川区間 (7 = 3 + 湖沼区間). */
const SECOND_CLASS_SECTIONS: ReadonlySet<string> = new Set(['3', '7']);

const FIRST_CLASS_CODE = /^8[1-9]\d{4}$/;
const UNKNOWN_SYSTEM_CODE = /^\d{2}0000$/;

export function isFirstClassWatershedCode(code: string): boolean {
  return FIRST_CLASS_CODE.test(code);
}

export function kindFromWatershedCode(
  code: string,
  sectionTypes?: ReadonlySet<string>,
): WatershedKind {
  if (isFirstClassWatershedCode(code)) return 'first';
  if (UNKNOWN_SYSTEM_CODE.test(code)) return 'other';
  if (sectionTypes && [...sectionTypes].some((s) => SECOND_CLASS_SECTIONS.has(s))) return 'second';
  return 'other';
}

/** Glyph variants seen between W01 水系名 and the codelist. */
const NAME_VARIANTS: Record<string, string> = {
  曾: '曽',
  澤: '沢',
  濱: '浜',
  龍: '竜',
  嶋: '島',
  邊: '辺',
  邉: '辺',
  ノ: 'の',
  之: 'の',
  ヶ: 'ケ',
  ヵ: 'カ',
  ッ: 'ツ',
};

export function normalizeWatershedName(name: string): string {
  return [...name.normalize('NFKC').trim()].map((ch) => NAME_VARIANTS[ch] ?? ch).join('');
}

export interface WatershedCandidate {
  readonly code: string;
  readonly kind: WatershedKind;
}

function byKindThenCode(a: WatershedCandidate, b: WatershedCandidate): number {
  const rank = KIND_RANK[a.kind] - KIND_RANK[b.kind];
  return rank !== 0 ? rank : a.code.localeCompare(b.code);
}

/**
 * Choose which same-named system a W01 watershed row refers to.
 *   1. a 一級 (8x) code always wins — those systems are large and named
 *      collisions with a small prefecture river are the common case
 *   2. otherwise a code whose prefecture prefix matches where the dams are
 *   3. otherwise every candidate; ties broken by better kind, then lowest code
 */
export function pickWatershedCandidate(
  candidates: readonly WatershedCandidate[],
  damPrefCodes: ReadonlySet<string>,
): WatershedCandidate | null {
  if (candidates.length === 0) return null;
  const firstClass = candidates.filter((c) => isFirstClassWatershedCode(c.code));
  const inDamPrefecture = candidates.filter((c) => damPrefCodes.has(c.code.slice(0, 2)));
  const pool =
    firstClass.length > 0 ? firstClass : inDamPrefecture.length > 0 ? inDamPrefecture : candidates;
  return [...pool].sort(byKindThenCode)[0] ?? null;
}
