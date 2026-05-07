// Surfaces real-data dams whose latest 貯水率 has fallen below a critical
// threshold (currently 40%). Renders nothing when the list is empty so the
// homepage doesn't show an "all-clear" banner that itself becomes noise.
//
// Why this banner: synthetic-seed observations are noisy and would generate
// false alarms; the underlying `lowStorageDams` query already filters
// `source_id <> 'synthetic'`. So everything shown here is grounded in an
// upstream feed (tokyo-waterworks, jwa-junpo, ...).

import { PREFECTURES } from '@dam/core/prefectures';
import type { LowStorageDam } from '@dam/db/repo/dams';
import { AlertTriangle } from 'lucide-react';
import Link from 'next/link';

const PREF_NAME = new Map(PREFECTURES.map((p) => [p.code, p.name]));

interface DroughtAlertProps {
  dams: LowStorageDam[];
  /** Threshold used for the query (display-only; for the section header). */
  thresholdPct: number;
}

export function DroughtAlert({ dams, thresholdPct }: DroughtAlertProps) {
  if (dams.length === 0) return null;
  const worst = dams[0];
  if (!worst) return null;
  return (
    <section
      aria-label="貯水率の低いダム"
      className="border border-amber-300 bg-amber-50 rounded-lg p-4 md:p-5 mb-8"
    >
      <header className="flex items-baseline gap-2 mb-3 flex-wrap">
        <AlertTriangle aria-hidden className="text-amber-700 size-5 shrink-0 self-center" />
        <h2 className="text-base md:text-lg font-semibold text-amber-900">
          貯水率 {thresholdPct}% 未満のダム
        </h2>
        <span className="text-sm text-amber-800">
          {dams.length} 基（実測データのみ。最も低いのは {worst.name}{' '}
          {(worst.rate * 100).toFixed(1)}%）
        </span>
      </header>
      <ul className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-2">
        {dams.map((d) => {
          const ratePct = (d.rate * 100).toFixed(1);
          const tone =
            d.rate < 0.2
              ? 'text-red-800 bg-red-100'
              : d.rate < 0.3
                ? 'text-orange-800 bg-orange-100'
                : 'text-amber-800 bg-amber-100';
          return (
            <li key={d.id}>
              <Link
                href={`/dams/${d.slug}`}
                className="flex items-center justify-between gap-2 px-3 py-2 rounded bg-white hover:bg-amber-100 border border-amber-200 transition-colors"
              >
                <span className="min-w-0">
                  <span className="font-medium text-amber-950">{d.name}</span>
                  <span className="text-xs text-amber-800 ml-2">
                    {PREF_NAME.get(d.prefCode) ?? d.prefCode}
                    {d.watershedName ? ` · ${d.watershedName}` : ''}
                  </span>
                </span>
                <span className={`text-sm font-semibold px-1.5 py-0.5 rounded shrink-0 ${tone}`}>
                  {ratePct}%
                </span>
              </Link>
            </li>
          );
        })}
      </ul>
    </section>
  );
}
