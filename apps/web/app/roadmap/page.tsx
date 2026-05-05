import { CircleCheck, CircleDashed, CircleDot } from 'lucide-react';
import type { Metadata } from 'next';
import { Breadcrumbs } from '../../components/breadcrumbs.tsx';
import { APP_STAGE, APP_VERSION } from '../../lib/version.ts';

export const revalidate = 86400;
export const metadata: Metadata = {
  title: 'ロードマップ',
  description:
    'Dam Data Platform の運用ロードマップ。アルファ・ベータ・正式リリースの各段階で達成するゴール。',
};

interface Stage {
  key: 'alpha' | 'beta' | 'ga';
  badge: string;
  title: string;
  goal: string;
  bullets: string[];
}

const STAGES: Stage[] = [
  {
    key: 'alpha',
    badge: 'Alpha',
    title: 'アルファ',
    goal: 'セットアップと定期データ取得の正常化',
    bullets: [
      '初期セットアップ — マスタ (ダム/水系/河川) が production に正しく投入され、起動シーケンスが冪等に動作する',
      '定期クロールの正常化 — graphile-worker の cron が NDI / ダム便覧 / 観測値ソースを安定して取り込み、失敗時のリトライ・キュー詰まり対応が確認できている',
      '画面の主要動線 — 一覧 / 詳細 / 地図 / 統計 / API ドキュメントが本番で 200 を返し、貯水率を含む基本的な可視化がレンダリングされる',
    ],
  },
  {
    key: 'beta',
    badge: 'Beta',
    title: 'ベータ',
    goal: 'データの正確性の担保',
    bullets: [
      '名寄せ精度 — NDI / ダム便覧 / 川の防災情報 / 水文水質データベースの ID マッチを review_enqueued まで含め、誤マッチを ≤0.5% に抑制',
      '欠測・外れ値の扱い — quality_flag の付与ルールを文書化し、API レスポンスでも返す。明確な欠測区間はチャートで描画しない',
      '一次情報との突合 — サンプル抽出による参照ダムで、当サイトの値と一次情報の差分が許容誤差内であることを継続的に監視',
      '履歴データの再現性 — 過去取り込みデータの補正ロジック (compaction / 単位変換) を public な変更履歴として記録',
    ],
  },
  {
    key: 'ga',
    badge: 'GA',
    title: '正式リリース',
    goal: '第三者へサービスとして提供できる品質',
    bullets: [
      'レスポンスタイム SLA — 主要エンドポイントの p95 / p99 を公開ダッシュボードで明示し、各エンドポイントに目標値を設定',
      'データ正確性の根拠 — 各データポイントに source_id / observed_at / quality_flag を必ず添付し、データソースの権威性を /sources で説明',
      'インフラの安定化 — DB バックアップ / 監視 / アラート / 障害時のオンコール体制 / 計画停止のアナウンス手順を整備',
      'API 利用規約と SLA — 第三者統合に向けた利用規約・課金 (もしあれば) ・互換性ポリシー (deprecation notice 期間など) を整備',
    ],
  },
];

function StageIcon({ status }: { status: 'in_progress' | 'pending' | 'done' }) {
  if (status === 'done') return <CircleCheck className="text-emerald-600 shrink-0" size={22} aria-hidden="true" />;
  if (status === 'in_progress') return <CircleDot className="text-primary shrink-0" size={22} aria-label="進行中" />;
  return <CircleDashed className="text-on-surface-variant shrink-0" size={22} aria-hidden="true" />;
}

function statusFor(stage: Stage['key']): 'in_progress' | 'pending' | 'done' {
  const order = { alpha: 0, beta: 1, ga: 2 } as const;
  if (order[stage] < order[APP_STAGE]) return 'done';
  if (order[stage] === order[APP_STAGE]) return 'in_progress';
  return 'pending';
}

export default function RoadmapPage() {
  return (
    <div className="max-w-3xl mx-auto px-5 md:px-10 py-8">
      <Breadcrumbs items={[{ label: 'ホーム', href: '/' }, { label: 'ロードマップ' }]} />
      <h1 className="text-2xl font-semibold mb-2">ロードマップ</h1>
      <p className="text-sm text-on-surface-variant mb-6">
        現在のバージョン{' '}
        <span className="font-mono font-semibold text-on-surface">v{APP_VERSION}</span> ／ ステージ{' '}
        <span className="font-semibold text-primary uppercase">{APP_STAGE}</span>
        。本サービスは現在アルファ段階です。
      </p>
      <ol className="space-y-6">
        {STAGES.map((s) => {
          const status = statusFor(s.key);
          return (
            <li
              key={s.key}
              className={`border rounded-2xl p-5 ${
                status === 'in_progress'
                  ? 'border-primary bg-primary/5'
                  : status === 'done'
                    ? 'border-outline-variant bg-surface-container-low'
                    : 'border-outline-variant'
              }`}
            >
              <div className="flex items-center gap-3 mb-2">
                <StageIcon status={status} />
                <span className="text-xs uppercase tracking-widest font-semibold text-on-surface-variant">
                  {s.badge}
                </span>
                <h2 className="text-lg font-semibold">{s.title}</h2>
                {status === 'in_progress' ? (
                  <span className="ml-auto text-xs px-2 py-0.5 rounded-full bg-primary text-white">
                    進行中
                  </span>
                ) : null}
              </div>
              <p className="text-sm font-medium mb-3">
                <span className="text-on-surface-variant">ゴール: </span>
                <span className="text-on-surface">{s.goal}</span>
              </p>
              <ul className="list-disc list-outside pl-5 space-y-1.5 text-sm text-on-surface-variant">
                {s.bullets.map((b) => (
                  <li key={b}>{b}</li>
                ))}
              </ul>
            </li>
          );
        })}
      </ol>
      <p className="mt-8 text-xs text-on-surface-variant">
        日付や具体的なリリース時期は確約しません。コミュニティへの議論は{' '}
        <a
          href="https://discord.gg/UbWqspWbAk"
          target="_blank"
          rel="noopener noreferrer"
          className="text-primary hover:underline"
        >
          Discord
        </a>{' '}
        にて。
      </p>
    </div>
  );
}
