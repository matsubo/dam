import { afterAll, describe, expect, test } from 'bun:test';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { sql } from '@dam/db/client';
import { importWatersheds } from './import_watersheds.ts';
import { parseW07 } from './parse_w07.ts';

const FIXTURE = join(
  import.meta.dir,
  '..',
  '..',
  '..',
  '..',
  'tests/fixtures/ndi/w07_sample.geojson',
);

afterAll(async () => {
  await sql`DELETE FROM watersheds WHERE code IN ('01','02')`;
});

describe('importWatersheds', () => {
  test('upserts parsed watersheds and assigns slugs', async () => {
    const raw = await readFile(FIXTURE, 'utf8');
    const parsed = parseW07(raw);
    const result = await importWatersheds(parsed);
    expect(result.upserted).toBe(2);
    const rows = await sql<{ code: string; slug: string }[]>`
      SELECT code, slug FROM watersheds WHERE code IN ('01','02') ORDER BY code
    `;
    expect(rows.map((r) => r.code)).toEqual(['01', '02']);
    expect(rows[0]?.slug).not.toBe('');
  });

  test('idempotent re-import', async () => {
    const raw = await readFile(FIXTURE, 'utf8');
    const parsed = parseW07(raw);
    const r1 = await importWatersheds(parsed);
    const r2 = await importWatersheds(parsed);
    expect(r1.upserted).toBe(2);
    expect(r2.upserted).toBe(2);
  });
});
