import { describe, expect, test } from 'bun:test';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { collectW05SectionTypes } from './parse_w05.ts';

const FIXTURE = join(
  import.meta.dir,
  '..',
  '..',
  '..',
  '..',
  'tests/fixtures/ndi/w05_stream_sample.dbf',
);

describe('collectW05SectionTypes', () => {
  test('unions 区間種別 (W05_003) per 水系域コード (W05_001)', async () => {
    const buf = new Uint8Array(await readFile(FIXTURE));
    const byCode = collectW05SectionTypes([buf]);
    expect([...byCode.keys()].sort()).toEqual(['130001', '140019', '830305']);
    expect([...(byCode.get('830305') ?? [])].sort()).toEqual(['1', '2']);
    expect([...(byCode.get('140019') ?? [])].sort()).toEqual(['3', '4']);
    expect([...(byCode.get('130001') ?? [])].sort()).toEqual(['0']);
  });

  test('merges the same code across several prefecture files', async () => {
    const buf = new Uint8Array(await readFile(FIXTURE));
    const once = collectW05SectionTypes([buf]);
    const twice = collectW05SectionTypes([buf, buf]);
    expect(twice.size).toBe(once.size);
    expect([...(twice.get('830305') ?? [])].sort()).toEqual(['1', '2']);
  });

  test('returns an empty map for no input', () => {
    expect(collectW05SectionTypes([]).size).toBe(0);
  });
});
