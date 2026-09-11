import Link from 'next/link';
import { fmtCapacityMcm, fmtPct } from '../lib/format.ts';
import type { DamRowItem } from './dam-table.tsx';
import { EntityIcon } from './entity-icon.tsx';
import { Sparkline } from './sparkline.tsx';

// Featured-dam card with optional inline sparkline + 貯水率 progress bar.
// All extras are opt-in; when only `d` is passed the card stays compact.
export function DamCard({
  d,
  sparkline,
  rate,
}: {
  d: DamRowItem;
  sparkline?: number[];
  /** 貯水率 ∈ [0, 1]. Pass null for "data not available", undefined to hide. */
  rate?: number | null;
}) {
  return (
    <article className="card-surface flex gap-4 items-stretch">
      <div className="min-w-0 flex-1 flex flex-col">
        <h3 className="font-display font-semibold leading-tight text-base mb-1 truncate inline-flex items-center gap-1.5">
          <EntityIcon kind="dam" size={16} className="text-primary shrink-0" />
          <Link
            href={`/dams/${d.slug}`}
            className="text-on-surface no-underline hover:text-primary truncate"
          >
            {d.name}
          </Link>
        </h3>
        <p className="text-xs text-on-surface-variant truncate inline-flex items-center gap-1">
          {d.watershedName ? (
            <>
              <EntityIcon kind="watershed" size={12} className="shrink-0" />
              <span className="truncate">{d.watershedName}</span>
            </>
          ) : (
            <span>—</span>
          )}
          {d.manager ? <span className="ml-1">· {d.manager}</span> : null}
        </p>
        <div className="mt-2 mb-1 text-xl font-display font-bold tabular-nums">
          {fmtCapacityMcm(d.totalCapacityM3)}
        </div>
        <p className="text-xs text-on-surface-variant">総貯水容量</p>
        <p className="text-xs text-on-surface-variant tabular-nums">
          有効貯水容量 {fmtCapacityMcm(d.activeCapacityM3)}
        </p>
        {rate !== undefined ? (
          rate != null ? (
            <div className="mt-2" aria-label={`貯水率 ${(rate * 100).toFixed(1)}%`}>
              <div className="relative h-1.5 rounded-full bg-surface-container overflow-hidden">
                <div
                  className="absolute inset-y-0 left-0 bg-primary"
                  style={{ width: `${rate * 100}%` }}
                />
              </div>
              <div className="flex justify-between text-[11px] text-on-surface-variant tabular-nums mt-0.5">
                <span>貯水率</span>
                <span className="font-semibold text-on-surface">{fmtPct(rate)}</span>
              </div>
            </div>
          ) : (
            <p className="mt-2 text-[11px] text-on-surface-variant">貯水率 —</p>
          )
        ) : null}
      </div>
      {sparkline && sparkline.length > 1 ? (
        <Link
          href={`/dams/${d.slug}`}
          className="shrink-0 flex items-end"
          aria-label={`${d.name} の貯水量推移`}
        >
          <Sparkline values={sparkline} width={140} height={56} />
        </Link>
      ) : null}
    </article>
  );
}
