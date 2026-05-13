// Visually distinguishes real-data observations from synthetic placeholders.
// `synthetic` — the bundled seed used to populate timelines for dams that
//                don't yet have an upstream feed wired up. Shown amber so
//                operators (and savvy users) can tell at a glance the
//                value is generated, not measured.
// anything else — a real source registered in source_priorities. Shown
//                emerald with the source identifier as a small chip so
//                users can click through to /sources for full provenance.
import Link from 'next/link';
import { sourceLabel } from '../lib/source-details.ts';

interface SourceBadgeProps {
  sourceId: string;
}

export function SourceBadge({ sourceId }: SourceBadgeProps) {
  const isSynthetic = sourceId === 'synthetic';
  const label = sourceLabel(sourceId);
  if (isSynthetic) {
    return (
      <Link
        href="/sources/synthetic"
        className="inline-flex items-baseline gap-1 text-xs px-1.5 py-0.5 bg-amber-50 text-amber-800 rounded hover:bg-amber-100"
        title="推定値（synthetic seed）。実観測ではなく、グラフ表示用に補完しています。"
      >
        <span aria-hidden>◇</span>
        <span>推定値</span>
      </Link>
    );
  }
  return (
    <Link
      href={`/sources/${encodeURIComponent(sourceId)}`}
      className="inline-flex items-baseline gap-1 text-xs px-1.5 py-0.5 bg-emerald-50 text-emerald-800 rounded hover:bg-emerald-100"
      title={`実測データ — ${label}`}
    >
      <span aria-hidden>●</span>
      <span>実測</span>
      <span className="text-emerald-600">{label}</span>
    </Link>
  );
}
