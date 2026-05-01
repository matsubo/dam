import Link from 'next/link';
import { fmtCapacityMcm } from '../lib/format.ts';
import type { DamRowItem } from './dam-table.tsx';

export function DamCard({ d }: { d: DamRowItem }) {
  return (
    <article className="border border-gray-200 rounded p-4">
      <h3 className="text-lg font-semibold">
        <Link href={`/dams/${d.slug}`}>{d.name}</Link>
      </h3>
      <p className="text-sm text-muted">{d.manager ?? '—'}</p>
      <p className="text-sm">総貯水容量: {fmtCapacityMcm(d.totalCapacityM3)}</p>
    </article>
  );
}
