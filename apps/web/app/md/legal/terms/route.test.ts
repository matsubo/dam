import { describe, expect, test } from 'bun:test';
import { GET } from './route.ts';

// 国土数値情報 W01 / W05 / W07 carry the 非商用 licence (旧国土情報利用約款),
// so the terms must not grant commercial use or claim a more permissive licence.
describe('GET /md/legal/terms', () => {
  test('limits use to non-commercial purposes', async () => {
    const body = await GET().text();
    expect(body).toContain('non-commercial');
    expect(body).not.toContain('commercial use is permitted');
  });

  test('names the NDI datasets actually used and their licence', async () => {
    const body = await GET().text();
    expect(body).toContain('W01/W05/W07');
    expect(body).toContain('旧国土情報利用約款');
    expect(body).not.toContain('A21');
    expect(body).not.toContain('政府標準利用規約');
  });
});
