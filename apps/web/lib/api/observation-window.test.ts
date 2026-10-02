import { describe, expect, test } from 'bun:test';
import { HttpError } from './error.ts';
import { MAX_WINDOW_DAYS, parseObservationWindow } from './observation-window.ts';

const DAY_MS = 86_400_000;

function statusOf(fn: () => unknown): number | null {
  try {
    fn();
    return null;
  } catch (e) {
    return e instanceof HttpError ? e.status : -1;
  }
}

describe('parseObservationWindow', () => {
  test('accepts the spans the chart asks for (7 d hourly, 1 y daily, 5 y monthly)', () => {
    const to = new Date('2026-10-02T00:00:00Z');
    const back = (days: number) => new Date(to.valueOf() - days * DAY_MS).toISOString();
    for (const [interval, days] of [
      ['hourly', 7],
      ['daily', 366],
      ['monthly', 5 * 366],
    ] as const) {
      const w = parseObservationWindow(back(days), to.toISOString(), interval);
      expect(w.to.toISOString()).toBe(to.toISOString());
    }
  });

  test('rejects a span longer than the interval allows with 400', () => {
    const to = new Date('2026-10-02T00:00:00Z');
    for (const interval of ['hourly', 'daily', 'monthly'] as const) {
      const from = new Date(to.valueOf() - (MAX_WINDOW_DAYS[interval] + 1) * DAY_MS);
      expect(
        statusOf(() => parseObservationWindow(from.toISOString(), to.toISOString(), interval)),
      ).toBe(400);
    }
  });

  test('rejects the century-wide hourly request that would gapfill millions of buckets', () => {
    expect(statusOf(() => parseObservationWindow('1900-01-01', '2100-01-01', 'hourly'))).toBe(400);
  });

  test('rejects unparseable dates and a window that ends before it starts', () => {
    expect(statusOf(() => parseObservationWindow('nope', '2026-01-01', 'daily'))).toBe(400);
    expect(statusOf(() => parseObservationWindow('2026-02-01', '2026-01-01', 'daily'))).toBe(400);
  });
});
