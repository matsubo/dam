// Shared storage-rate colour scale. High % = safe (blue), low % = danger
// (red), matching the /map markers and the reservoir gauge so the whole site
// speaks one visual language. Discrete bands read faster than a continuous
// ramp when scanning a long list of watersheds.

export interface RateBand {
  /** Hex fill colour for bars / gauges. */
  color: string;
  /** Plain-language severity label for ordinary visitors. */
  label: string;
}

const NO_DATA: RateBand = { color: '#9ca3af', label: 'データなし' };

export function rateBand(rate: number | null | undefined): RateBand {
  if (rate == null || !Number.isFinite(rate)) return NO_DATA;
  const r = Math.max(0, Math.min(1, rate));
  if (r < 0.2) return { color: '#dc2626', label: '危機的' }; // critically low — red
  if (r < 0.4) return { color: '#f97316', label: '渇水警戒' }; // low — orange
  if (r < 0.6) return { color: '#eab308', label: 'やや低い' }; // mid — yellow
  if (r < 0.8) return { color: '#16a34a', label: '平常' }; // healthy — green
  return { color: '#1e6dff', label: '十分' }; // safe / full — blue
}
