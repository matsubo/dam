import { describe, expect, test } from 'bun:test';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { parseW07 } from './parse_w07.ts';

const FIXTURE = join(
  import.meta.dir,
  '..',
  '..',
  '..',
  '..',
  'tests/fixtures/ndi/w07_sample.geojson',
);

describe('parseW07', () => {
  test('keys each watershed by 水系域コード (W07_002) and names it by 水系名 (W07_004)', async () => {
    const out = parseW07(await readFile(FIXTURE, 'utf8'));
    expect(out[0]).toMatchObject({ code: '830303', ndiCode: '830303', name: '利根川' });
    expect(out[0]?.geometry.type).toBe('MultiPolygon');
    expect(out[1]).toMatchObject({ code: '020036', ndiCode: '020036', name: '堤川' });
  });

  test('derives kind from the code: 8x → first, prefecture code → other without W05', async () => {
    const out = parseW07(await readFile(FIXTURE, 'utf8'));
    expect(out[0]?.kind).toBe('first');
    expect(out[1]?.kind).toBe('other');
  });

  test('drops the "県コード+0000" placeholder features', async () => {
    const out = parseW07(await readFile(FIXTURE, 'utf8'));
    expect(out).toHaveLength(2);
    expect(out.some((w) => w.code === '020000')).toBe(false);
  });

  test('rejects malformed input', () => {
    expect(() => parseW07('{}')).toThrow();
  });
});
