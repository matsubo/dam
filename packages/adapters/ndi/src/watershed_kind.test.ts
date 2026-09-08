import { describe, expect, test } from 'bun:test';
import {
  isFirstClassWatershedCode,
  kindFromWatershedCode,
  normalizeWatershedName,
  pickWatershedCandidate,
} from './watershed_kind.ts';

describe('isFirstClassWatershedCode', () => {
  test('81–89 prefixes are the 地方整備局-managed 一級水系', () => {
    expect(isFirstClassWatershedCode('830303')).toBe(true); // 利根川
    expect(isFirstClassWatershedCode('890920')).toBe(true); // 山国川
    expect(isFirstClassWatershedCode('810101')).toBe(true); // 天塩川
  });

  test('prefecture prefixes and malformed codes are not', () => {
    expect(isFirstClassWatershedCode('020036')).toBe(false); // 堤川 (青森)
    expect(isFirstClassWatershedCode('800001')).toBe(false);
    expect(isFirstClassWatershedCode('8303')).toBe(false);
    expect(isFirstClassWatershedCode('')).toBe(false);
  });
});

describe('kindFromWatershedCode', () => {
  test('8x codes are first regardless of W05 evidence', () => {
    expect(kindFromWatershedCode('830303')).toBe('first');
    expect(kindFromWatershedCode('830303', new Set(['3']))).toBe('first');
  });

  test('a prefecture code with a 二級河川区間 (3 or 7) is second', () => {
    expect(kindFromWatershedCode('020036', new Set(['3', '4']))).toBe('second');
    expect(kindFromWatershedCode('140019', new Set(['7']))).toBe('second');
  });

  test('a prefecture code without 二級 sections is other', () => {
    expect(kindFromWatershedCode('130001', new Set(['0', '4']))).toBe('other');
    expect(kindFromWatershedCode('020036')).toBe('other');
  });

  test('the "県コード+0000" placeholder is other even with sections', () => {
    expect(kindFromWatershedCode('020000', new Set(['3']))).toBe('other');
  });
});

describe('normalizeWatershedName', () => {
  test('folds JIS variants so W01 spellings hit the codelist', () => {
    expect(normalizeWatershedName('木曾川')).toBe('木曽川');
    expect(normalizeWatershedName('下ノ加江川')).toBe('下の加江川');
    expect(normalizeWatershedName('八ッ瀬川')).toBe('八ツ瀬川');
  });

  test('applies NFKC and trims', () => {
    expect(normalizeWatershedName(' 利根川　')).toBe('利根川');
    expect(normalizeWatershedName('ｶﾜ')).toBe('カワ');
  });
});

describe('pickWatershedCandidate', () => {
  test('returns null when there is nothing to pick from', () => {
    expect(pickWatershedCandidate([], new Set(['13']))).toBeNull();
  });

  test('prefers a 一級 (8x) code over a same-named prefecture system', () => {
    const picked = pickWatershedCandidate(
      [
        { code: '260010', kind: 'second' },
        { code: '880807', kind: 'first' },
      ],
      new Set(['36', '39']),
    );
    expect(picked?.code).toBe('880807');
  });

  test('two 一級 codes (荒川) resolve to the lowest code', () => {
    const picked = pickWatershedCandidate(
      [
        { code: '840401', kind: 'first' },
        { code: '830304', kind: 'first' },
      ],
      new Set(['11', '15']),
    );
    expect(picked?.code).toBe('830304');
  });

  test("a prefecture code matching the dams' prefecture wins over a better kind elsewhere", () => {
    const picked = pickWatershedCandidate(
      [
        { code: '460113', kind: 'second' },
        { code: '450049', kind: 'other' },
      ],
      new Set(['45']),
    );
    expect(picked).toEqual({ code: '450049', kind: 'other' });
  });

  test('among several matches in the same prefecture, the better kind wins', () => {
    const picked = pickWatershedCandidate(
      [
        { code: '150007', kind: 'other' },
        { code: '150021', kind: 'second' },
      ],
      new Set(['15']),
    );
    expect(picked?.code).toBe('150021');
  });

  test('with no prefecture match, the better kind wins, then the lowest code', () => {
    const picked = pickWatershedCandidate(
      [
        { code: '380023', kind: 'other' },
        { code: '010877', kind: 'second' },
        { code: '020001', kind: 'second' },
      ],
      new Set(['47']),
    );
    expect(picked?.code).toBe('010877');
  });
});
