import { describe, expect, test } from 'bun:test';
import { damDisplayName } from './dam-name.ts';

describe('damDisplayName', () => {
  test('appends ダム to a bare master name', () => {
    expect(damDisplayName('宮ヶ瀬')).toBe('宮ヶ瀬ダム');
    expect(damDisplayName('矢木沢')).toBe('矢木沢ダム');
  });

  test('does not double-append when the name already ends with ダム', () => {
    expect(damDisplayName('高山ダム')).toBe('高山ダム');
  });

  test('leaves 堰・水門・調整池・溜池・遊水地・湖 endings untouched', () => {
    expect(damDisplayName('利根川河口堰')).toBe('利根川河口堰');
    expect(damDisplayName('十六橋水門')).toBe('十六橋水門');
    expect(damDisplayName('南椎尾調整池')).toBe('南椎尾調整池');
    expect(damDisplayName('田の沢溜池')).toBe('田の沢溜池');
    expect(damDisplayName('渡良瀬遊水地')).toBe('渡良瀬遊水地');
    expect(damDisplayName('水の口池')).toBe('水の口池');
  });

  test('keeps parenthetical qualifiers after the suffix check', () => {
    // 中禅寺（元） — the base name has no suffix; ダム goes before nothing,
    // parenthetical stays: rendering as 中禅寺（元）ダム would be wrong, so
    // names ending with a closing paren keep their form with ダム inserted
    // before the paren.
    expect(damDisplayName('中禅寺（元）')).toBe('中禅寺ダム（元）');
    expect(damDisplayName('三川（再）')).toBe('三川ダム（再）');
  });

  test('name already containing ダム before paren is untouched', () => {
    expect(damDisplayName('高山ダム（再）')).toBe('高山ダム（再）');
  });
});
