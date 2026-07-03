// 簡易渇水見通し: linear extrapolation of the observed storage decline.
// Not a forecast model — it answers "if the last N days' pace simply
// continued, how long until empty?" and must always be labelled as such.

export interface DepletionInput {
  /** Latest storage volume (m³). */
  currentM3: number | null;
  /** Storage volume `days` ago (m³). */
  pastM3: number | null;
  /** Length of the observation window in days. */
  days: number;
}

/**
 * Days until storage reaches zero at the observed pace, rounded to whole
 * days. Null when storage is flat/rising or inputs are missing.
 */
export function estimateDepletionDays({ currentM3, pastM3, days }: DepletionInput): number | null {
  if (currentM3 == null || pastM3 == null || days <= 0) return null;
  const declinePerDay = (pastM3 - currentM3) / days;
  if (declinePerDay <= 0) return null;
  return Math.round(currentM3 / declinePerDay);
}
