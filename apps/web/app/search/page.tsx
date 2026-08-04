import { PREFECTURES } from '@dam/core/prefectures';
import { searchDams } from '@dam/db/repo/dams';
import { searchWatersheds } from '@dam/db/repo/watersheds';
import type { Metadata } from 'next';
import Link from 'next/link';
import { Breadcrumbs } from '../../components/breadcrumbs.tsx';
import { EntityIcon } from '../../components/entity-icon.tsx';
import { fmtCapacityMcm } from '../../lib/format.ts';

export const dynamic = 'force-dynamic';
export const revalidate = 0;

const PREF_NAME = new Map(PREFECTURES.map((p) => [p.code, p.name]));

export async function generateMetadata({
  searchParams,
}: { searchParams: Promise<{ q?: string }> }): Promise<Metadata> {
  const { q } = await searchParams;
  return {
    title: q ? `「${q}」の検索結果` : '検索',
    description: 'ダム名・水系名・読み仮名で部分一致検索。',
    alternates: { canonical: '/search' },
    robots: { index: false, follow: true },
  };
}

export default async function SearchPage({
  searchParams,
}: { searchParams: Promise<{ q?: string }> }) {
  const sp = await searchParams;
  const q = (sp.q ?? '').trim();
  const [dams, watersheds] = q
    ? await Promise.all([searchDams(q, 50), searchWatersheds(q, 50)])
    : [[], []];

  return (
    <div className="max-w-7xl mx-auto px-5 md:px-10 py-8">
      <Breadcrumbs items={[{ label: 'ホーム', href: '/' }, { label: '検索' }]} />
      <h1 className="text-3xl font-semibold mb-4">検索</h1>

      <form className="flex gap-2 mb-8 max-w-xl" action="/search" method="get">
        <input
          type="search"
          name="q"
          defaultValue={q}
          placeholder="ダム名、水系名、読み仮名を入力（部分一致）"
          className="flex-1 border border-outline-variant rounded-lg px-4 py-2 text-base"
          // biome-ignore lint/a11y/noAutofocus: dedicated search page — the input is the only thing to interact with
          autoFocus
        />
        <button type="submit" className="btn-primary !py-2 !px-5 text-sm">
          検索
        </button>
      </form>

      {q.length === 0 ? (
        <p className="text-on-surface-variant">キーワードを入力してください。</p>
      ) : dams.length === 0 && watersheds.length === 0 ? (
        <p className="text-on-surface-variant">「{q}」に一致する結果はありません。</p>
      ) : (
        <>
          {watersheds.length > 0 && (
            <section className="mb-10">
              <h2 className="text-lg font-semibold mb-3 inline-flex items-center gap-2">
                <EntityIcon kind="watershed" size={18} className="shrink-0" />
                <span>水系</span>
                <span className="text-on-surface-variant text-sm font-normal">
                  ({watersheds.length})
                </span>
              </h2>
              <ul className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-2">
                {watersheds.map((w) => (
                  <li key={w.slug}>
                    <Link
                      href={`/watersheds/${w.slug}`}
                      className="card-surface block no-underline"
                    >
                      <div className="font-display font-semibold text-on-surface inline-flex items-center gap-1.5">
                        <EntityIcon kind="watershed" size={16} className="shrink-0" />
                        <span>{w.name}</span>
                      </div>
                      <div className="text-xs text-on-surface-variant inline-flex items-center gap-1 flex-wrap">
                        <span>
                          {w.kind === 'first'
                            ? '一級水系'
                            : w.kind === 'second'
                              ? '二級水系'
                              : 'その他'}
                          {' · '}
                        </span>
                        <EntityIcon kind="dam" size={11} className="text-primary shrink-0" />
                        <span>{w.damCount}基</span>
                      </div>
                    </Link>
                  </li>
                ))}
              </ul>
            </section>
          )}

          {dams.length > 0 && (
            <section className="mb-10">
              <h2 className="text-lg font-semibold mb-3 inline-flex items-center gap-2">
                <EntityIcon kind="dam" size={18} className="text-primary shrink-0" />
                <span>ダム</span>
                <span className="text-on-surface-variant text-sm font-normal">({dams.length})</span>
              </h2>
              <ul className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-2">
                {dams.map((d) => (
                  <li key={d.slug}>
                    <Link href={`/dams/${d.slug}`} className="card-surface block no-underline">
                      <div className="font-display font-semibold text-on-surface inline-flex items-center gap-1.5">
                        <EntityIcon kind="dam" size={16} className="text-primary shrink-0" />
                        <span>{d.name}</span>
                      </div>
                      <div className="text-xs text-on-surface-variant truncate inline-flex items-center gap-1 flex-wrap">
                        <span>{PREF_NAME.get(d.prefCode) ?? d.prefCode}</span>
                        {d.watershedName ? (
                          <>
                            <span>·</span>
                            <EntityIcon kind="watershed" size={11} className="shrink-0" />
                            <span>{d.watershedName}</span>
                          </>
                        ) : null}
                        {d.manager ? <span>· {d.manager}</span> : null}
                      </div>
                      <div className="text-sm tabular-nums">
                        {fmtCapacityMcm(d.totalCapacityM3)}
                        <span className="text-on-surface-variant text-xs ml-1">
                          (利水 {fmtCapacityMcm(d.activeCapacityM3)})
                        </span>
                      </div>
                    </Link>
                  </li>
                ))}
              </ul>
            </section>
          )}
        </>
      )}
    </div>
  );
}
