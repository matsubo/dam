# CODEMAP — file index

One-line summary of every source file. Skim this to locate code; jump to
the file for detail.

## Repo root

| Path | Purpose |
|---|---|
| `AGENTS.md` | LLM orientation; read first |
| `CLAUDE.md` | (in `~/.claude/`) workspace-global rules — coding style, git workflow |
| `package.json` | Bun workspace root; `lint` / `typecheck` / `test` / `e2e` scripts |
| `tsconfig.base.json` | shared strict TS config (NoUncheckedIndexedAccess, exactOptional) |
| `biome.json` | lint + format config |
| `playwright.config.ts` | spawns dev server on 3031 unless `E2E_BASE_URL` is set |
| `justfile` | infra + import + test recipes |
| `docker-compose.yml` | local Postgres (port 5433) + MinIO (9000) |
| `.env.example` | DATABASE_URL, S3_*, NEXT_PUBLIC_SITE_URL, API_AUTH_BYPASS |
| `.github/workflows/ci.yml` | lint+typecheck+migrate+unit+E2E with TimescaleDB-HA service |

## apps/web (Next.js)

### Pages

| Path | Renders |
|---|---|
| `app/layout.tsx` | nav + footer + metadata defaults |
| `app/page.tsx` | home: counts + 6 largest dams + map CTA |
| `app/dams/page.tsx` | dam list table with pref/watershed filter |
| `app/dams/[slug]/page.tsx` | dam detail (stat block, ObservationChart, watershed section, nearby) |
| `app/watersheds/page.tsx` | watershed list grouped by kind |
| `app/watersheds/[slug]/page.tsx` | watershed detail with aggregate + dam list |
| `app/prefectures/[code]/page.tsx` | prefecture-scoped dam list |
| `app/map/page.tsx` | server fetches all coords, JapanMap renders client-side |
| `app/sources/page.tsx` | data-source transparency table |
| `app/contribute/page.tsx` | contributor recruitment: history, live scale figures, stack, terms, credits |
| `app/api/docs/page.tsx` | Swagger UI on `/api/v1/openapi.json` |
| `app/sitemap.ts` | dynamic sitemap (dams + watersheds + prefectures) |
| `app/robots.ts` | allows everything except `/api/` |
| `app/not-found.tsx` | 404 page |
| `app/error.tsx` | client error boundary |

### API routes (all under `app/api/v1/`)

| Path | Method | Notes |
|---|---|---|
| `healthz/route.ts` | GET | DB ping; HAL+JSON; **no auth** |
| `sources/route.ts` | GET | source_priorities ⨝ raw_snapshots; **no auth** |
| `watershed/route.ts` | GET | point-in-polygon; auth required |
| `dams/route.ts` | GET | list with filter+cursor |
| `dams/[slug]/route.ts` | GET | detail + latest + nearby |
| `dams/[slug]/observations/route.ts` | GET | time-series (hourly/daily/monthly) |
| `watersheds/route.ts` | GET | list |
| `watersheds/[slug]/route.ts` | GET | detail |
| `watersheds/[slug]/aggregate/route.ts` | GET | totals |
| `watersheds/[slug]/dams/route.ts` | GET | scoped dam list |
| `prefectures/[code]/dams/route.ts` | GET | scoped dam list |
| `openapi.json/route.ts` | GET | OpenAPI 3.1 spec |

### Components

| File | Type | Used by |
|---|---|---|
| `components/nav.tsx` | server | layout |
| `components/breadcrumbs.tsx` | server (with JSON-LD) | every detail page |
| `components/dam-table.tsx` | server | /dams, /prefectures, /watersheds/[slug] |
| `components/dam-card.tsx` | server | home, /dams/[slug] (nearby + watershed) |
| `components/pagination.tsx` | server | /dams (cursor-based) |
| `components/quality-badge.tsx` | server | dam detail latest-obs header |
| `components/observation-chart.tsx` | **client** | dam detail; ECharts via dynamic import |
| `components/japan-map.tsx` | **client** | /map; Leaflet via dynamic import |

### Lib

| File | Purpose |
|---|---|
| `lib/api/auth.ts` | `authorize(req)` API key + per-key rate limit |
| `lib/api/error.ts` | HttpError + RFC 7807 problem+json response |
| `lib/api/response.ts` | `hal(body, links, init)` wraps JSON with HAL |
| `lib/api/pagination.ts` | `pageLinks` + RFC 5988 Link header |
| `lib/format.ts` | `fmtN`, `fmtPct`, `fmtDate`, `fmtCapacityMcm` |
| `lib/project-stats.ts` | hand-maintained codebase figures + stack table for `/contribute` (regen commands in the header) |
| `lib/contributors.ts` | permanent contributor credits list rendered at `/contribute#contributors` |

