import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { sql } from '../client.ts';
import { listDamsPaged, upsertDamByExternalId } from './dams.ts';

const PREFIX = 'PAGED-TEST-';

beforeAll(async () => {
  await sql`DELETE FROM dams WHERE external_ids ->> 'ndi' LIKE ${`${PREFIX}%`}`;
  for (let i = 0; i < 7; i++) {
    await upsertDamByExternalId('ndi', {
      slug: `paged-test-${i}`,
      name: `Paged Test ${i}`,
      prefCode: '13',
      lat: 35 + i * 0.001,
      lng: 139 + i * 0.001,
      externalIds: { ndi: `${PREFIX}${i}` },
    });
  }
});

afterAll(async () => {
  await sql`DELETE FROM dams WHERE external_ids ->> 'ndi' LIKE ${`${PREFIX}%`}`;
});

describe('listDamsPaged', () => {
  test('returns first page with totalPages calculated against pageSize', async () => {
    const r = await listDamsPaged({ pref: '13', search: 'Paged Test', pageSize: 3, page: 1 });
    expect(r.items.length).toBe(3);
    expect(r.total).toBeGreaterThanOrEqual(7);
    expect(r.totalPages).toBeGreaterThanOrEqual(3);
    expect(r.page).toBe(1);
    expect(r.pageSize).toBe(3);
  });

  test('out-of-range page clamps to last page', async () => {
    const r = await listDamsPaged({
      pref: '13',
      search: 'Paged Test',
      pageSize: 3,
      page: 9999,
    });
    expect(r.page).toBe(r.totalPages);
    // Last page should still have at least one row of our seed
    expect(r.items.length).toBeGreaterThanOrEqual(1);
  });

  test('page < 1 is clamped to 1', async () => {
    const r = await listDamsPaged({ pref: '13', search: 'Paged Test', pageSize: 3, page: 0 });
    expect(r.page).toBe(1);
  });

  test('empty filter values do not match zero rows (regression)', async () => {
    // Empty-string filters are produced by the form when a select is left
    // unchosen. The page route coerces them to null; the repo expects null
    // to mean "no filter". Verify that contract.
    const r = await listDamsPaged({
      pref: '13',
      watershedSlug: null,
      manager: null,
      search: 'Paged Test',
      pageSize: 50,
      page: 1,
    });
    expect(r.total).toBeGreaterThanOrEqual(7);
  });
});
