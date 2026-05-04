import type { StorageChange } from '@dam/db/repo/dams';

interface Props {
  change: StorageChange;
}

interface Cell {
  label: string;
  prev: string | null;
  ageS: number | null;
}

function pctChange(current: string | null, prev: string | null): number | null {
  if (!current || !prev) return null;
  const c = Number(current);
  const p = Number(prev);
  if (!Number.isFinite(c) || !Number.isFinite(p) || p === 0) return null;
  return ((c - p) / p) * 100;
}

function formatPct(p: number): string {
  // TradingView-style: signed, 2 decimals; small values still readable.
  const sign = p > 0 ? '+' : '';
  return `${sign}${p.toFixed(2)} %`;
}

/**
 * The reference point Postgres returns is "the most recent observation at or
 * before NOW − window". For frequent ingest cadences the picked timestamp
 * sits *exactly* at the window boundary; for sparser data it can be older.
 * We flag the cell as stale (dashed border) when the chosen reference is
 * more than 1.4× the target window old, so users know the % is approximate.
 */
function freshness(ageS: number | null, expectedSeconds: number): 'ok' | 'stale' {
  if (ageS == null) return 'stale';
  return ageS <= expectedSeconds * 1.4 ? 'ok' : 'stale';
}

export function StorageChangeStrip({ change }: Props) {
  const cells: { cell: Cell; expectedS: number }[] = [
    { cell: { label: '1h', prev: change.h1, ageS: change.h1AgeS }, expectedS: 3600 },
    { cell: { label: '6h', prev: change.h6, ageS: change.h6AgeS }, expectedS: 6 * 3600 },
    { cell: { label: '12h', prev: change.h12, ageS: change.h12AgeS }, expectedS: 12 * 3600 },
    { cell: { label: '1d', prev: change.d1, ageS: change.d1AgeS }, expectedS: 86400 },
    { cell: { label: '7d', prev: change.d7, ageS: change.d7AgeS }, expectedS: 7 * 86400 },
    { cell: { label: '30d', prev: change.d30, ageS: change.d30AgeS }, expectedS: 30 * 86400 },
    { cell: { label: '1y', prev: change.d365, ageS: change.d365AgeS }, expectedS: 365 * 86400 },
    { cell: { label: '5y', prev: change.d1825, ageS: change.d1825AgeS }, expectedS: 1825 * 86400 },
  ];
  // 8 cells. Responsive ladder: phone 4×2, tablet 4×2 (same), desktop 8×1.
  // 4 always divides 8 cleanly so no orphan row at any breakpoint.
  return (
    <div className="grid grid-cols-4 lg:grid-cols-8 gap-2">
      {cells.map(({ cell, expectedS }) => {
        const p = pctChange(change.current, cell.prev);
        const isStale = freshness(cell.ageS, expectedS) === 'stale';
        const tone =
          p == null
            ? 'text-on-surface-variant'
            : p > 0
              ? 'text-emerald-700'
              : p < 0
                ? 'text-red-700'
                : 'text-on-surface-variant';
        const arrow = p == null ? '' : p > 0 ? '▲' : p < 0 ? '▼' : '–';
        const titleParts = [];
        if (cell.ageS != null) {
          const ageS = cell.ageS;
          const ago =
            ageS < 7200
              ? `${Math.round(ageS / 60)} 分前`
              : ageS < 2 * 86400
                ? `${(ageS / 3600).toFixed(1)} 時間前`
                : `${(ageS / 86400).toFixed(1)} 日前`;
          titleParts.push(`基準点: ${ago}の観測`);
        }
        if (isStale) titleParts.push('参照点が想定窓より古いため参考値');
        return (
          <div
            key={cell.label}
            className={`border rounded-lg p-2 text-center bg-white ${
              isStale ? 'border-dashed border-outline-variant/60' : 'border-outline-variant'
            }`}
            title={titleParts.join(' / ') || undefined}
          >
            <div className="text-[10px] text-on-surface-variant uppercase tracking-wide">
              {cell.label}
            </div>
            <div className={`text-sm font-semibold tabular-nums ${tone}`}>
              {p == null ? '—' : `${arrow} ${formatPct(p)}`}
            </div>
          </div>
        );
      })}
    </div>
  );
}
