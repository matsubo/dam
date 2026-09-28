import { describe, expect, test } from 'bun:test';
import type { StaleSource } from '@dam/db/repo/source_freshness';
import { buildDiscordPayload } from './quality_freshness.ts';

const stale = (n: number): StaleSource[] =>
  Array.from({ length: n }, (_, i) => ({
    sourceId: `source-${i}`,
    newestObservedAt: new Date('2026-09-27T00:00:00Z'),
    expectedIntervalHours: 1,
    ageHours: 10,
    thresholdHours: 3,
    cadenceBasis: 'cron' as const,
  }));

describe('buildDiscordPayload', () => {
  // Discord rejects an embed with more than 25 fields, which would drop the
  // whole digest.
  test('keeps an embed within 25 fields and says how many were left out', () => {
    const [embed] = buildDiscordPayload(stale(30)).embeds;
    expect(embed?.fields.length).toBe(25);
    expect(embed?.fields[23]?.name).toContain('source-23');
    expect(embed?.fields[24]?.name).toBe('…and 6 more');
    expect(embed?.title).toContain('30');
  });

  test('lists every source when all 25 fit', () => {
    const [embed] = buildDiscordPayload(stale(25)).embeds;
    expect(embed?.fields.map((f) => f.name.split(' ').at(-1))).toEqual(
      stale(25).map((s) => s.sourceId),
    );
  });
});
