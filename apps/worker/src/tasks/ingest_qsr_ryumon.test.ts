import { describe, expect, test } from 'bun:test';
import { parseRyumonTimestamp } from './ingest_qsr_ryumon.ts';

describe('parseRyumonTimestamp', () => {
  test('parses JST timestamp to UTC', () => {
    const d = parseRyumonTimestamp('2026/06/05 19:50');
    expect(d?.toISOString()).toBe('2026-06-05T10:50:00.000Z');
    expect(d?.getUTCHours()).toBe(10);
    expect(d?.getUTCMinutes()).toBe(50);
  });

  test('parses midnight JST (UTC previous day)', () => {
    const d = parseRyumonTimestamp('2026/06/05 00:00');
    expect(d?.toISOString()).toBe('2026-06-04T15:00:00.000Z');
  });

  test('returns null for empty input', () => {
    expect(parseRyumonTimestamp('')).toBeNull();
  });

  test('returns null for malformed input', () => {
    expect(parseRyumonTimestamp('bad')).toBeNull();
    expect(parseRyumonTimestamp('2026/6/5 19:50')).toBeNull(); // missing zero-padding
  });
});
