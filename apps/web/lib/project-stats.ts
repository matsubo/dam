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
//   workspaces         ls -d apps/*/ packages/*/ packages/adapters/*/ | wc -l
//   workerTasks        ls apps/worker/src/tasks | grep -v '\.test\.' | wc -l
//   ingestTasks        ls apps/worker/src/tasks | grep '^ingest_' | grep -v '\.test\.' | wc -l
//   cronEntries        grep -cE '^[0-9*]' apps/worker/src/crontab.ts
//   apiRoutes          find apps/web/app/api -name route.ts | wc -l
//   pageRoutes         find apps/web/app -name page.tsx | wc -l
//
// Last regenerated: 2026-09-09 (c562c7d).
export const PROJECT_STATS = {
  measuredOn: '2026-09-09',
  commits: 329,
  firstCommit: '2026-05-01',
  tsLines: 50_253,
  tsFiles: 385,
  sqlLines: 1_276,
  testFiles: 120,
  migrations: 35,
  workspaces: 11,
  workerTasks: 86,
  ingestTasks: 69,
  cronEntries: 80,
  apiRoutes: 16,
  pageRoutes: 20,
  /** Base tables in packages/db/migrations. `observations` is a hypertable. */
  tables: 10,
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
 * The stack, read off apps/*&#47;package.json, packages/*&#47;package.json and
 * deploy/coolify/docker-compose.legacy.yaml. Keep the versions verbatim — a contributor sizing up
 * the work needs to know it's Next 15 / React 19, not "recent Next".
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
      { name: 'TypeScript', version: '^5.6', role: '全パッケージ strict モード' },
      { name: 'Biome', version: '^1.9', role: 'lint + format（ESLint / Prettier は不使用）' },
    ],
  },
  {
    title: 'Web (apps/web)',
    entries: [
      { name: 'Next.js', version: '^15 (App Router)', role: 'SSR ページ + REST API ルート' },
      { name: 'React', version: '^19', role: 'UI。ページは原則サーバーコンポーネント' },
      { name: 'Tailwind CSS', version: '^3.4', role: 'Material Design 3 風のトークンセット' },
      { name: 'Leaflet', version: '^1.9', role: '地図（地理院タイル）' },
      { name: 'NextAuth.js', version: '^5.0.0-beta', role: 'Google サインイン → API キー発行' },
      { name: 'Redoc', version: '—', role: '/api/docs の OpenAPI レンダリング' },
    ],
  },
  {
    title: 'データ基盤',
    entries: [
      {
        name: 'PostgreSQL + TimescaleDB',
        version: 'timescale/timescaledb-ha:pg16-all',
        role: '観測値は hypertable。obs_daily / obs_monthly の連続集計と圧縮ポリシー付き',
      },
      { name: 'PostGIS', version: 'pg16 同梱', role: '流域ポリゴンの point-in-polygon 検索' },
      { name: 'postgres.js', version: '^3.4', role: '生 SQL クライアント。ORM は原則使わない' },
      { name: 'Drizzle ORM', version: '^0.36', role: 'スキーマ定義と型の出どころのみ' },
      {
        name: 'MinIO / S3',
        version: 'AWS SDK ^3.66',
        role: '取得した生レスポンスのスナップショット保管',
      },
    ],
  },
  {
    title: 'ワーカー (apps/worker)',
    entries: [
      {
        name: 'graphile-worker',
        version: '^0.16',
        role: 'Postgres 上のジョブキュー。cron・リトライ・バックフィルを担当',
      },
      { name: 'Zod', version: '^3.23', role: 'スクレイプ結果のスキーマ検証' },
    ],
  },
  {
    title: '品質・運用',
    entries: [
      { name: 'bun test', version: '—', role: 'ユニット・結合テスト' },
      { name: 'Playwright', version: '^1.59', role: 'E2E' },
      { name: 'Docker Compose', version: '—', role: 'ローカル基盤（db + minio）' },
      { name: 'Coolify', version: '—', role: '本番デプロイ（セルフホスト PaaS）' },
      { name: 'GitHub Actions', version: '—', role: 'CI: typecheck / lint / test' },
      { name: 'just', version: '—', role: 'タスクランナー（justfile）' },
    ],
  },
];
