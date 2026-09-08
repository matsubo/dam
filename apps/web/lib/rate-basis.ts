// Which 利水容量 the displayed 貯水率 is actually divided by.
//
// For sources in source_priorities.trusted_rate_basis the denominator is
// back-solved from the source's own season-aware rate (volume / rate) and
// can be far smaller than the static Damnet 利水容量 in 洪水期 — issue #19:
// 美利河ダム reads 92% against a 2,159 千m³ flood-season pool while the
// master lists 14,500 千m³. Surfacing the effective denominator keeps the
// page's 貯水量 / 利水容量 / 貯水率 trio from looking self-contradictory.

export interface RateDenominator {
  /** The capacity the shown 貯水率 is divided by, in m³. */
  capacityM3: number;
  /** True when that differs from the master's static 利水容量 by more than
   *  DEVIATION_TOLERANCE, or when the master has no 利水容量 at all. */
  differsFromStatic: boolean;
}

// A back-solved denominator carries the rounding of a one-decimal percentage
// (13.5% → ±0.4% relative), so treat small gaps as "the same value".
const DEVIATION_TOLERANCE = 0.02;

// Upstream feeds cap 利水容量貯水率 at exactly 100%. volume / 1.0 is then the
// volume itself, not the capacity (薗原ダム: 3,933 千m³ shown where the real
// flood-season pool is ~3,000), so a denominator equal to the volume is a
// degenerate back-solve, not a figure to display. A genuine >100% rate
// yields a denominator strictly below the volume and is kept.
const CAPPED_RATE_EPSILON = 1e-4;

export function rateDenominator(
  effectiveCapacityM3: number | null | undefined,
  staticActiveCapacityM3: number | null | undefined,
  storageVolumeM3: number | null | undefined,
): RateDenominator | null {
  if (effectiveCapacityM3 == null) return null;
  if (!Number.isFinite(effectiveCapacityM3) || effectiveCapacityM3 <= 0) return null;
  if (storageVolumeM3 == null || !Number.isFinite(storageVolumeM3)) return null;
  if (Math.abs(storageVolumeM3 - effectiveCapacityM3) / effectiveCapacityM3 < CAPPED_RATE_EPSILON)
    return null;
  const hasStatic =
    staticActiveCapacityM3 != null &&
    Number.isFinite(staticActiveCapacityM3) &&
    staticActiveCapacityM3 > 0;
  if (!hasStatic) return { capacityM3: effectiveCapacityM3, differsFromStatic: true };
  const deviation = Math.abs(effectiveCapacityM3 - staticActiveCapacityM3) / staticActiveCapacityM3;
  return { capacityM3: effectiveCapacityM3, differsFromStatic: deviation > DEVIATION_TOLERANCE };
}
