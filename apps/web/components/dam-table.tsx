import { PREFECTURES } from '@dam/core/prefectures';
import Link from 'next/link';
import { fmtCapacityMcm, fmtPct } from '../lib/format.ts';
import { EntityIcon } from './entity-icon.tsx';

const PREF_NAME = new Map(PREFECTURES.map((p) => [p.code, p.name]));

export interface DamRowItem {
  id?: bigint;
  slug: string;
  name: string;
  prefCode: string;
  manager: string | null;
  totalCapacityM3: string | null;
  watershedSlug: string | null;
  watershedName: string | null;
  imageUrl?: string | null;
}

/** Per-dam latest rate snapshot. Pass via {@link DamTable} `rates` prop to
 * surface a 貯水率 progress-bar column. Keys are dam ids stringified for
 * stable lookup (bigint → string). */
export interface DamRateMeta {
  /** rate ∈ [0, 1], or null when 利水容量 / 観測値 not available. */
  rate: number | null;
}

export function DamTable({
  rows,
  rates,
}: {
  rows: DamRowItem[];
  /** Optional map keyed by `dam.id.toString()`. When provided, the table
   * renders a 貯水率 column with progress bar between 管理者 and 総貯水容量. */
  rates?: Map<string, DamRateMeta>;
}) {
  const showRate = !!rates;
  return (
    <table>
      <thead>
        <tr>
          <th>ダム名</th>
          <th>都道府県</th>
          <th>水系</th>
          <th>管理者</th>
          {showRate ? <th className="text-right">貯水率</th> : null}
          <th className="text-right">総貯水容量</th>
        </tr>
      </thead>
      <tbody>
        {rows.map((r) => {
          const rateMeta = rates && r.id != null ? rates.get(r.id.toString()) : undefined;
          return (
            <tr key={r.slug}>
              <td>
                <span className="inline-flex items-center gap-1.5">
                  <EntityIcon kind="dam" size={14} className="text-primary shrink-0" />
                  <Link href={`/dams/${r.slug}`}>{r.name}</Link>
                </span>
              </td>
              <td>{PREF_NAME.get(r.prefCode) ?? r.prefCode}</td>
              <td>
                {r.watershedSlug ? (
                  <span className="inline-flex items-center gap-1.5">
                    <EntityIcon kind="watershed" size={14} className="shrink-0" />
                    <Link href={`/watersheds/${r.watershedSlug}`}>{r.watershedName}</Link>
                  </span>
                ) : (
                  '—'
                )}
              </td>
              <td>{r.manager ?? '—'}</td>
              {showRate ? (
                <td className="text-right tabular-nums">
                  {rateMeta && rateMeta.rate != null ? (
                    <div className="inline-flex items-center gap-2 min-w-[140px]">
                      <div
                        className="relative h-1.5 rounded-full bg-surface-container overflow-hidden flex-1"
                        aria-label={`貯水率 ${(rateMeta.rate * 100).toFixed(1)}%`}
                      >
                        <div
                          className="absolute inset-y-0 left-0 bg-primary"
                          style={{ width: `${rateMeta.rate * 100}%` }}
                        />
                      </div>
                      <span className="text-xs font-semibold w-12 text-right">
                        {fmtPct(rateMeta.rate)}
                      </span>
                    </div>
                  ) : (
                    <span className="text-xs text-on-surface-variant">—</span>
                  )}
                </td>
              ) : null}
              <td className="text-right tabular-nums">{fmtCapacityMcm(r.totalCapacityM3)}</td>
            </tr>
          );
        })}
      </tbody>
    </table>
  );
}
