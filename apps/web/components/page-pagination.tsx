import Link from 'next/link';

interface Props {
  /** Path to navigate to, e.g. "/dams". Query string is reconstructed from `query`. */
  basePath: string;
  /** All current query params except `page`. They're preserved across page nav. */
  query: Record<string, string | null | undefined>;
  page: number;
  totalPages: number;
  total: number;
}

function buildHref(
  basePath: string,
  query: Record<string, string | null | undefined>,
  page: number,
): string {
  const sp = new URLSearchParams();
  for (const [k, v] of Object.entries(query)) {
    if (v != null && v !== '') sp.set(k, v);
  }
  if (page > 1) sp.set('page', String(page));
  const qs = sp.toString();
  return qs ? `${basePath}?${qs}` : basePath;
}

/**
 * Compress 1..totalPages to: [1, ?…, p-1, p, p+1, ?…, totalPages].
 * The two ellipsis sentinels are emitted only when there's a real gap so the
 * bar stays compact for both 5-page and 500-page result sets.
 */
function pageWindow(page: number, totalPages: number): (number | 'ellipsis')[] {
  const around = 2; // pages each side of the current page
  const set = new Set<number>([1, totalPages, page]);
  for (let i = 1; i <= around; i++) {
    if (page - i >= 1) set.add(page - i);
    if (page + i <= totalPages) set.add(page + i);
  }
  const sorted = [...set].sort((a, b) => a - b);
  const out: (number | 'ellipsis')[] = [];
  for (let i = 0; i < sorted.length; i++) {
    const cur = sorted[i] as number;
    const prev = i > 0 ? (sorted[i - 1] as number) : null;
    if (prev !== null && cur - prev > 1) out.push('ellipsis');
    out.push(cur);
  }
  return out;
}

export function PagePagination({ basePath, query, page, totalPages, total }: Props) {
  if (totalPages <= 1) {
    return <div className="flex justify-end mt-4 text-xs text-on-surface-variant">{total} 件</div>;
  }
  const items = pageWindow(page, totalPages);
  const linkClass =
    'inline-flex items-center justify-center min-w-[34px] h-[34px] px-2 rounded-md border border-outline-variant text-sm tabular-nums hover:bg-surface-variant';
  const currentClass =
    'inline-flex items-center justify-center min-w-[34px] h-[34px] px-2 rounded-md border border-primary bg-primary/10 text-primary text-sm font-semibold tabular-nums';
  const disabledClass =
    'inline-flex items-center justify-center min-w-[34px] h-[34px] px-2 rounded-md border border-outline-variant text-sm text-on-surface-variant/50 cursor-default';
  return (
    <nav
      className="flex flex-wrap items-center gap-2 mt-6 justify-between"
      aria-label="ページネーション"
    >
      <div className="text-xs text-on-surface-variant tabular-nums">
        全 {total.toLocaleString('ja-JP')} 件 · {page} / {totalPages} ページ
      </div>
      <div className="flex flex-wrap items-center gap-1">
        {page > 1 ? (
          <Link href={buildHref(basePath, query, page - 1)} className={linkClass} rel="prev">
            « 前へ
          </Link>
        ) : (
          <span className={disabledClass} aria-hidden>
            « 前へ
          </span>
        )}
        {items.map((it, i) =>
          it === 'ellipsis' ? (
            // biome-ignore lint/suspicious/noArrayIndexKey: position-stable in this render
            <span key={`ellipsis-${i}`} className="px-1 text-on-surface-variant">
              …
            </span>
          ) : it === page ? (
            <span key={it} className={currentClass} aria-current="page">
              {it}
            </span>
          ) : (
            <Link key={it} href={buildHref(basePath, query, it)} className={linkClass}>
              {it}
            </Link>
          ),
        )}
        {page < totalPages ? (
          <Link href={buildHref(basePath, query, page + 1)} className={linkClass} rel="next">
            次へ »
          </Link>
        ) : (
          <span className={disabledClass} aria-hidden>
            次へ »
          </span>
        )}
      </div>
    </nav>
  );
}
