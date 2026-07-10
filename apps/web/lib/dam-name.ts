// Search-intent display name: the master stores bare names (宮ヶ瀬) but
// people search "宮ヶ瀬ダム 貯水率", so titles/H1s need the ダム suffix —
// except for structures that aren't dams (堰・水門・調整池・溜池・遊水地・
// 湖沼) and names that already carry it.

/**
 * Endings that mark a non-dam structure (or an existing suffix).
 * NOTE: 川 is deliberately NOT here — many dam names end with 川
 * (三川, 松川, 湯川…) and must still get the ダム suffix.
 */
const SUFFIX_RE = /(ダム|堰|水門|調整池|貯水池|溜池|ため池|遊水地|遊水池|湖|池)$/;

/**
 * "宮ヶ瀬" → "宮ヶ瀬ダム"; "利根川河口堰" stays; parenthetical qualifiers
 * stay after the suffix: "中禅寺（元）" → "中禅寺ダム（元）".
 */
export function damDisplayName(name: string): string {
  // Split a trailing parenthetical qualifier — （元）/（再）etc.
  const m = name.match(/^(.*?)([（(][^（()）]*[)）])$/);
  const base = (m?.[1] ?? name).trim();
  const paren = m?.[2] ?? '';
  if (base === '' || SUFFIX_RE.test(base)) return name;
  return `${base}ダム${paren}`;
}
