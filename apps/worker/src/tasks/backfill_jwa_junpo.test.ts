// apps/worker/src/tasks/backfill_jwa_junpo.test.ts
//
// Pure-function test for the date enumerator. The fetch-and-upsert path
// is covered by the live ingest test + a manual end-to-end run during
// development.

import { describe, expect, test } from 'bun:test';
import { enumerateBackfillDates } from './backfill_jwa_junpo.ts';

describe('enumerateBackfillDates', () => {
  test('yields 1/11/21 of each preceding month for the requested window', () => {
    const today = new Date(Date.UTC(2026, 4, 10)); // 2026-05-10 UTC
    const dates = enumerateBackfillDates(2, today);
    const iso = dates.map((d) => d.toISOString().slice(0, 10));
    // months=2 → previous two full months: April + March
    expect(iso).toEqual([
      '2026-04-01',
      '2026-04-11',
      '2026-04-21',
      '2026-03-01',
      '2026-03-11',
      '2026-03-21',
    ]);
  });

  test('walks across year boundaries without skipping', () => {
    const today = new Date(Date.UTC(2026, 1, 15)); // mid-Feb 2026
    const dates = enumerateBackfillDates(3, today);
    const iso = dates.map((d) => d.toISOString().slice(0, 10));
    expect(iso).toEqual([
      // January 2026
      '2026-01-01',
      '2026-01-11',
      '2026-01-21',
      // December 2025
      '2025-12-01',
      '2025-12-11',
      '2025-12-21',
      // November 2025
      '2025-11-01',
      '2025-11-11',
      '2025-11-21',
    ]);
  });

  test('respects months=1', () => {
    const today = new Date(Date.UTC(2026, 4, 10));
    expect(enumerateBackfillDates(1, today).length).toBe(3);
  });
});
