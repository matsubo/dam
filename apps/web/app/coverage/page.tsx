// Coverage dashboard — tracks progress toward 100% real-observation
// coverage across every master dam. See GitHub issue #1 for the roadmap;
// sub-issues #2-#16 break it down by phase.
//
// Two metrics live here and they are NOT interchangeable: 実測 counts any
// observation (a level-only feed counts), 貯水率取得 counts the dams we can
// actually render a 貯水率 for. Both come from repo/coverage.ts, which the
// home page shares.
//
// Do not link the issue tracker from rendered output — the repo is private,
// so visitors get a 404. The public-facing roadmap is /roadmap.

import { PREFECTURES } from '@dam/core/prefectures';
import { sql } from '@dam/db/client';
import {
  coverageHeadline,
  realtimeCoveragePct,
  storageRateCoveragePct,
} from '@dam/db/repo/coverage';
import { coverageSummary } from '@dam/db/repo/source_universe';
import type { Metadata } from 'next';
import Link from 'next/link';
import { Breadcrumbs } from '../../components/breadcrumbs.tsx';
import { SOURCE_DETAILS } from '../../lib/source-details.ts';

export const dynamic = 'force-dynamic';
export const revalidate = 900;

export const metadata: Metadata = {
  title: 'カバレッジ',
  description: '全国のダムに対する実測データ取得カバレッジ。ソース別・都道府県別の進捗。',
  alternates: { canonical: '/coverage' },
};

const PREF_NAME = new Map(PREFECTURES.map((p) => [p.code, p.name]));

interface SourceRow {
  sourceId: string;
  damsCovered: bigint;
  obsLast30d: bigint;
  lastObs: Date | null;
}

interface PrefRow {
  prefCode: string;
  damTotal: bigint;
  damsCovered: bigint;
}

async function loadCoverage() {
  const [headline, sources, prefs] = await Promise.all([
    coverageHeadline(),
    sql<SourceRow[]>`
      SELECT
        source_id AS "sourceId",
        COUNT(DISTINCT dam_id)::BIGINT AS "damsCovered",
        COUNT(*) FILTER (WHERE observed_at > NOW() - INTERVAL '30 days')::BIGINT AS "obsLast30d",
        MAX(observed_at) AS "lastObs"
      FROM observations
      WHERE source_id <> 'synthetic'
      GROUP BY source_id
      ORDER BY COUNT(DISTINCT dam_id) DESC
    `,
    sql<PrefRow[]>`
      WITH per_pref AS (
        SELECT pref_code, COUNT(*)::BIGINT AS total
        FROM dams
        WHERE pref_code IS NOT NULL
        GROUP BY pref_code
      ),
      covered AS (
        SELECT d.pref_code, COUNT(DISTINCT o.dam_id)::BIGINT AS covered
        FROM dams d
        JOIN observations o ON o.dam_id = d.id
        WHERE d.pref_code IS NOT NULL
          AND o.observed_at > NOW() - INTERVAL '30 days'
          AND o.source_id <> 'synthetic'
        GROUP BY d.pref_code
      )
      SELECT
        p.pref_code AS "prefCode",
        p.total     AS "damTotal",
        COALESCE(c.covered, 0::BIGINT) AS "damsCovered"
      FROM per_pref p
      LEFT JOIN covered c ON c.pref_code = p.pref_code
      ORDER BY p.pref_code
    `,
  ]);
  return { headline, sources, prefs };
}

function pct(n: bigint, d: bigint): number {
  if (d === 0n) return 0;
  return Number((n * 10000n) / d) / 100;
}

function sourceLabel(id: string): string {
  return SOURCE_DETAILS[id]?.label ?? id;
}

function CoverageBar({ value }: { value: number }) {
  const w = Math.max(2, Math.min(100, value));
  const color =
    value >= 80
      ? 'bg-emerald-500'
      : value >= 30
        ? 'bg-amber-500'
        : value >= 5
          ? 'bg-orange-500'
          : 'bg-red-400';
  return (
    <div
      aria-label={`${value.toFixed(0)}% coverage`}
      className="h-2 rounded-full bg-surface-container-low overflow-hidden"
    >
      <div className={`h-full ${color}`} style={{ width: `${w}%` }} />
    </div>
  );
}

function HeadlineCard({
  label,
  pct,
  value,
  total,
  note,
}: {
  label: string;
  pct: number;
  value: number;
  total: number;
  note: string;
}) {
  return (
    <div className="bg-white border border-outline-variant rounded-xl p-5">
      <div className="text-xs uppercase tracking-wider text-on-surface-variant mb-1">{label}</div>
      <div className="text-3xl font-display font-semibold tabular-nums">{pct.toFixed(2)}%</div>
      <div className="text-xs text-on-surface-variant mt-1">
        {value.toLocaleString()} / {total.toLocaleString()} 基
      </div>
      <div className="mt-3">
        <CoverageBar value={pct} />
      </div>
      <div className="text-xs text-on-surface-variant mt-3 leading-snug">{note}</div>
    </div>
  );
}

