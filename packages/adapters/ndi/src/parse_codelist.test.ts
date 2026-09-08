import { describe, expect, test } from 'bun:test';
import { parseWaterSystemCodelist } from './parse_codelist.ts';

const HTML = `
<table>
<tr><th>コード</th><th>対応する内容</th></tr>
<tr>
<td>830303</td><td>利根川</td></tr>
<tr>
<td>020036</td><td>堤川</td></tr>
<tr><td>850509</td>
  <td>木曽川 &amp; 支川</td></tr>
<tr><td>not-a-code</td><td>ignored</td></tr>
</table>`;

describe('parseWaterSystemCodelist', () => {
  test('maps every 6-digit 水系域コード to its 水系名', () => {
    const m = parseWaterSystemCodelist(HTML);
    expect(m.get('830303')).toBe('利根川');
    expect(m.get('020036')).toBe('堤川');
    expect(m.size).toBe(3);
  });

  test('decodes HTML entities and trims whitespace in names', () => {
    const m = parseWaterSystemCodelist(HTML);
    expect(m.get('850509')).toBe('木曽川 & 支川');
  });

  test('throws when the document holds no codes at all', () => {
    expect(() => parseWaterSystemCodelist('<html><body>nothing</body></html>')).toThrow();
  });
});
