import Link from 'next/link';
import { fmtCapacityMcm } from '../lib/format.ts';
import type { DamRowItem } from './dam-table.tsx';
import { EntityIcon } from './entity-icon.tsx';
import { Sparkline } from './sparkline.tsx';

// Featured-dam card with optional inline sparkline showing recent storage
// trend. The sparkline is rendered server-side as an SVG <path> so there's
// zero client JS cost; pass `sparkline` as the dam's recent volume series
// (e.g. last 30 daily points). When omitted the card stays compact.
export function DamCard({ d, sparkline }: { d: DamRowItem; sparkline?: number[] }) {
  return (
    <article className="card-surface flex gap-4 items-stretch">
      <div className="min-w-0 flex-1 flex flex-col">
        <h3 className="font-display font-semibold leading-tight text-base mb-1 truncate inline-flex items-center gap-1.5">
          <EntityIcon kind="dam" size={16} className="text-primary shrink-0" />
          <Link href={`/dams/${d.slug}`} className="text-on-surface no-underline hover:text-primary truncate">
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
