// Contributor recruitment. The honest version: one person, more upstream
// sources than the design anticipated, and coverage as the single priority.
//
// Live figures come from the database so the page can't drift; codebase
// figures live in lib/project-stats.ts with their regeneration commands.

import { sql } from '@dam/db/client';
import {
  CircleDot,
  Database,
  GitBranch,
  HandHeart,
  Heart,
  Lock,
  MessageCircle,
  Scale,
  Users,
} from 'lucide-react';
import type { Metadata } from 'next';
import Link from 'next/link';
import { Breadcrumbs } from '../../components/breadcrumbs.tsx';
import { CONTRIBUTORS, DISCORD_INVITE, MAINTAINER } from '../../lib/contributors.ts';
import { fmtDateOnly, fmtN } from '../../lib/format.ts';
import { PROJECT_STATS, STACK } from '../../lib/project-stats.ts';

export const dynamic = 'force-dynamic';
export const revalidate = 900;

export const metadata: Metadata = {
  title: '開発者募集',
  description:
    'Dam Data Platform は一人で開発・運用しているオープンデータ基盤です。全国のダムのカバレッジを上げる開発者を募集しています。技術スタック・規模・条件・寄付について。',
  alternates: { canonical: '/contribute' },
};

interface Live {
  damTotal: bigint;
  watershedTotal: bigint;
  obsTotal: bigint;
  obsLast24h: bigint;
  rawSnapshots: bigint;
  sourcesActive: bigint;
  damsCovered30d: bigint;
  oldestObs: Date | null;
  newestObs: Date | null;
}

async function loadLive(): Promise<Live> {
  const rows = await sql<Live[]>`
    SELECT
      (SELECT COUNT(*) FROM dams)::BIGINT                                     AS "damTotal",
      (SELECT COUNT(*) FROM watersheds)::BIGINT                               AS "watershedTotal",
      (SELECT COUNT(*) FROM observations)::BIGINT                             AS "obsTotal",
      (SELECT COUNT(*) FROM observations
       WHERE observed_at > NOW() - INTERVAL '24 hours')::BIGINT               AS "obsLast24h",
      (SELECT COUNT(*) FROM raw_snapshots)::BIGINT                            AS "rawSnapshots",
      (SELECT COUNT(DISTINCT source_id) FROM observations
       WHERE observed_at > NOW() - INTERVAL '30 days'
         AND source_id <> 'synthetic')::BIGINT                                AS "sourcesActive",
      (SELECT COUNT(DISTINCT dam_id) FROM observations
       WHERE observed_at > NOW() - INTERVAL '30 days'
         AND source_id <> 'synthetic')::BIGINT                                AS "damsCovered30d",
      (SELECT MIN(observed_at) FROM observations)                             AS "oldestObs",
      (SELECT MAX(observed_at) FROM observations)                             AS "newestObs"
  `;
  const row = rows[0];
  if (!row) throw new Error('project figures query returned no rows');
  return row;
}

function pct(n: bigint, d: bigint): number {
  if (d === 0n) return 0;
  return Number((n * 1000n) / d) / 10;
}

function Section({
  id,
  eyebrow,
  title,
  children,
}: {
  id: string;
  eyebrow: string;
  title: string;
  children: React.ReactNode;
}) {
  return (
    <section id={id} className="scroll-mt-24 mb-14">
      <div className="eyebrow mb-2">{eyebrow}</div>
      <h2 className="text-xl font-semibold mb-4">{title}</h2>
      {children}
    </section>
  );
}

function Figure({ label, value, note }: { label: string; value: string; note?: string }) {
  return (
    <div className="bg-white border border-outline-variant rounded-xl p-4">
      <div className="text-xs text-on-surface-variant mb-1">{label}</div>
      <div className="text-2xl font-semibold tabular-nums leading-tight">{value}</div>
      {note ? <div className="text-[11px] text-on-surface-variant mt-1">{note}</div> : null}
    </div>
  );
}

