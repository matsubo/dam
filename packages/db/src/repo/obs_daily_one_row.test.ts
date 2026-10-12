import { describe, expect, test } from 'bun:test';
import { withTestDb } from '../../../../tests/integration/helpers.ts';

// #115: a refresh over compressed chunks with overlapping batches stored one
// (dam_id, day) as two partial rows. Migration 0222 makes the
// materialization hypertable reject a second row for a group.
describe('obs_daily one row per (dam_id, day)', () => {
  test('the materialization hypertable rejects a second row for a group', async () => {
    await withTestDb(async (sql) => {
      const [mat] = await sql<{ name: string }[]>`
        SELECT format('%I.%I', materialization_hypertable_schema, materialization_hypertable_name) AS name
        FROM timescaledb_information.continuous_aggregates
        WHERE view_schema = 'public' AND view_name = 'obs_daily'
      `;
      expect(mat).toBeDefined();
      const insert = `INSERT INTO ${mat?.name} (dam_id, day, n_storage_volume, n_rainfall)
                      VALUES (-115, '1990-01-01T00:00:00Z', 1, 0)`;
      await sql.unsafe(insert);
      // Last statement: the error aborts the transaction withTestDb rolls back.
      await expect(sql.unsafe(insert)).rejects.toThrow(/obs_daily_dam_id_day_key/);
    });
  });
});
