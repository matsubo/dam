import { describe, expect, test } from 'bun:test';

// Mirror of the (private) normalizeName helper in apps/web/bin/match_damnet.ts.
// Kept in sync because the migration outcome (利水容量 carrying across redev
// variants) hinges on this collapsing 早明浦（再）/早明浦（元）/早明浦 to the
// same key.
function normalizeName(s: string): string {
  return s
    .normalize('NFKC')
    .replace(/[（(](?:再|元|新)[）)]/gu, '')
    .replace(/(?:ダム|貯水池|池)$/u, '')
    .trim()
    .toLowerCase();
}

describe('match_damnet normalizeName', () => {
  test('strips ダム suffix', () => {
    expect(normalizeName('道志ダム')).toBe('道志');
  });
  test('strips 貯水池 suffix', () => {
    expect(normalizeName('八ッ場貯水池')).toBe('八ッ場');
  });
  test('strips 池 suffix', () => {
    expect(normalizeName('御大典池')).toBe('御大典');
  });
  test('（再）/（元）/（新） variants collapse to the same key', () => {
    const a = normalizeName('早明浦（元）');
    const b = normalizeName('早明浦（再）');
    const c = normalizeName('早明浦ダム');
    const d = normalizeName('新桂沢（再）');
    const e = normalizeName('新桂沢ダム');
    expect(a).toBe('早明浦');
    expect(b).toBe('早明浦');
    expect(c).toBe('早明浦');
    expect(d).toBe('新桂沢');
    expect(e).toBe('新桂沢');
  });
  test('half-width parens version is also stripped', () => {
    expect(normalizeName('早明浦(再)ダム')).toBe('早明浦');
    expect(normalizeName('早明浦(元)')).toBe('早明浦');
  });
  test('NFKC folds halfwidth katakana', () => {
    // 'ﾔﾝﾊﾞ' (halfwidth) → 'ヤンバ' (fullwidth)
    expect(normalizeName('ﾔﾝﾊﾞダム')).toBe('ヤンバ'.normalize('NFKC').toLowerCase());
  });
  test('lowercases ASCII', () => {
    expect(normalizeName('SAMEURA Dam')).toBe('sameura dam');
  });
  test('trims whitespace', () => {
    expect(normalizeName('  鶴田  ')).toBe('鶴田');
  });
  test('non-（再）parens stay (NFKC folds them to half-width but keeps the content)', () => {
    // NFKC turns 「（注）」into 「(注)」 — the content is preserved, only the
    // dam suffix is dropped. Important: this means agents matching on text
    // containing parens after our normaliser get half-width parens back.
    expect(normalizeName('テスト（注）ダム')).toBe('テスト(注)');
  });
});
