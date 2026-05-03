import Image from 'next/image';
import Link from 'next/link';
import { fmtCapacityMcm } from '../lib/format.ts';
import type { DamRowItem } from './dam-table.tsx';

// Cover image is OPTIONAL ornament — when absent, render a clean text-only
// card without a placeholder. Only ~24% of dams have a real cover, so the
// default state is "no image" and that should feel intentional, not missing.
// When the image IS present it's a small 64×64 thumbnail next to the title,
// not a hero banner.
export function DamCard({ d }: { d: DamRowItem }) {
  return (
    <article className="card-surface flex gap-3 items-start">
      {d.imageUrl ? (
        <Link
          href={`/dams/${d.slug}`}
          className="shrink-0 relative w-16 h-16 rounded-lg overflow-hidden bg-surface-container-low"
        >
          <Image
            src={d.imageUrl}
            alt=""
            fill
            sizes="64px"
            className="object-cover"
          />
        </Link>
      ) : null}
      <div className="min-w-0 flex-1">
        <h3 className="font-display font-semibold leading-tight">
          <Link href={`/dams/${d.slug}`} className="text-on-surface no-underline hover:text-primary">
            {d.name}
          </Link>
        </h3>
        <p className="text-xs text-on-surface-variant truncate">{d.manager ?? '—'}</p>
        <p className="text-sm tabular-nums">{fmtCapacityMcm(d.totalCapacityM3)}</p>
      </div>
    </article>
  );
}