### One-off scripts (`apps/web/bin/`, run from repo root)

| File | Purpose |
|---|---|
| `import_real_ndi_w01.ts` | NLNI W01 (real schema) → `dams` master |
| `import_watersheds_from_w01.ts` | unique W01_003 names → `watersheds` master (boundary NULL) |
| `import_real_ndi_w07.ts` | per-mesh dissolved GeoJSONs → cross-mesh `boundary` backfill |
| `classify_watershed_kind.ts` | 水系域コード codelist + W05 区間種別 → `kind` / `ndi_code` migration (`bin/fetch_w05.sh` first) |
| `capture_damnet.ts` | probe `dambinran` post-id range → `dams.jsonl` |
| `match_damnet.ts` | match dams.jsonl → master, fill kana/manager/year, repair slugs |
| `repair_dam_slugs.ts` | recompute kana-romaji slugs after kana lands |
| `seed_synthetic_observations.ts` | 30 d hourly + ~5 yr daily synth → `observations` |

## apps/worker

| File | Purpose |
|---|---|
| `src/index.ts` | graphile-worker entry; registers tasks + crontab |
| `src/crontab.ts` | cron schedule (colon-separated task names) |
| `src/tasks/master_refresh_ndi.ts` | monthly NLNI reimport |
| `src/tasks/master_refresh_damnet.ts` | monthly damnet attribute pass |
| `src/tasks/master_match.ts` | nightly reconciliation rerun |
| `src/tasks/ingest_kasenbosai.ts` | hourly realtime ingest (synth) |
| `src/tasks/backfill_suimon_enqueue.ts` | populate backfill_progress |
| `src/tasks/backfill_suimon_run.ts` | drain backfill queue every 5 min |
| `src/tasks/quality_recompute.ts` | nightly missing/mismatch flagging |

## packages/core (zero dependencies)

| File | Public exports |
|---|---|
| `src/slug.ts` | `toSlug`, `suffixedSlug` |
| `src/prefectures.ts` | `PREFECTURES` array, `prefNameToCode` |
| `src/source_adapter.ts` | `SourceAdapter`, `FetchTarget`, `RawBytes`, `ParsedReading`, `FetchContext` |
| `src/http_client.ts` | `HttpClient` (throttle + retry + ETag) |
| `src/hateoas.ts` | `buildLinks`, `Link`, `LinksInput` |
| `src/similarity.ts` | `trigramSimilarity`, `normalizeJaName` |

## packages/db

### Migrations

```
0000_extensions.sql          postgis, timescaledb, pgcrypto, pg_trgm
0001_master.sql              dams, watersheds, rivers, match_review + updated_at trigger
0002_indexes.sql             GiST on geom, GIN on trigram, btree on filters
0003_external_ids_unique.sql partial unique idx for external_ids->>'ndi' and ->>'damnet'
0010_graphile_worker.sql     placeholder; graphile-worker installs its own schema on 1st run
0011_observations.sql        hypertable; PK (dam_id, observed_at, source_id)
0012_raw_snapshots.sql       raw ledger + FK from observations
0013_source_priorities.sql   seed (kasenbosai 100, suimon 90, ndi 80, damnet 50)
0014_observation_indexes.sql btree (dam_id, observed_at) + columnar compression policy
0015_continuous_aggregates.sql obs_daily, obs_monthly with refresh policies
0016_backfill_progress.sql   year×dam queue with status
0017_api_keys.sql            api_keys (sha256 hash) + api_key_usage (per-minute bucket)
0018_watersheds_boundary_nullable.sql  ALTER … DROP NOT NULL on boundary
0020_quality_view.sql        quality_missing_24h view
```

### Schemas

| File | Mirrors |
|---|---|
| `src/schema/dams.ts` | `dams` |
| `src/schema/watersheds.ts` | `watersheds` |
| `src/schema/rivers.ts` | `rivers` |
| `src/schema/match_review.ts` | `match_review` |
| `src/schema/observations.ts` | `observations` (hypertable) |
| `src/schema/raw_snapshots.ts` | `raw_snapshots` |
| `src/schema/source_priorities.ts` | `source_priorities` |
| `src/schema/backfill_progress.ts` | `backfill_progress` |
| `src/schema/api_keys.ts` | `api_keys`, `api_key_usage` |
| `src/schema/index.ts` | re-exports all of the above |

### Repositories

