export const QualityFlag = {
  Missing: 1,
  Outlier: 2,
  Interpolated: 4,
  Mismatch: 8,
  ManualReview: 16,
} as const;

export interface PhysicalCheck {
  storageRate?: number | null;
  storageVolumeM3?: number | null;
  inflowM3s?: number | null;
  outflowM3s?: number | null;
  rainfallMm?: number | null;
}

export function isPhysicallyValid(input: PhysicalCheck): boolean {
  if (input.storageRate != null && (input.storageRate < 0 || input.storageRate > 1.5)) return false;
  if (input.storageVolumeM3 != null && input.storageVolumeM3 < 0) return false;
  if (input.inflowM3s != null && input.inflowM3s < 0) return false;
  if (input.outflowM3s != null && input.outflowM3s < 0) return false;
  if (input.rainfallMm != null && input.rainfallMm < 0) return false;
  return true;
}

export interface OutlierInput {
  prev: number | null;
  current: number;
  thresholdRatio?: number;
}

export function detectOutlier({ prev, current, thresholdRatio = 0.3 }: OutlierInput): boolean {
  if (prev == null) return false;
  if (prev === 0) return Math.abs(current) > 0;
  return Math.abs(current - prev) / Math.abs(prev) > thresholdRatio;
}
