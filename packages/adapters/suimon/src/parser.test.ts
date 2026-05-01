import { describe, expect, test } from 'bun:test';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { parseSuimonCsv } from './parser.ts';

const FIXTURE = join(
  import.meta.dir,
  '..',
  '..',
  '..',
  '..',
  'tests/fixtures/suimon/reading_yamba_2020.csv',
);

describe('parseSuimonCsv', () => {
  test('extracts hourly rows', async () => {
    const csv = await readFile(FIXTURE, 'utf8');
    const out = parseSuimonCsv(csv);
    expect(out.length).toBe(2);
    expect(out[0]).toMatchObject({
      storageVolumeM3: 90_000_000,
      storageRate: 0.5,
      inflowM3s: 5,
      outflowM3s: 4.5,
      waterLevelM: 580,
      rainfallMm: 0,
    });
    expect(out[0]?.observedAt.toISOString()).toBe('2019-12-31T15:00:00.000Z');
  });
});
