import Link from 'next/link';
import { fmtPct } from '../lib/format.ts';
import { rateBand } from '../lib/rate-color.ts';

export interface SpotlightWatershed {
  slug: string;
  name: string;
  rate: number;
  /** Rate-able dams backing the rate — shown so a small sample is transparent. */
  observedDamCount: number;
}

/**
 * "貯水率の低い水系" — colour-coded tiles surfacing the driest systems so an
 * ordinary visitor sees at a glance where water is scarce, then can click
 * through to the watershed detail. Shared between the home page and the
 * watershed index.
 */
export function WatershedSpotlight({ items }: { items: SpotlightWatershed[] }) {
  if (items.length === 0) return null;
  return (
    <section aria-labelledby="driest-heading">
      <div className="flex items-center justify-between mb-3">
        <h2
          id="driest-heading"
          className="text-sm font-semibold text-on-surface inline-flex items-center gap-1.5"
        >
          <span aria-hidden className="w-2 h-2 rounded-full" style={{ background: '#dc2626' }} />
          貯水率の低い水系
        </h2>
        <Link href="/watersheds" className="text-xs text-primary hover:underline">
          すべての水系 →
        </Link>
      </div>
      <ul className="grid grid-cols-2 md:grid-cols-3 lg:grid-cols-6 gap-2">
        {items.map((w) => {
          const band = rateBand(w.rate);
          return (
            <li key={w.slug}>
              <Link
                href={`/watersheds/${w.slug}`}
                className="block bg-white border border-outline-variant rounded-xl p-3 no-underline hover:border-primary transition-colors h-full"
                style={{ borderLeft: `4px solid ${band.color}` }}
              >
                <div className="font-display font-semibold text-on-surface truncate">{w.name}</div>
                <div
                  className="text-2xl font-display font-bold tabular-nums leading-tight"
                  style={{ color: band.color }}
                >
                  {fmtPct(w.rate)}
                </div>
                <div className="text-[11px] flex items-center justify-between">
                  <span style={{ color: band.color }}>{band.label}</span>
                  <span className="text-on-surface-variant">{w.observedDamCount}基集計</span>
                </div>
              </Link>
            </li>
          );
        })}
      </ul>
    </section>
  );
}
