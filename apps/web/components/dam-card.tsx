import Image from 'next/image';
import Link from 'next/link';
import { fmtCapacityMcm } from '../lib/format.ts';
import type { DamRowItem } from './dam-table.tsx';

export function DamCard({ d }: { d: DamRowItem }) {
  return (
    <article className="border border-gray-200 rounded overflow-hidden flex flex-col">
      <Link href={`/dams/${d.slug}`} className="block bg-gray-100 aspect-[4/3] relative">
        {d.imageUrl ? (
          <Image
            src={d.imageUrl}
            alt={`${d.name}のダム`}
            fill
            sizes="(max-width: 768px) 100vw, 33vw"
            className="object-cover"
          />
        ) : (
          <div className="w-full h-full flex items-center justify-center text-muted text-xs">
            画像なし
          </div>
        )}
      </Link>
      <div className="p-4">
        <h3 className="text-lg font-semibold">
          <Link href={`/dams/${d.slug}`}>{d.name}</Link>
        </h3>
        <p className="text-sm text-muted">{d.manager ?? '—'}</p>
        <p className="text-sm">総貯水容量: {fmtCapacityMcm(d.totalCapacityM3)}</p>
      </div>
    </article>
  );
}