function TriageCard({
  label,
  value,
  total,
  tone,
  note,
}: {
  label: string;
  value: number;
  total: number;
  tone: 'ok' | 'action' | 'pending' | 'none';
  note: string;
}) {
  const accent = {
    ok: 'text-emerald-700',
    action: 'text-orange-700',
    pending: 'text-slate-500',
    none: 'text-red-700',
  }[tone];
  const share = total > 0 ? (100 * value) / total : 0;
  return (
    <div className="bg-white border border-outline-variant rounded-xl p-4">
      <div className="text-xs text-on-surface-variant mb-1">{label}</div>
      <div className={`text-2xl font-display font-semibold tabular-nums ${accent}`}>
        {value.toLocaleString()}
      </div>
      <div className="text-xs text-on-surface-variant tabular-nums">{share.toFixed(1)}%</div>
      <div className="text-xs text-on-surface-variant mt-2 leading-snug">{note}</div>
    </div>
  );
}

export default async function CoveragePage() {
  const [{ headline, sources, prefs }, triage] = await Promise.all([
    loadCoverage(),
    coverageSummary(),
  ]);
  const total = headline.damTotal;
  const rtPct = realtimeCoveragePct(headline) ?? 0;
  const ratePct = storageRateCoveragePct(headline) ?? 0;
  const histPct = total > 0 ? (100 * headline.historicalDamCount) / total : 0;
  const sortedPrefs = [...prefs].sort(
    (a, b) => pct(a.damsCovered, a.damTotal) - pct(b.damsCovered, b.damTotal),
  );

  return (
    <div className="max-w-5xl mx-auto px-5 md:px-10 py-8">
      <Breadcrumbs items={[{ label: 'ホーム', href: '/' }, { label: 'カバレッジ' }]} />
      <h1 className="text-2xl font-semibold mb-2">カバレッジ</h1>
      <p className="text-sm text-on-surface-variant mb-6">
        全国 <strong>{Number(total).toLocaleString()}</strong> ダムに対する実測データ取得状況。
        「実測」は水位・雨量だけでも 1 基と数え、「貯水率取得」は貯水率を表示できるダムに限った、
        より厳しい指標です（分母も河川管理ダムに限定）。数字が食い違って見えるのはこの定義差によるものです。
        今後の方針は{' '}
        <Link className="text-primary hover:underline" href="/roadmap">
          ロードマップ
        </Link>{' '}
        に。
      </p>

      {/* Coverage is the one number a would-be contributor can move, so the
          recruitment CTA belongs here rather than only in the footer. */}
      <div className="border border-primary bg-primary/5 rounded-xl p-4 mb-8 flex flex-wrap items-center gap-x-4 gap-y-2">
        <p className="text-sm flex-1 min-w-[16rem] leading-relaxed">
          この数字を上げるのを手伝ってくれる開発者を探しています。個人が一人で運営しているため、
          未取得のダムがまだ多く残っています。
        </p>
        <Link
          href="/contribute"
          className="text-sm font-semibold text-primary hover:underline whitespace-nowrap"
        >
          開発者募集を見る →
        </Link>
      </div>

      <section className="mb-10">
        <h2 className="text-lg font-semibold mb-1">未取得ダムの内訳</h2>
        <p className="text-sm text-on-surface-variant mb-4">
          「取れていない」を、こちらの不具合で直せるものと、そもそもデータ提供元が無いものに分けます。
          各データ提供元が公開しているダム一覧を記録し、マスタと突き合わせて判定しています。
        </p>
        <div className="grid grid-cols-2 lg:grid-cols-4 gap-3">
          <TriageCard
            label="取得済み"
            value={triage.covered}
            total={Number(total)}
            tone="ok"
            note="直近 30 日に観測値あり"
          />
          <TriageCard
            label="公開されているが未取得"
            value={triage.publishedNotIngested}
            total={Number(total)}
            tone="action"
            note="提供元が公開済み・紐付けも済み。取り込み側の不具合"
          />
          <TriageCard
            label="未調査"
            value={triage.unknown}
            total={Number(total)}
            tone="pending"
            note={`公開一覧が未記録の提供元が ${triage.sourcesPendingScan} 件残っている`}
          />
          <TriageCard
            label="提供元なし"
            value={triage.notPublished}
            total={Number(total)}
            tone="none"
            note="全提供元の公開一覧に現れなかった"
          />
        </div>
        {triage.sourcesPendingScan > 0 ? (
          <p className="text-xs text-on-surface-variant mt-3 leading-relaxed">
            <strong>判定は途中です。</strong> 公開一覧を記録済みのデータ提供元はまだ一部で、残り{' '}
            {triage.sourcesPendingScan} 件が未記録です。そのため大半のダムは「未調査」に入り、
            「提供元なし」は全提供元を記録し終えるまで確定しません。 提供元は公開しているのに
            マスタと紐付いていない観測所は現在 {triage.unmatchedStations.toLocaleString()}{' '}
            件で、これが手を付けられる作業対象です。
          </p>
        ) : null}
        {triage.sourcesNotEnumerable > 0 ? (
          <p className="text-xs text-on-surface-variant mt-2 leading-relaxed">
            また、公開一覧を列挙できない提供元が {triage.sourcesNotEnumerable}{' '}
            件あります（洪水時のみダムを掲載する県のポータルなど）。判定ゲートからは除外しているため、
            その担当地域の「提供元なし」には保留が残ります。
          </p>
        ) : null}
      </section>

      <section className="grid grid-cols-1 sm:grid-cols-3 gap-4 mb-10">
        <HeadlineCard
          label="実測 (直近 30 日)"
          pct={rtPct}
          value={headline.realtimeDamCount}
          total={total}
          note="何らかの観測値が届いているダム。水位・雨量だけの提供元も含みます。"
        />
        <HeadlineCard
          label="貯水率取得 (直近 30 日)"
          pct={ratePct}
          value={headline.storageRateRiverDamCount}
          total={headline.riverDamCount}
          note="貯水率を表示できるダム。分母は河川管理ダム (堤高 15 m 以上)。トップページと同じ指標です。"
        />
        <HeadlineCard
          label="歴史データ含む (mudam 等)"
          pct={histPct}
          value={headline.historicalDamCount}
          total={total}
          note="過去に一度でも実測が届いたダム。現在も更新中とは限りません。"
        />
      </section>

      <section className="mb-10">
        <h2 className="text-lg font-semibold mb-3">ソース別カバレッジ</h2>
        <div className="overflow-x-auto border border-outline-variant rounded-xl">
          <table className="min-w-full text-sm">
            <thead className="bg-surface-container-low">
              <tr className="text-left">
                <th className="px-4 py-2 font-medium">ソース</th>
                <th className="px-4 py-2 font-medium text-right">カバー数</th>
                <th className="px-4 py-2 font-medium text-right">直近30日 obs</th>
                <th className="px-4 py-2 font-medium">最終観測</th>
              </tr>
            </thead>
            <tbody>
              {sources.map((s) => (
                <tr key={s.sourceId} className="border-t border-outline-variant">
                  <td className="px-4 py-2">
                    <Link className="text-primary hover:underline" href={`/sources/${s.sourceId}`}>
                      {sourceLabel(s.sourceId)}
                    </Link>
                  </td>
                  <td className="px-4 py-2 text-right tabular-nums font-mono">
                    {Number(s.damsCovered).toLocaleString()}
                  </td>
                  <td className="px-4 py-2 text-right tabular-nums font-mono">
                    {Number(s.obsLast30d).toLocaleString()}
                  </td>
                  <td className="px-4 py-2 text-xs text-on-surface-variant">
                    {s.lastObs ? s.lastObs.toISOString().slice(0, 16).replace('T', ' ') : '—'}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </section>

      <section className="mb-10">
        <h2 className="text-lg font-semibold mb-3">都道府県別 (実測 30 日カバレッジ昇順)</h2>
        <p className="text-xs text-on-surface-variant mb-3">
          カバレッジが低い県ほど取り組み優先度が高い。
        </p>
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
          {sortedPrefs.map((p) => {
            const v = pct(p.damsCovered, p.damTotal);
            return (
              <Link
                key={p.prefCode}
                href={`/prefectures/${p.prefCode}`}
                className="block bg-white border border-outline-variant rounded-lg p-3 hover:border-primary transition-colors"
              >
                <div className="flex justify-between items-baseline mb-2">
                  <span className="text-sm font-medium">
                    {PREF_NAME.get(p.prefCode) ?? p.prefCode}
                  </span>
                  <span className="text-xs text-on-surface-variant tabular-nums">
                    {Number(p.damsCovered)} / {Number(p.damTotal)} ({v.toFixed(0)}%)
                  </span>
                </div>
                <CoverageBar value={v} />
              </Link>
            );
          })}
        </div>
      </section>

      <p className="text-xs text-on-surface-variant">
        本ページは 15 分キャッシュ。最新の取り込み状況は{' '}
        <Link className="text-primary hover:underline" href="/sources">
          /sources
        </Link>{' '}
        を参照。
      </p>
    </div>
  );
}
