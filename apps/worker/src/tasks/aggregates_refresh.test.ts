import { describe, expect, test } from 'bun:test';
import { refreshContinuousAggregates } from './aggregates_refresh.ts';

describe('refreshContinuousAggregates', () => {
  test('materializes obs_daily/obs_monthly without throwing', async () => {
    // Smoke against the local DB: the CALLs must run outside a transaction
    // and complete. Correctness of the materialized content is covered by
    // packages/db seasonal.test.ts.
    await refreshContinuousAggregates();
    expect(true).toBe(true);
  });
});