| File | Functions |
|---|---|
| `src/repo/dams.ts` | `upsertDamByExternalId`, `findDamBySlug`, `latestObservation`, `nearbyDams`, `listDams` (orderBy: id\|capacity), `takenSlugs`, `appendExternalId`, `applyDamnetAttributes`, `findDamsForReconciliation` |
| `src/repo/watersheds.ts` | `upsertWatershed`, `findWatershedBySlug`, `findWatershedContaining`, `findNearestWatershed`, `listWatersheds`, `aggregateWatershed` |
| `src/repo/match_review.ts` | `enqueueMatchReview` |
| `src/repo/observations.ts` | `upsertObservations`, `findSeries{Hourly,Daily,Monthly}` |
| `src/repo/raw_snapshots.ts` | `recordRawSnapshot`, `markParsed`, `markParseError`, `previousEtag` |
| `src/repo/source_priorities.ts` | `preferredSource`, `priorityMap` |
| `src/repo/backfill_progress.ts` | `nextPending`, `startRunning`, `complete`, `fail`, `enqueueAllDams` |
| `src/repo/api_keys.ts` | `issueKey`, `lookupByPrefix`, `revoke`, `recordUsage`, `usageInLastMinute`, `usageToday`, `hashKey`, `touchLastUsed` |
| `src/migrate.ts` | numbered-SQL runner, ENOENT-tolerant |
| `src/client.ts` | postgres.js singleton with bigint round-trip |

## packages/storage

| File | Purpose |
|---|---|
| `src/client.ts` | S3Client configured for MinIO (path-style URLs) |
| `src/snapshot_store.ts` | `rawSnapshotKey`, `putSnapshot`, `getSnapshot` |

## packages/ingest

| File | Purpose |
|---|---|
| `src/pipeline.ts` | `runIngestForAdapter(adapter, ctx)` end-to-end |
| `src/quality.ts` | `QualityFlag` bits, `isPhysicallyValid`, `detectOutlier` |

## packages/reconciler

| File | Purpose |
|---|---|
| `src/score.ts` | `scoreCandidate({nameSim, distanceM, managerMatch})` weighted score |
| `src/match.ts` | `matchDam(record)` candidate query + scoring + threshold |

## packages/adapters

| Subdir | Conforms to SourceAdapter? | Schedule | Notes |
|---|---|---|---|
| `ndi/` | yes (T8 of Plan 4) | on-demand | W01 dams + W07 watershed boundaries |
| `damnet/` | yes | on-demand | Old `damnet.or.jp` adapter; the live data comes from `bin/capture_damnet.ts` against the new `dambinran.damnet.or.jp` JSON API |
| `kasenbosai/` | yes | hourly | XML parser; production endpoint blocks scrapers (synthetic seed in use) |
| `suimon/` | yes | on-demand | CSV parser; deferred (EUC-JP HTML form) |

## tests

| Path | What it covers |
|---|---|
| `packages/*/src/**/*.test.ts` | unit + integration; 85 tests, 26 files |
| `tests/integration/helpers.ts` | `withTestDb` per-call transaction helper |
| `tests/e2e/api.spec.ts` | HAL+JSON shape, sitemap, robots, 400/404 |
| `tests/e2e/home.spec.ts` | home headline + nav |
| `tests/e2e/dams.spec.ts` | list + detail + 404 + structured data |
| `tests/e2e/watersheds.spec.ts` | list + detail + prefecture |
| `tests/e2e/qa-walk.spec.ts` | full-page screenshot + console-error scan over 12 pages |

## docs

| Path | Audience |
|---|---|
| `AGENTS.md` | LLM agents (read first) |
| `docs/llm/PROJECT_OVERVIEW.md` | architecture in two pages |
| `docs/llm/CODEMAP.md` | this file |
| `docs/llm/DATA_FLOW.md` | how facts move from upstream to chart |
| `docs/llm/RUNBOOK.md` | operations (deploy, restart, restore, debug) |
| `docs/llm/CONVENTIONS.md` | coding style, commit format, test patterns |
| `docs/superpowers/specs/*` | product/architecture (canonical) |
| `docs/superpowers/plans/*` | implementation plans |

## deploy

| Path | Purpose |
|---|---|
| `deploy/coolify/Dockerfile.web` | multi-stage Bun build for Next |
| `deploy/coolify/Dockerfile.worker` | thin Bun image for graphile-worker |
| `deploy/coolify/docker-compose.coolify.yml` | full stack with healthchecks |
| `deploy/coolify/README.md` | first-time bring-up |
| `deploy/backup/pgbackrest.conf` | full+diff schedule, S3 destination, AES-256 |
| `deploy/ops/runbook.md` | operator runbook (302 lines) |
