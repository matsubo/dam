import { PREFECTURES } from '@dam/core/prefectures';
import { listDams } from '@dam/db/repo/dams';
import { listWatersheds } from '@dam/db/repo/watersheds';
import type { Metadata } from 'next';
import { Breadcrumbs } from '../../components/breadcrumbs.tsx';
import { DamTable } from '../../components/dam-table.tsx';
import { Pagination } from '../../components/pagination.tsx';

export const dynamic = 'force-dynamic';
export const revalidate = 900;

export const metadata: Metadata = {
  title: 'ダム一覧',
  description: '日本全国のダム一覧。都道府県・水系・管理者で絞り込み。',
};

interface SP {
  searchParams?: Promise<{ pref?: string; watershed?: string; manager?: string; cursor?: string }>;
}

export default async function DamsPage({ searchParams }: SP) {
  const sp = (await searchParams) ?? {};
  const [r, allWatersheds] = await Promise.all([
    listDams({
      pref: sp.pref ?? null,
      watershedSlug: sp.watershed ?? null,
      manager: sp.manager ?? null,
      search: null,
      cursor: sp.cursor ? BigInt(sp.cursor) : null,
      pageSize: 50,
    }),
    // Pull only the watersheds that actually have dams attached so the dropdown
    // doesn't list 644 systems where 144 are empty placeholders.
    listWatersheds({ pageSize: 500 }),
  ]);
  const watersheds = allWatersheds.items
    .filter((w) => w.damCount > 0)
    .sort((a, b) => {
      // 一級 → 二級 → その他, then by name
      const order = { first: 0, second: 1, other: 2 } as const;
      const da = order[a.kind] - order[b.kind];
      return da !== 0 ? da : a.name.localeCompare(b.name, 'ja');
    });
  return (
    <div className="max-w-7xl mx-auto px-5 md:px-10 py-8">
      <Breadcrumbs items={[{ label: 'ホーム', href: '/' }, { label: 'ダム' }]} />
      <h1 className="text-2xl font-semibold mb-4">ダム一覧</h1>

      <form className="mb-4 flex flex-wrap gap-2 items-center text-sm">
        <label className="flex items-center gap-2">
          <span className="text-muted">都道府県:</span>
          <select
            name="pref"
            defaultValue={sp.pref ?? ''}
            className="border border-gray-200 rounded px-2 py-1"
          >
            <option value="">— すべて —</option>
            {PREFECTURES.map((p) => (
              <option key={p.code} value={p.code}>
                {p.name}
              </option>
            ))}
          </select>
        </label>
        <label className="flex items-center gap-2">
          <span className="text-muted">水系:</span>
          <select
            name="watershed"
            defaultValue={sp.watershed ?? ''}
            className="border border-gray-200 rounded px-2 py-1 max-w-[260px]"
          >
            <option value="">— すべて —</option>
            <optgroup label="一級水系">
              {watersheds
                .filter((w) => w.kind === 'first')
                .map((w) => (
                  <option key={w.slug} value={w.slug}>
                    {w.name}（{w.damCount}）
                  </option>
                ))}
            </optgroup>
            <optgroup label="二級水系">
              {watersheds
                .filter((w) => w.kind === 'second')
                .map((w) => (
                  <option key={w.slug} value={w.slug}>
                    {w.name}（{w.damCount}）
                  </option>
                ))}
            </optgroup>
            <optgroup label="その他">
              {watersheds
                .filter((w) => w.kind === 'other')
                .map((w) => (
                  <option key={w.slug} value={w.slug}>
                    {w.name}（{w.damCount}）
                  </option>
                ))}
            </optgroup>
          </select>
        </label>
        <button type="submit" className="px-3 py-1 bg-accent text-white rounded">
          絞り込む
        </button>
        {(sp.pref || sp.watershed || sp.manager) && (
          <a href="/dams" className="px-3 py-1 border border-gray-200 rounded">
            クリア
          </a>
        )}
        <span className="text-muted ml-auto">{r.items.length} 件</span>
      </form>

      <DamTable rows={r.items.map((i) => ({ ...i, totalCapacityM3: i.totalCapacityM3 }))} />
      <Pagination basePath="/dams" nextCursor={r.nextCursor?.toString() ?? null} />
    </div>
  );
}