export default async function ContributePage() {
  const live = await loadLive();
  const coverage = pct(live.damsCovered30d, live.damTotal);
  const uncovered = live.damTotal - live.damsCovered30d;

  return (
    <div className="max-w-3xl mx-auto px-5 md:px-10 py-8">
      <Breadcrumbs items={[{ label: 'ホーム', href: '/' }, { label: '開発者募集' }]} />

      <h1 className="text-3xl font-bold tracking-tight mb-3">開発者募集</h1>
      <p className="text-base text-on-surface-variant leading-relaxed mb-6">
        Dam Data Platform は、全国 {fmtN(Number(live.damTotal))}{' '}
        基のダムの諸元と貯水量履歴を集約して無償で公開しているオープンデータ基盤です。
        設計から実装、データソースの開拓、サーバー運用まで、
        <strong className="text-on-surface font-semibold">現在は一人でやっています</strong>。
        手が足りないので、一緒に作ってくれる開発者を探しています。
      </p>

      <div className="border border-primary bg-primary/5 rounded-2xl p-5 mb-12">
        <div className="flex items-center gap-2 mb-2">
          <CircleDot className="text-primary shrink-0" size={20} aria-hidden="true" />
          <span className="font-semibold">いま一番やってほしいこと</span>
        </div>
        <p className="text-sm leading-relaxed">
          <strong>データカバレッジを上げること</strong>。実測値が取れているのは{' '}
          <span className="font-semibold tabular-nums">
            {fmtN(Number(live.damsCovered30d))} / {fmtN(Number(live.damTotal))} 基（
            {coverage.toFixed(1)}%）
          </span>
          で、残り {fmtN(Number(uncovered))} 基はまだ諸元しかありません。
          取得頻度の改善は後回しでよいので、まずは「まだ取れていないダム」を減らしたい。
        </p>
        <div className="flex flex-wrap gap-3 mt-4">
          <a
            className="btn-primary text-sm"
            href={DISCORD_INVITE}
            target="_blank"
            rel="noopener noreferrer"
          >
            <MessageCircle size={16} aria-hidden="true" />
            Discord で声をかける
          </a>
          <a
            className="btn-outline text-sm"
            href={MAINTAINER.sponsorsUrl}
            target="_blank"
            rel="noopener noreferrer"
          >
            <Heart size={16} aria-hidden="true" />
            GitHub Sponsors で支援する
          </a>
        </div>
      </div>

      <Section id="history" eyebrow="History" title="このサイトの経緯">
        <div className="space-y-4 text-sm leading-relaxed text-on-surface-variant">
          <p>
            {PROJECT_STATS.firstCommit} に最初のコミットを打ちました。「日本のダムのデータを、
            一箇所でまとめて、機械可読な形で無償公開する」という一点だけを目的にしています。
            国土数値情報のダム諸元とダム便覧をマスタとして取り込み、そこに各地の観測値を
            重ねていく、という構成は初日から変えていません。
          </p>
          <p>
            当初の想定は単純でした。「川の防災情報と水文水質データベースの 2
            系統を叩けば全国そろう」。 実際には、
            <strong className="text-on-surface font-semibold">
              全国規模で叩ける情報源は、そこで頭打ちになりました
            </strong>
            。川の防災情報のダムカタログに載っているのは全国 900 基ほどで、
            水文水質データベース由来の諸量データは 2024 年で更新が止まっています。 この 2
            つを取り切っても、全体の 3 分の 1 ほどにしかなりません。
          </p>
          <p>
            残りのダムの値は、都道府県の河川・防災ポータル、地方整備局、企業局、水道局、
            オープンデータカタログへとバラバラに公開されていました。フォーマットは HTML テーブル、
            Shift_JIS の CSV、独自 JSON とまちまちで、ダムを識別する共通の ID もありません。
            結果として、想定していた 2 本のアダプタは{' '}
            <strong className="text-on-surface font-semibold">
              {PROJECT_STATS.ingestTasks} 本の取り込みタスク
            </strong>
            になり、cron エントリは {PROJECT_STATS.cronEntries} 行に膨らみました。
          </p>
          <p>
            それでもカバレッジは {coverage.toFixed(1)}% です。残りの多くは農業用ダムや小規模ダムで、
            そもそも実測値が公開されていないか、公開先をまだ見つけられていません。つまり、
            <strong className="text-on-surface font-semibold">
              100% のカバレッジと高頻度の更新を同時に達成するのは、一人では難しい
            </strong>
            と分かってきた、という状況です。だから優先順位をつけて、
            まずカバレッジを取りにいくことにしました。
          </p>
        </div>
      </Section>

      <Section id="scale" eyebrow="Scale" title="いまの規模">
        <p className="text-sm text-on-surface-variant mb-4">
          データ側の数字はこのページを開いた時点の本番データベースから直接引いています。
          コード側の数字は {PROJECT_STATS.measuredOn} 時点の実測値です。
        </p>
        <div className="eyebrow-muted mb-3">本番データ</div>
        <div className="grid grid-cols-2 md:grid-cols-3 gap-3 mb-8">
          <Figure label="ダム" value={`${fmtN(Number(live.damTotal))} 基`} />
          <Figure label="水系" value={`${fmtN(Number(live.watershedTotal))} 水系`} />
          <Figure
            label="観測レコード"
            value={fmtN(Number(live.obsTotal))}
            note={`${fmtDateOnly(live.oldestObs)} 〜 ${fmtDateOnly(live.newestObs)}`}
          />
          <Figure label="直近 24 時間の取り込み" value={fmtN(Number(live.obsLast24h))} />
          <Figure
            label="生スナップショット"
            value={fmtN(Number(live.rawSnapshots))}
            note="取得元のレスポンスを再パース用に保管"
          />
          <Figure
            label="稼働中のソース"
            value={`${fmtN(Number(live.sourcesActive))} 系統`}
            note={`直近 30 日に取り込み実績あり・カバレッジ ${coverage.toFixed(1)}%`}
          />
        </div>

        <div className="eyebrow-muted mb-3">コードベース</div>
        <div className="grid grid-cols-2 md:grid-cols-3 gap-3 mb-4">
          <Figure
            label="TypeScript"
            value={`${fmtN(PROJECT_STATS.tsLines)} 行`}
            note={`${PROJECT_STATS.tsFiles} ファイル`}
          />
          <Figure
            label="テストファイル"
            value={`${PROJECT_STATS.testFiles} 本`}
            note="bun test + Playwright"
          />
          <Figure
            label="取り込みタスク"
            value={`${PROJECT_STATS.ingestTasks} 本`}
            note={`ワーカータスク計 ${PROJECT_STATS.workerTasks} 本`}
          />
          <Figure
            label="DB テーブル"
            value={`${PROJECT_STATS.tables} 個`}
            note={`+ hypertable 1 / 連続集計 ${PROJECT_STATS.continuousAggregates}・マイグレーション ${PROJECT_STATS.migrations} 本`}
          />
          <Figure
            label="ルート"
            value={`${PROJECT_STATS.pageRoutes} ページ / ${PROJECT_STATS.apiRoutes} API`}
            note={`ワークスペース ${PROJECT_STATS.workspaces} 個`}
          />
          <Figure
            label="コミット"
            value={fmtN(PROJECT_STATS.commits)}
            note={`${PROJECT_STATS.firstCommit} 〜`}
          />
        </div>
        <p className="text-xs text-on-surface-variant">
          カバレッジの内訳はソース別・都道府県別に{' '}
          <Link href="/coverage" className="text-primary hover:underline">
            /coverage
          </Link>{' '}
          で公開しています。データソースの一覧と名寄せの仕組みは{' '}
          <Link href="/sources" className="text-primary hover:underline">
            /sources
          </Link>{' '}
          に。
        </p>
      </Section>

      <Section id="work" eyebrow="Work" title="お願いしたいこと">
        <p className="text-sm text-on-surface-variant mb-4">
          上から順に、いま効くものです。1 つ目だけでも大歓迎です。
        </p>
        <ol className="space-y-3">
          {[
            {
              title: '新しいデータソースのアダプタを書く',
              body: '未カバーの県・企業局・土地改良区・電力会社などの公開ページを 1 つ選び、取り込みタスクを 1 本足す。既存タスクがほぼテンプレートになっているので、パターンは真似できます。いま特に手つかずなのは県の農林水産部局が出している農業用ダムのデータです。',
            },
            {
              title: '公開されている実測データソースを探す',
              body: 'コードを書かなくてもいい仕事です。「この県のこのページに貯水率が載っている」という報告そのものが価値になります。Discord に投げてもらえれば、実装は私がやります。',
            },
            {
              title: 'ダムの名寄せ精度を上げる',
              body: '国土数値情報・ダム便覧・各県サイトの間に共通 ID がなく、名前と座標で突き合わせています。（元）（再）付きの再開発ダムや、同名別ダムの誤マッチが残っています。',
            },
            {
              title: '取り込みの信頼性を上げる',
              body: '上流のフォーマットは予告なく変わります。壊れたことを検知する仕組み、欠測と外れ値の扱い、リトライまわりの改善。',
            },
            {
              title: 'フロントエンド・可視化',
              body: 'ダム詳細のチャート、地図、統計ページの改善。デザインの提案も歓迎します。',
            },
          ].map((w, i) => (
            <li
              key={w.title}
              className="flex gap-4 bg-white border border-outline-variant rounded-xl p-4"
            >
              <span className="shrink-0 w-7 h-7 rounded-full bg-primary/10 text-primary font-semibold text-sm inline-flex items-center justify-center tabular-nums">
                {i + 1}
              </span>
              <div>
                <div className="font-semibold text-sm mb-1">{w.title}</div>
                <p className="text-sm text-on-surface-variant leading-relaxed">{w.body}</p>
              </div>
            </li>
          ))}
        </ol>
      </Section>

      <Section id="stack" eyebrow="Stack" title="ソフトウェアスタック">
        <p className="text-sm text-on-surface-variant mb-5">
          Bun のワークスペースによるモノレポです。フロントエンドだけ、取り込みタスクだけ、
          という関わり方もできます。
        </p>
        <div className="space-y-6">
          {STACK.map((group) => (
            <div key={group.title}>
              <div className="eyebrow-muted mb-2">{group.title}</div>
              <div className="overflow-x-auto">
                <table className="w-full text-sm bg-white border border-outline-variant rounded-xl overflow-hidden">
                  <tbody>
                    {group.entries.map((e) => (
                      <tr
                        key={e.name}
                        className="border-t border-outline-variant/40 first:border-t-0"
                      >
                        <th
                          scope="row"
                          className="px-3 py-2 text-left font-semibold align-top whitespace-nowrap"
                        >
                          {e.name}
                        </th>
                        <td className="px-3 py-2 align-top font-code text-xs text-on-surface-variant whitespace-nowrap">
                          {e.version}
                        </td>
                        <td className="px-3 py-2 align-top text-on-surface-variant">{e.role}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </div>
          ))}
        </div>
        <div className="mt-5 bg-surface-container-low border border-outline-variant rounded-xl p-4 text-sm text-on-surface-variant leading-relaxed">
          <div className="font-semibold text-on-surface mb-1">開発の進め方</div>
          テストは先に書きます（bun test / Playwright）。lint と format は Biome、タスクは
          justfile、ローカル基盤は Docker Compose で{' '}
          <code className="font-code text-xs">just up</code> 一発です。本番の REST API は HAL+JSON
          で <code className="font-code text-xs">_links</code> を返す HATEOAS
          設計になっていて、仕様は{' '}
          <Link href="/api/docs" className="text-primary hover:underline">
            /api/docs
          </Link>{' '}
          で公開しています。リポジトリには LLM 向けのオンボーディング文書（AGENTS.md、docs/llm/）が
          揃っているので、初日から手は動かせるはずです。
        </div>
      </Section>

      <Section id="terms" eyebrow="Terms" title="条件（先に正直に書きます）">
        <div className="space-y-3">
          <div className="flex gap-3 bg-white border border-outline-variant rounded-xl p-4">
            <Scale
              className="text-on-surface-variant shrink-0 mt-0.5"
              size={18}
              aria-hidden="true"
            />
            <div className="text-sm leading-relaxed">
              <div className="font-semibold mb-1">金銭的な対価はありません</div>
              <span className="text-on-surface-variant">
                完全に<strong className="text-on-surface font-semibold">無償</strong>です。
                報酬・時給・成果報酬のいずれもお支払いできません。 サイト自体も無料で公開しており、
                収益はありません。
              </span>
            </div>
          </div>
          <div className="flex gap-3 bg-white border border-outline-variant rounded-xl p-4">
            <Lock
              className="text-on-surface-variant shrink-0 mt-0.5"
              size={18}
              aria-hidden="true"
            />
            <div className="text-sm leading-relaxed">
              <div className="font-semibold mb-1">GitHub のプライベートリポジトリです</div>
              <span className="text-on-surface-variant">
                ソースコードは公開していません。参加が決まった方を collaborator として
                招待します。ノルマや稼働時間の約束はありません。
              </span>
            </div>
          </div>
          <div className="flex gap-3 bg-white border border-outline-variant rounded-xl p-4">
            <Scale
              className="text-on-surface-variant shrink-0 mt-0.5"
              size={18}
              aria-hidden="true"
            />
            <div className="text-sm leading-relaxed">
              <div className="font-semibold mb-1">著作権・ライセンスは運営者に帰属します</div>
              <span className="text-on-surface-variant">
                コントリビューションを含め、コードの権利は基本的に運営者（{MAINTAINER.name}）
                に帰属する形にさせてください。ここに納得できない場合は、無理に参加しないでください。
                詳しい条件は参加前に Discord で個別にお伝えします。
              </span>
            </div>
          </div>
          <div className="flex gap-3 bg-white border border-outline-variant rounded-xl p-4">
            <Users
              className="text-on-surface-variant shrink-0 mt-0.5"
              size={18}
              aria-hidden="true"
            />
            <div className="text-sm leading-relaxed">
              <div className="font-semibold mb-1">お返しできるのは、名前を残すことです</div>
              <span className="text-on-surface-variant">
                貢献してくださった方は、
                <Link href="#contributors" className="text-primary hover:underline">
                  このページのコントリビューター欄
                </Link>
                に、
                <strong className="text-on-surface font-semibold">
                  このサイトが存続する限り掲載します
                </strong>
                。ご希望があればリンク先も併記します。
              </span>
            </div>
          </div>
        </div>
      </Section>

      <Section id="apply" eyebrow="Apply" title="応募・相談は Discord へ">
        <div className="bg-white border border-outline-variant rounded-xl p-5">
          <p className="text-sm leading-relaxed mb-4">
            <strong>
              応募も、その前の相談も、窓口は{' '}
              <a
                href={DISCORD_INVITE}
                target="_blank"
                rel="noopener noreferrer"
                className="text-primary hover:underline"
              >
                Discord
              </a>{' '}
              の一本です。
            </strong>
            <span className="text-on-surface-variant">
              {' '}
              応募フォームもメール窓口もありません。来て、ひとこと声をかけてください。
            </span>
          </p>
          <p className="text-sm text-on-surface-variant leading-relaxed mb-4">
            経歴書は不要です。GitHub
            アカウントと、興味のある領域（上の「お願いしたいこと」のどれか）だけ
            教えてもらえれば十分です。「やれるか分からないので先に話を聞きたい」「この県のデータ、
            ここに落ちてますよ」という段階の連絡も歓迎します。
          </p>
          <a
            className="btn-primary text-sm"
            href={DISCORD_INVITE}
            target="_blank"
            rel="noopener noreferrer"
          >
            <MessageCircle size={16} aria-hidden="true" />
            Discord に参加する
          </a>
        </div>
      </Section>

      <Section id="donate" eyebrow="Donate" title="寄付でも助かります">
        <div className="bg-white border border-outline-variant rounded-xl p-5">
          <p className="text-sm text-on-surface-variant leading-relaxed mb-4">
            コードを書く時間はないけれど応援したい、という方は{' '}
            <strong className="text-on-surface font-semibold">GitHub Sponsors</strong>{' '}
            から支援していただけます。 サーバー代・ドメイン・データ取得にかかる実費に充てます。
            金額の多寡にかかわらず、継続の後押しになります。
          </p>
          <a
            className="btn-primary text-sm"
            href={MAINTAINER.sponsorsUrl}
            target="_blank"
            rel="noopener noreferrer"
          >
            <HandHeart size={16} aria-hidden="true" />
            GitHub Sponsors (@{MAINTAINER.github})
          </a>
        </div>
      </Section>

      <Section id="contributors" eyebrow="Credits" title="コントリビューター">
        <p className="text-sm text-on-surface-variant mb-4">
          このサイトに貢献してくださった方々です。サイトが存続する限り掲載します。
        </p>
        {CONTRIBUTORS.length === 0 ? (
          <div className="border border-dashed border-outline-variant rounded-xl p-6 text-center">
            <Users className="mx-auto mb-3 text-on-surface-variant" size={24} aria-hidden="true" />
            <p className="text-sm text-on-surface-variant leading-relaxed">
              まだ一人もいません。
              <br />
              <strong className="text-on-surface font-semibold">
                最初の名前が、ここに入ります。
              </strong>
            </p>
          </div>
        ) : (
          <ul className="space-y-2">
            {CONTRIBUTORS.map((c) => {
              const href = c.url ?? (c.github ? `https://github.com/${c.github}` : undefined);
              return (
                <li
                  key={c.name}
                  className="bg-white border border-outline-variant rounded-xl p-4 flex flex-wrap items-baseline gap-x-3 gap-y-1"
                >
                  <span className="font-semibold text-sm">
                    {href ? (
                      <a
                        href={href}
                        target="_blank"
                        rel="noopener noreferrer"
                        className="text-primary hover:underline"
                      >
                        {c.name}
                      </a>
                    ) : (
                      c.name
                    )}
                  </span>
                  <span className="text-xs text-on-surface-variant tabular-nums">{c.since} 〜</span>
                  <span className="text-sm text-on-surface-variant w-full">{c.work}</span>
                </li>
              );
            })}
          </ul>
        )}
        <div className="mt-6 flex items-start gap-3 text-xs text-on-surface-variant">
          <GitBranch className="shrink-0 mt-0.5" size={14} aria-hidden="true" />
          <p className="leading-relaxed">
            運営者は{' '}
            <a
              href={`https://github.com/${MAINTAINER.github}`}
              target="_blank"
              rel="noopener noreferrer"
              className="text-primary hover:underline"
            >
              @{MAINTAINER.name}
            </a>{' '}
            です。進捗と方針は{' '}
            <Link href="/roadmap" className="text-primary hover:underline">
              ロードマップ
            </Link>{' '}
            に、達成状況は{' '}
            <Link href="/coverage" className="text-primary hover:underline">
              カバレッジ
            </Link>{' '}
            に随時反映しています。
          </p>
        </div>
      </Section>

      <div className="border-t border-outline-variant pt-6 flex items-center gap-3 text-sm">
        <Database className="text-on-surface-variant shrink-0" size={18} aria-hidden="true" />
        <p className="text-on-surface-variant leading-relaxed">
          データだけ使いたい方へ — API は無料で、サインイン後に 600 req/min まで使えます。{' '}
          <Link href="/api/docs" className="text-primary hover:underline">
            API ドキュメント
          </Link>
          をどうぞ。
        </p>
      </div>
    </div>
  );
}
