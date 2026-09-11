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
  /** 有効貯水容量 — the static 貯水率 denominator. Null when ダム便覧 lists none. */
  activeCapacityM3: string | null;
  watershedSlug: string | null;
  watershedName: string | null;
  imageUrl?: string | null;
}

/** Per-dam latest rate snapshot. Pass via {@link DamTable} `rates` prop to
 * surface a 貯水率 progress-bar column. Keys are dam ids stringified for
 * stable lookup (bigint → string). */
export interface DamRateMeta {
  /** rate ∈ [0, 1], or null when 有効貯水容量 / 観測値 not available. */
  rate: number | null;
  /** When set, the dam has a non-synthetic observation in the last 30 days.
   *  Used to render a "実測" dot next to the rate bar. */
  realSourceId?: string | null;
}

function RateBar({ rate, realSourceId }: { rate: number | null; realSourceId?: string | null }) {
  const dot = realSourceId ? (
    <span
      aria-label={`実測データ（${realSourceId}）`}
      title={`実測データ（${realSourceId}）`}
      className="inline-block w-2 h-2 rounded-full bg-emerald-600 shrink-0"
    />
  ) : null;
  if (rate == null) {
    return (
      <span className="inline-flex items-center gap-1.5 text-xs text-on-surface-variant">
        {dot}—
      </span>
    );
  }
  return (
    <div className="inline-flex items-center gap-2 w-full md:min-w-[140px]">
      {dot}
      <div
        className="relative h-1.5 rounded-full bg-surface-container overflow-hidden flex-1"
        aria-label={`貯水率 ${(rate * 100).toFixed(1)}%`}
      >
        <div className="absolute inset-y-0 left-0 bg-primary" style={{ width: `${rate * 100}%` }} />
      </div>
      <span className="text-xs font-semibold w-12 text-right tabular-nums">{fmtPct(rate)}</span>
    </div>
  );
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
    <>
      {/* Mobile: stacked cards. The narrow table format gets unreadable
          below ~640 px because Japanese name + watershed + manager don't
          fit on one line. */}
      <ul className="md:hidden space-y-2">
        {rows.map((r) => {
          const rateMeta = rates && r.id != null ? rates.get(r.id.toString()) : undefined;
          return (
            <li key={r.slug} className="bg-white border border-outline-variant rounded-xl p-3">
              <Link
                href={`/dams/${r.slug}`}
                className="font-display font-semibold inline-flex items-center gap-1.5 text-on-surface no-underline hover:text-primary"
              >
                <EntityIcon kind="dam" size={14} className="text-primary shrink-0" />
                {r.name}
              </Link>
              <div className="text-xs text-on-surface-variant mt-1 flex flex-wrap items-center gap-x-2 gap-y-0.5">
                <span>{PREF_NAME.get(r.prefCode) ?? r.prefCode}</span>
                {r.watershedSlug ? (
                  <>
                    <span aria-hidden="true">·</span>
                    <span className="inline-flex items-center gap-1">
                      <EntityIcon kind="watershed" size={11} className="shrink-0" />
                      <Link href={`/watersheds/${r.watershedSlug}`}>{r.watershedName}</Link>
                    </span>
                  </>
                ) : null}
                {r.manager ? (
                  <>
                    <span aria-hidden="true">·</span>
                    <span>{r.manager}</span>
                  </>
                ) : null}
              </div>
              {showRate ? (
                <div className="mt-2">
                  <RateBar
                    rate={rateMeta?.rate ?? null}
                    realSourceId={rateMeta?.realSourceId ?? null}
                  />
                </div>
              ) : null}
              <div className="mt-2 text-xs text-on-surface-variant flex justify-between">
                <span>総貯水容量</span>
                <span className="text-on-surface tabular-nums">
                  {fmtCapacityMcm(r.totalCapacityM3)}
                </span>
              </div>
              <div className="mt-1 text-xs text-on-surface-variant flex justify-between">
                <span>有効貯水容量</span>
                <span className="text-on-surface tabular-nums">
                  {fmtCapacityMcm(r.activeCapacityM3)}
                </span>
              </div>
            </li>
          );
        })}
      </ul>

      {/* Desktop: classic table. */}
      <div className="hidden md:block overflow-x-auto">
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
                      <RateBar
                        rate={rateMeta?.rate ?? null}
                        realSourceId={rateMeta?.realSourceId ?? null}
                      />
                    </td>
                  ) : null}
                  <td className="text-right tabular-nums">{fmtCapacityMcm(r.totalCapacityM3)}</td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </>
  );
}
