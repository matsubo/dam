import { describe, expect, test } from 'bun:test';
import type { LatestObservation } from '@dam/db/repo/dams';
import { damReadingState } from './dam-reading-state.ts';

const latest: LatestObservation = {
  observedAt: new Date('2026-10-27T06:00:00Z'),
  storageVolumeM3: '3000000',
  storageRate: null,
  inflowM3s: null,
  outflowM3s: null,
  waterLevelM: null,
  rainfallMm: null,
  qualityFlag: 0,
  sourceId: 'mudam',
  effectiveActiveCapacityM3: '2500000',
  storageRateOrigin: 'computed',
};
const twin = { slug: 'sakuma-re', name: '佐久間（再）' };

describe('damReadingState', () => {
  test('a reading carries its rate over the effective capacity, capped at 100 %', () => {
    const s = damReadingState(latest, 'covered', null);
    expect(s).toMatchObject({ kind: 'reading', rate: 1, capacityM3: 2_500_000 });
  });

  test('提供元なし hides even an old reading — every view, not just the chart', () => {
    expect(damReadingState(latest, 'not_published', null).kind).toBe('not_published');
  });

  test('without a reading the twin wins over 提供元なし', () => {
    expect(damReadingState(null, 'not_published', twin)).toEqual({ kind: 'twin', twin });
  });

  test('no reading, no twin and a provider that publishes it: nothing to show', () => {
    expect(damReadingState(null, 'published_not_ingested', null).kind).toBe('none');
  });
});
