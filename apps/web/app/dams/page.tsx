import { PREFECTURES } from '@dam/core/prefectures';
import { latestRateAndSourceByDam, listDamsPaged } from '@dam/db/repo/dams';
import { listWatersheds } from '@dam/db/repo/watersheds';
import type { Metadata } from 'next';
import { Breadcrumbs } from '../../components/breadcrumbs.tsx';
import { DamTable } from '../../components/dam-table.tsx';
import { EntityIcon } from '../../components/entity-icon.tsx';
import { PagePagination } from '../../components/page-pagination.tsx';

export const dynamic = 'force-dynamic';
export const revalidate = 900;

export const metadata: Metadata = {
  title: 'ダム一覧',
  description: '日本全国のダム一覧。都道府県・水系・管理者で絞り込み。',
  alternates: { canonical: '/dams' },
};

interface SP {
  searchParams?: Promise<{
    pref?: string;
    watershed?: string;
    manager?: string;
    page?: string;
    /** '1' restricts to dams with a non-synthetic observation in the last 30 days. */
    real?: string;
  }>;
}

const PAGE_SIZE = 50;

export default async function DamsPage({ searchParams }: SP) {
  const sp = (await searchParams) ?? {};
  const requestedPage = sp.page ? Number(sp.page) : 1;
  const realDataOnly = sp.real === '1';
  // Treat empty-string query params (e.g. `?pref=13&watershed=` produced by
  // the filter form when 水系 is unselected) as "not filtered". Without this
  // the watershed_slug = '' clause matches no rows and shows 0 results.
  const blank = (s: string | undefined): string | null => (s == null || s === '' ? null : s);
  const [r, allWatersheds] = await Promise.all([
    listDamsPaged({
      pref: blank(sp.pref),
      watershedSlug: blank(sp.watershed),
      manager: blank(sp.manager),
      search: null,
      realDataOnly,
      page: Number.isFinite(requestedPage) ? requestedPage : 1,
      pageSize: PAGE_SIZE,
    }),
    // Pull only the watersheds that actually have dams attached so the dropdown
    // doesn't list 644 systems where 144 are empty placeholders.
    listWatersheds({ pageSize: 1000 }),
  ]);
  const watersheds = allWatersheds.items
    .filter((w) => w.damCount > 0)
    .sort((a, b) => {
      // 一級 → 二級 → その他, then by name
      const order = { first: 0, second: 1, other: 2 } as const;
      const da = order[a.kind] - order[b.kind];
      return da !== 0 ? da : a.name.localeCompare(b.name, 'ja');
    });
  // 貯水率 column on the dam table — single LATERAL query, scoped to the
  // current page so cost is bounded.
  const rates = await latestRateAndSourceByDam(r.items.map((d) => d.id));
  return (
    <div className="max-w-7xl mx-auto px-5 md:px-10 py-8">
      <Breadcrumbs items={[{ label: 'ホーム', href: '/' }, { label: 'ダム' }]} />
      <h1 className="text-2xl font-semibold mb-4 inline-flex items-center gap-2">
        <EntityIcon kind="dam" size={24} className="text-primary shrink-0" />
        <span>ダム一覧</span>
      </h1>

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
        <label className="flex items-center gap-1.5 text-sm">
          <input
            type="checkbox"
            name="real"
            value="1"
            defaultChecked={realDataOnly}
            className="size-4"
          />
          <span className="text-muted">実測データのみ</span>
        </label>
        <button type="submit" className="px-3 py-1 bg-accent text-white rounded">
          絞り込む
        </button>
        {(sp.pref || sp.watershed || sp.manager || realDataOnly) && (
          <a href="/dams" className="px-3 py-1 border border-gray-200 rounded">
            クリア
          </a>
        )}
        <span className="text-muted ml-auto tabular-nums">
          {r.total.toLocaleString('ja-JP')} 件
        </span>
      </form>

      <DamTable rows={r.items} rates={rates} />
      <PagePagination
        basePath="/dams"
        query={{
          pref: sp.pref ?? null,
          watershed: sp.watershed ?? null,
          manager: sp.manager ?? null,
          real: realDataOnly ? '1' : null,
        }}
        page={r.page}
        totalPages={r.totalPages}
        total={r.total}
      />
    </div>
  );
}
