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
  await sql`DELETE FROM watersheds WHERE code IN ('830303','020036')`;
});

describe('importWatersheds', () => {
  test('upserts parsed watersheds and assigns slugs', async () => {
    const raw = await readFile(FIXTURE, 'utf8');
    const parsed = parseW07(raw);
    const result = await importWatersheds(parsed);
    expect(result.upserted).toBe(2);
    const rows = await sql<{ code: string; slug: string }[]>`
      SELECT code, slug FROM watersheds WHERE code IN ('830303','020036') ORDER BY code
    `;
    expect(rows.map((r) => r.code)).toEqual(['020036', '830303']);
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

  test('slug is stable across re-imports', async () => {
    const raw = await readFile(FIXTURE, 'utf8');
    const parsed = parseW07(raw);
    await importWatersheds(parsed);
    const before = await sql<{ slug: string }[]>`SELECT slug FROM watersheds WHERE code = '830303'`;
    await importWatersheds(parsed);
    const after = await sql<{ slug: string }[]>`SELECT slug FROM watersheds WHERE code = '830303'`;
    expect(after[0]?.slug).toBe(before[0]?.slug);
  });

  test('stores the 水系域コード in ndi_code and the code-derived kind', async () => {
    const raw = await readFile(FIXTURE, 'utf8');
    await importWatersheds(parseW07(raw));
    const rows = await sql<{ code: string; ndi_code: string | null; kind: string }[]>`
      SELECT code, ndi_code, kind FROM watersheds WHERE code IN ('830303','020036') ORDER BY code
    `;
    expect([...rows]).toEqual([
      { code: '020036', ndi_code: '020036', kind: 'other' },
      { code: '830303', ndi_code: '830303', kind: 'first' },
    ]);
  });
});
