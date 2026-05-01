import { describe, expect, test } from 'bun:test';
import { withTestDb } from '../../../../tests/integration/helpers.ts';

describe('schema smoke', () => {
  test('master tables exist', async () => {
    await withTestDb(async (sql) => {
      const rows = await sql<{ table_name: string }[]>`
        SELECT table_name FROM information_schema.tables
        WHERE table_schema = 'public'
          AND table_name IN ('dams','watersheds','rivers','match_review')
      `;
      expect(rows.length).toBe(4);
    });
  });
});
