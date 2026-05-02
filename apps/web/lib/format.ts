const NF = new Intl.NumberFormat('ja-JP');
const PF = new Intl.NumberFormat('ja-JP', { style: 'percent', maximumFractionDigits: 1 });
const DF = new Intl.DateTimeFormat('ja-JP', {
  dateStyle: 'short',
  timeStyle: 'short',
  timeZone: 'Asia/Tokyo',
});

export function fmtN(value: number | string | null | undefined): string {
  if (value == null || value === '') return '—';
  const n = typeof value === 'string' ? Number(value) : value;
  if (!Number.isFinite(n)) return '—';
  return NF.format(n);
}

export function fmtPct(value: number | string | null | undefined): string {
  if (value == null) return '—';
  const n = typeof value === 'string' ? Number(value) : value;
  if (!Number.isFinite(n)) return '—';
  return PF.format(n);
}

export function fmtDate(value: Date | string | null | undefined): string {
  if (!value) return '—';
  const d = value instanceof Date ? value : new Date(value);
  return DF.format(d);
}

/**
 * Render a volume (m³) using the conventional Japanese reservoir scales:
 *   - >= 1億 (1e8): "X.YY 億 m³"
 *   - >= 1万 (1e4): "X,XXX 万 m³"
 *   - smaller:      "X,XXX m³"
 * Negative inputs render as "—" — real source data occasionally has
 * placeholder negative values that should not display.
 */
export function fmtCapacityMcm(volumeM3: number | string | null | undefined): string {
  if (volumeM3 == null) return '—';
  const n = typeof volumeM3 === 'string' ? Number(volumeM3) : volumeM3;
  if (!Number.isFinite(n) || n < 0) return '—';
  if (n >= 100_000_000) return `${(n / 100_000_000).toFixed(2)} 億 m³`;
  if (n >= 10_000) return `${NF.format(Math.round(n / 10_000))} 万 m³`;
  return `${NF.format(Math.round(n))} m³`;
}
