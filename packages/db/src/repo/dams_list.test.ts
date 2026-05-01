import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { sql } from '../client.ts';
import { listDams, upsertDamByExternalId } from './dams.ts';

beforeAll(async () => {
  await sql`DELETE FROM dams WHERE external_ids ->> 'ndi' LIKE 'LIST-TEST-%'`;
  for (let i = 0; i < 5; i++) {
    await upsertDamByExternalId('ndi', {
      slug: `list-test-${i}`,
      name: `Test Dam ${i}`,
      prefCode: '13',
      lat: 35 + i * 0.01,
      lng: 139 + i * 0.01,
      externalIds: { ndi: `LIST-TEST-${i}` },
    });
  }
});

afterAll(async () => {
  await sql`DELETE FROM dams WHERE external_ids ->> 'ndi' LIKE 'LIST-TEST-%'`;
});

describe('listDams', () => {
  test('paginates by cursor', async () => {
    const p1 = await listDams({ pref: '13', pageSize: 3, search: 'Test Dam' });
    expect(p1.items.length).toBe(3);
    expect(p1.nextCursor).not.toBeNull();
    const p2 = await listDams({
      pref: '13',
      pageSize: 3,
      search: 'Test Dam',
      cursor: p1.nextCursor,
    });
    expect(p2.items.length).toBe(2);
    expect(p2.nextCursor).toBeNull();
  });

  test('returns lat/lng', async () => {
    const r = await listDams({ pref: '13', pageSize: 1, search: 'Test Dam 0' });
    expect(r.items[0]?.lat).toBeCloseTo(35, 5);
    expect(r.items[0]?.lng).toBeCloseTo(139, 5);
  });
});
