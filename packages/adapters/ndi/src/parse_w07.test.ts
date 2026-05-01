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
  test('extracts code, name, kind, geometry', async () => {
    const raw = await readFile(FIXTURE, 'utf8');
    const out = parseW07(raw);
    expect(out.length).toBe(2);
    expect(out[0]).toMatchObject({ code: '01', name: '利根川水系', kind: 'first' });
    expect(out[0]?.geometry.type).toBe('MultiPolygon');
    expect(out[1]).toMatchObject({ code: '02', name: '荒川水系', kind: 'second' });
  });

  test('rejects malformed input', () => {
    expect(() => parseW07('{}')).toThrow();
  });
});
