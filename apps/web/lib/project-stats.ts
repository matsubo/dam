// Codebase-side figures rendered on /contribute.
//
// These describe the *repository*, not the data, so they can't come from a
// query — they're refreshed by hand when the page is next touched. Every
// value below has the exact command that produced it, so regenerating is
// mechanical rather than a guess. Run them from the repo root.
//
//   commits            git rev-list --count HEAD
//   firstCommit        git log --reverse --format=%ad --date=short | head -1
//   tsLines            git ls-files '*.ts' '*.tsx' | xargs wc -l | tail -1
//   tsFiles            git ls-files '*.ts' '*.tsx' | wc -l
//   sqlLines           git ls-files '*.sql' | xargs wc -l | tail -1
//   testFiles          git ls-files '*.test.ts' '*.test.tsx' '*.spec.ts' | wc -l
//   migrations         ls packages/db/migrations | wc -l
//   workspaces         git ls-files 'apps/*/package.json' 'packages/*/package.json' | wc -l
//   workerTasks        ls apps/worker/src/tasks | grep -v '\.test\.' | wc -l
//   ingestTasks        ls apps/worker/src/tasks | grep '^ingest_' | grep -v '\.test\.' | wc -l
//   cronEntries        grep -cE '^[0-9*]' packages/core/src/crontab.ts
//   apiRoutes          find apps/web/app/api -name route.ts | wc -l
//   pageRoutes         find apps/web/app -name page.tsx | wc -l
//   tables             grep -hoiE '^CREATE TABLE( IF NOT EXISTS)? [a-z_]+' packages/db/migrations/*.sql
//                        | awk '{print $NF}' | sort -u | grep -vx observations | wc -l
//   continuousAggregates
//                      grep -hoiE '^CREATE MATERIALIZED VIEW( IF NOT EXISTS)? [a-z_]+' packages/db/migrations/*.sql
//                        | awk '{print $NF}' | sort -u | wc -l
//
// `workspaces` counts package.json files (git's `*` crosses `/`, so this also
// finds packages/adapters/*); listing directories would count packages/adapters/
// itself, which is not a workspace. `tables` leaves out
// `observations`, which the page adds on its own as "+ hypertable 1".
//
// Last regenerated: 2026-09-28 on develop 8d7d1d8 (round 5 merged);
// workerTasks / ingestTasks / cronEntries re-counted on develop b36c2a1
// (round 9 merged).
export const PROJECT_STATS = {
  measuredOn: '2026-09-28',
  commits: 643,
  firstCommit: '2026-05-01',
  tsLines: 71_141,
  tsFiles: 497,
  sqlLines: 3_790,
  testFiles: 186,
  migrations: 70,
  workspaces: 11,
  workerTasks: 126,
  ingestTasks: 108,
  cronEntries: 118,
  apiRoutes: 18,
  pageRoutes: 22,
  /** Base tables in packages/db/migrations, not counting the `observations` hypertable. */
  tables: 11,
  /** obs_daily + obs_monthly. */
  continuousAggregates: 2,
} as const;

export interface StackEntry {
  /** Package or product name, as it appears in package.json / the image tag. */
  name: string;
  /** Version constraint or image tag — verbatim from the manifest. */
  version: string;
  /** What it does *here*, not what it does in general. */
  role: string;
}

export interface StackGroup {
  title: string;
  entries: StackEntry[];
}

/**
 * The stack, read off apps/*&#47;package.json, packages/*&#47;package.json,
 * deploy/k8s.yaml and deploy/postgres/Dockerfile. Keep the versions verbatim — a contributor
 * sizing up the work needs to know it's Next 16 / React 19, not "recent Next".
 */
export const STACK: StackGroup[] = [
  {
    title: 'ランタイム・言語',
    entries: [
      {
        name: 'Bun',
        version: '>=1.1 (本番は 1.4 固定)',
        role: 'パッケージ管理・実行・テストランナー',
      },
      { name: 'Node.js', version: '>=24', role: 'Next.js のビルド互換用' },
      { name: 'TypeScript', version: '^7.0', role: '全パッケージ strict モード' },
      { name: 'Biome', version: '^2.5', role: 'lint + format（ESLint / Prettier は不使用）' },
    ],
  },
  {
    title: 'Web (apps/web)',
    entries: [
      { name: 'Next.js', version: '^16 (App Router)', role: 'SSR ページ + REST API ルート' },
      { name: 'React', version: '^19', role: 'UI。ページは原則サーバーコンポーネント' },
      { name: 'Tailwind CSS', version: '^4.3', role: 'Material Design 3 風のトークンセット' },
      { name: 'Leaflet', version: '^1.9', role: '地図（地理院タイル）' },
      { name: 'NextAuth.js', version: '^5.0.0-beta', role: 'Google サインイン → API キー発行' },
      { name: 'Zod', version: '^4.6', role: 'REST API のクエリパラメータ検証' },
      { name: 'Redoc', version: '^2.5', role: '/api/docs の OpenAPI レンダリング' },
    ],
  },
  {
    title: 'データ基盤',
    entries: [
      {
        name: 'PostgreSQL + TimescaleDB',
        version: 'PostgreSQL 18.6 + TimescaleDB 2.30.2',
        role: '観測値は hypertable。obs_daily / obs_monthly の連続集計と圧縮ポリシー付き',
      },
      { name: 'PostGIS', version: '3.6.4', role: '流域ポリゴンの point-in-polygon 検索' },
      { name: 'postgres.js', version: '^3.4', role: '生 SQL クライアント。ORM は原則使わない' },
      { name: 'Drizzle ORM', version: '^0.45', role: 'スキーマ定義と型の出どころのみ' },
    ],
  },
  {
    title: 'ワーカー (apps/worker)',
    entries: [
      {
        name: 'graphile-worker',
        version: '^0.18',
        role: 'Postgres 上のジョブキュー。cron・リトライ・バックフィルを担当',
      },
    ],
  },
  {
    title: '本番インフラ',
    entries: [
      {
        name: 'k3s',
        version: '—',
        role: '自宅クラスタ（namespace dam）。web は 2 レプリカをノードに分散し PodDisruptionBudget で無停止更新、worker は 1 レプリカ',
      },
      { name: 'Traefik', version: '—', role: 'Ingress（k3s 同梱）' },
      {
        name: 'CloudNativePG',
        version: '—',
        role: 'PostgreSQL クラスタ dam-pg18 をプライマリ + スタンバイの 2 インスタンスで冗長化。アプリは Service dam-postgres-rw 経由で常に現プライマリへ接続。日次でボリュームスナップショットを取得',
      },
      {
        name: 'GHCR',
        version: '—',
        role: 'dam-web / dam-worker / dam-postgres（TimescaleDB・PostGIS 入り）のイメージ',
      },
      { name: 'Cloudflare', version: '—', role: 'CDN。デプロイ後にホスト単位でキャッシュをパージ' },
    ],
  },
  {
    title: '品質・運用',
    entries: [
      { name: 'bun test', version: '—', role: 'ユニット・結合テスト' },
      { name: 'Playwright', version: '^1.63', role: 'E2E' },
      { name: 'Docker Compose', version: '—', role: 'ローカル基盤（db）' },
      {
        name: 'GitHub Actions',
        version: '—',
        role: 'CI: typecheck / lint / test。main への push でイメージをビルドし Tailscale 経由で k3s へデプロイ',
      },
      { name: 'just', version: '—', role: 'タスクランナー（justfile）' },
    ],
  },
];
