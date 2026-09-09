// apps/worker/src/tasks/quality_freshness.test.ts
//
// computeAlerts only speaks about sources listed in FRESHNESS_HOURS; anything
// else is silent by design. These cover the low-cadence entries, where the
// window has to tolerate the source's own publication rhythm.

import { describe, expect, test } from 'bun:test';
import { computeAlerts } from './quality_freshness.ts';

const NOW = new Date('2026-09-10T00:00:00.000Z');

function row(sourceId: string, daysOld: number | null) {
  return {
    source_id: sourceId,
    description: null,
    latest_observed_at: daysOld == null ? null : new Date(NOW.getTime() - daysOld * 86_400_000),
    distinct_dams_30d: 10n,
  };
}

describe('computeAlerts — fukushima-nourin (survey-date source)', () => {
  test('stays quiet across a winter gap (monthly surveys, Oct–Mar)', () => {
    const alerts = computeAlerts([row('fukushima-nourin', 33)], NOW);
    expect(alerts).toEqual([]);
  });

  test('alerts once the gap exceeds any plausible survey interval', () => {
    const alerts = computeAlerts([row('fukushima-nourin', 60)], NOW);
    expect(alerts.map((a) => a.sourceId)).toEqual(['fukushima-nourin']);
  });

  test('alerts when the source has never produced an observation', () => {
    const alerts = computeAlerts([row('fukushima-nourin', null)], NOW);
    expect(alerts.length).toBe(1);
    expect(alerts[0]?.latest).toBeNull();
  });
});

describe('computeAlerts — unlisted sources', () => {
  test('says nothing about a source with no configured window', () => {
    expect(computeAlerts([row('some-future-source', 400)], NOW)).toEqual([]);
  });
});
