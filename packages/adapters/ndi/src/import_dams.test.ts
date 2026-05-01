import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { sql } from '@dam/db/client';
import { importDams } from './import_dams.ts';
import { importWatersheds } from './import_watersheds.ts';
import { parseW01 } from './parse_w01.ts';
import { parseW07 } from './parse_w07.ts';

const W01 = join(import.meta.dir, '..', '..', '..', '..', 'tests/fixtures/ndi/w01_sample.geojson');
const W07 = join(import.meta.dir, '..', '..', '..', '..', 'tests/fixtures/ndi/w07_sample.geojson');

beforeAll(async () => {
  const raw07 = await readFile(W07, 'utf8');
  await importWatersheds(parseW07(raw07));
});

afterAll(async () => {
  await sql`DELETE FROM dams WHERE external_ids ? 'ndi'`;
  await sql`DELETE FROM watersheds WHERE code IN ('01','02')`;
});

describe('importDams', () => {
  test('inserts dams and links watershed by code', async () => {
    const raw = await readFile(W01, 'utf8');
    const parsed = parseW01(raw);
    const result = await importDams(parsed);
    expect(result.upserted).toBe(2);
    const rows = await sql<
      {
        slug: string;
        pref_code: string;
        watershed_id: bigint | null;
      }[]
    >`
      SELECT slug, pref_code, watershed_id FROM dams
      WHERE external_ids ->> 'ndi' IN ('1234567890','9999999999')
      ORDER BY slug
    `;
    expect(rows.length).toBe(2);
    expect(rows[0]?.watershed_id).not.toBeNull();
  });

  test('idempotent', async () => {
    const raw = await readFile(W01, 'utf8');
    const parsed = parseW01(raw);
    await importDams(parsed);
    const r2 = await importDams(parsed);
    expect(r2.upserted).toBe(2);
  });
});
