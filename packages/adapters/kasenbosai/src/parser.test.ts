// packages/adapters/kasenbosai/src/parser.test.ts
import { describe, expect, test } from 'bun:test';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { parseKasenbosaiReading } from './parser.ts';

const FIXTURE = join(
  import.meta.dir,
  '..',
  '..',
  '..',
  '..',
  'tests/fixtures/kasenbosai/reading_yamba.xml',
);

describe('parseKasenbosaiReading', () => {
  test('extracts a single hourly reading', async () => {
    const xml = await readFile(FIXTURE, 'utf8');
    const out = parseKasenbosaiReading(xml);
    expect(out.length).toBe(1);
    expect(out[0]).toMatchObject({
      damId: 'KB-1234',
      storageVolumeM3: 107500000,
      storageRate: 0.604,
      inflowM3s: 12.3,
      outflowM3s: 9.5,
      waterLevelM: 586.2,
      rainfallMm: 0,
    });
    expect(out[0]?.observedAt.toISOString()).toBe('2026-04-30T01:00:00.000Z');
  });
});
