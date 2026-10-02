import { HttpError } from './error.ts';

export type ObservationInterval = 'hourly' | 'daily' | 'monthly';

/**
 * Longest window each interval may ask for. The observations endpoints are
 * public (the charts call them without a key), and the hourly path gapfills
 * one bucket per hour per dam — an unbounded `from=1900&to=2100` would build
 * hundreds of millions of rows. The chart asks for 7 d hourly / 1 y daily /
 * 5 y monthly; the dam page's Dataset JSON-LD links a whole-history daily CSV.
 */
export const MAX_WINDOW_DAYS: Record<ObservationInterval, number> = {
  hourly: 93,
  daily: 50 * 366,
  monthly: 150 * 366,
};

const DAY_MS = 86_400_000;

export function parseObservationWindow(
  rawFrom: string,
  rawTo: string,
  interval: ObservationInterval,
): { from: Date; to: Date } {
  const from = new Date(rawFrom);
  const to = new Date(rawTo);
  if (Number.isNaN(from.valueOf()) || Number.isNaN(to.valueOf())) {
    throw new HttpError(400, 'Invalid from/to');
  }
  if (to < from) throw new HttpError(400, 'to must not be before from');
  if (to.valueOf() - from.valueOf() > MAX_WINDOW_DAYS[interval] * DAY_MS) {
    throw new HttpError(
      400,
      `Window too long: interval=${interval} allows at most ${MAX_WINDOW_DAYS[interval]} days`,
    );
  }
  return { from, to };
}
