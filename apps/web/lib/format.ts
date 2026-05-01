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

export function fmtCapacityMcm(volumeM3: number | string | null | undefined): string {
  if (volumeM3 == null) return '—';
  const n = typeof volumeM3 === 'string' ? Number(volumeM3) : volumeM3;
  if (!Number.isFinite(n)) return '—';
  return `${NF.format(Math.round(n / 1_000_000))} 万 m³`;
}
