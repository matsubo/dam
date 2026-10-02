# Project Overview

Two-page summary of what's in this repo and why each piece exists.

## Goal

Be the most complete dam-reservoir dataset for Japan. Three concrete things
the project must do:

1. **Master**: enumerate every dam (2,754 on production, 2026-09-28) and every
   river system (644) with location, attributes, and a stable URL slug.
2. **Time-series**: store hourly reservoir observations (storage volume,
   storage rate, inflow, outflow, water level, rainfall) with provenance.
3. **Public surface**: serve a SEO-friendly website + a HATEOAS REST API
   that external consumers can rely on, plus a Japan map view.

Current state (production, 2026-09-28): master is loaded with real NLNI W01 +
Damnet data; watershed boundaries from NLNI W07 are loaded for 463/644
systems. Observations are real: 107 scheduled ingest tasks pull from 川の防災情報,
the MLIT regional bureaus, 水資源機構, prefectural river portals, agricultural
survey tables and water utilities. 72 sources wrote observations in the last
30 days, covering 975 dams; `/coverage` has the per-source breakdown.

## Architecture in one paragraph

Bun-based monorepo. Three apps (`apps/web` Next.js, `apps/worker`
graphile-worker, plus `bin/` admin scripts), and a set of `packages/*` for
shared concerns: db (schema + repo), core (types + utilities), adapters
(per-source crawlers), reconciler (cross-source name matching), ingest
(shared pipeline), storage (S3 client). Postgres 16 with TimescaleDB +
PostGIS extensions provides the time-series hypertable, continuous
aggregates (daily/monthly), and watershed-polygon geocoding. MinIO holds
raw scraped snapshots so we can re-parse without re-fetching.

## Package map

```
apps/
├── web/                    # Next.js 15 App Router
│   ├── app/                #  pages + API routes
│   ├── components/         #  shared UI (nav, dam-table, observation-chart, japan-map…)
│   ├── lib/                #  api helpers (auth, hateoas response, formatters)
│   └── bin/                #  one-off importers + seeders (run from repo root)
└── worker/                 # graphile-worker process
    └── src/tasks/          #  master:refresh:ndi, ingest:kasenbosai-v2, …

packages/
├── core/                   # zero-dep utilities + shared types
│   └── src/
│       ├── slug.ts         #  Hepburn romaji + sokuon/yōon handling
│       ├── prefectures.ts  #  47-prefecture lookup
│       ├── source_adapter.ts  # SourceAdapter interface
│       ├── http_client.ts  #  throttled+retrying fetcher with ETag
│       ├── hateoas.ts      #  _links builder
│       └── similarity.ts   #  trigram + Japanese name normalization
├── db/                     # the database layer
│   ├── migrations/         #  numbered SQL files; runner is bun run --filter @dam/db migrate
│   └── src/
│       ├── client.ts       #  postgres.js singleton (configured for bigint round-trip)
│       ├── schema/         #  Drizzle schema mirrors of every table
│       └── repo/           #  query functions; one file per resource
├── storage/                # S3-compatible MinIO client
├── ingest/                 # SourceAdapter → raw_snapshot → observation pipeline
├── reconciler/             # match incoming source records to existing dams
└── adapters/
    ├── ndi/                # NLNI W01 (dams) + W07 (watersheds)
    ├── damnet/             # ダム便覧 (dambinran.damnet.or.jp)
    ├── kasenbosai/         # 川の防災情報 SourceAdapter (the live feed is the ingest:kasenbosai-v2 task)
    └── suimon/             # 水文水質DB (deferred — EUC-JP form-based)
```

## Data model

```
dams           ── (PK id, slug uniq) ── point geom, total_capacity_m3, completed_year, external_ids JSONB
                                          ↓ FK watershed_id
watersheds     ── (PK id, code uniq, slug uniq) ── boundary GEOGRAPHY(MULTIPOLYGON), kind first|second|other
rivers         ── (PK id, FK watershed_id)
match_review   ── pending name/location matches awaiting human approval

observations   ── PK (dam_id, observed_at, source_id) ── HYPERTABLE on observed_at
                                          storage_volume_m3, storage_rate, inflow_m3s,
                                          outflow_m3s, water_level_m, rainfall_mm,
                                          quality_flag bitfield
                                          → FK raw_snapshot_id
raw_snapshots  ── one row per fetched HTTP response, body in MinIO
source_priorities ── source_id → priority, higher wins the chart (77 rows on prod: feeds 279–313, e.g. kasenbosai=310, mudam=280; master ndi=80, damnet=50)
source_universe / source_universe_runs ── each provider's whole published list per run (recordUniverse), read by /coverage; `has_data` (0103) is FALSE when the provider lists a dam with no usable value; `published_at` (0221) is a dated provider's stamp on its newest value, which keeps a monthly survey's dam `covered` past the 30-day window
backfill_progress ── (source_id, dam_id, year) → status
api_keys / api_key_usage ── public-API auth + per-key rate-limit
obs_daily / obs_monthly  ── TimescaleDB continuous aggregates
quality_missing_24h      ── view: per-dam missing rate over last 24h
```

67 numbered SQL migrations live in `packages/db/migrations/0000–0098_*.sql`
(numbers are reserved per branch, so there are gaps). They're applied in
lexicographic order by `packages/db/src/migrate.ts`. Data fixes on the
compressed `observations` hypertable never go in a migration: they are
one-off scripts under `deploy/ops/oneoff/` (runbook §9).

## Public surface

### Pages (Next.js, ISR=900 s)
- `/` — counts + 6 largest dams + map preview
- `/dams` — list with pref/watershed/manager filters, cursor pagination
- `/dams/{slug}` — detail with stat block, latest obs, ECharts time-series,
  related-watershed dams, nearby dams, schema.org Place JSON-LD
- `/watersheds` — list grouped by 一級/二級/その他, dam count
- `/watersheds/{slug}` — detail with aggregate + dam list
- `/prefectures/{code}` — dams in that prefecture
- `/map` — Leaflet on GSI tiles, all dam markers
- `/sources` — data-source transparency page
- `/api/docs` — Swagger UI mounted on `/api/v1/openapi.json`

### REST API (HATEOAS Level 3, HAL+JSON)
| Endpoint | Purpose |
|---|---|
| `GET /api/v1/healthz` | health check |
| `GET /api/v1/sources` | per-source last-fetch + state |
| `GET /api/v1/dams` | list with filters |
| `GET /api/v1/dams/{slug}` | detail with latest obs + nearby |
| `GET /api/v1/dams/{slug}/observations` | time-series (hourly/daily/monthly) |
| `GET /api/v1/watersheds` | list |
| `GET /api/v1/watersheds/{slug}` | detail |
| `GET /api/v1/watersheds/{slug}/dams` | watershed-scoped dam list |
| `GET /api/v1/watersheds/{slug}/aggregate` | totals |
| `GET /api/v1/prefectures/{code}/dams` | prefecture-scoped list |
| `GET /api/v1/watershed?lat=&lng=` | point-in-polygon geocoding |
| `GET /api/v1/openapi.json` | machine-readable spec |

All endpoints except `/healthz` and `/sources` require an `X-API-Key`
header. Set `API_AUTH_BYPASS=1` for local development.

## Worker tasks (graphile-worker)

Cron schedule lives in `packages/core/src/crontab.ts` (times are UTC); every task
is registered in `apps/worker/src/index.ts`. Task names use `:` separators
because graphile-worker rejects `.` in identifiers. Each ingest task writes
under its own `source_id` (the task name without `ingest:`, except
`kasenbosai-v2`, which writes `kasenbosai`) and calls `recordUniverse()` with
the provider's whole published list (`kasenbosai`'s list is recorded by
`match:kasenbosai`, its `has_data` by `kasenbosai-v2` through
`recordUniverseHasData`; exemptions live in `universe_instrumentation.test.ts`).
Every ingest cron line carries `?jobKey=<task>`, so a tick replaces a job
that is still retrying instead of queueing another; `apps/worker/src/crontab.test.ts` checks
the key and that the default 25 attempts outlast each line's longest gap.
`CODEMAP.md` has one line per task file. 124 tasks are registered: 108
`ingest:*` (107 on the cron, `ingest:kasenbosai` manual) and 16 others.

| Task | Schedule | What it does |
|---|---|---|
| `master:refresh:ndi` | 1st of month 03:00 | Reimport NLNI W01/W07 |
| `master:refresh:damnet` | 5th of month 03:00 | Reimport Damnet attribute table |
| `master:refresh:elevation` | 3rd of month 05:00 | Fill missing `elevation_m` from the GSI DEM API |
| `images:refresh:wikipedia` | 2nd of month 05:00 | Wikipedia cover image for dams without a Damnet photo |
| `master:match` | nightly 04:00 | Placeholder; logs and returns |
| `match:kasenbosai` | Mondays 03:30 | Seed `external_ids.kasenbosai` from the 川の防災情報 dam catalogue |
| `ingest:kasenbosai-v2` | hourly :03 | 川の防災情報 per-dam JSON for every `external_ids.kasenbosai` dam (800+) |
| `ingest:kasenbosai` | manual | Original SourceAdapter run for 川の防災情報; superseded by v2 |
| MLIT regional bureaus (12): `hkd-mlit-dam` `ktr-kinu-dam` `ktr-tone-dam` `hrr-mlit-dam` `kkr-mlit-dam` `cgr-mlit-dam` `cgr-okakawa-dam` `cgr-ashida-seki` `skr-hiji-dam` `qsr-turuta-dam` `qsr-ryumon-dam` `qsr-toukan-dam` | hourly; `kkr-mlit-dam` daily, `cgr-okakawa-dam` twice daily | 国管理 dam dashboards of 北海道開発局 and the 地方整備局 |
| 水資源機構 (14): `jwa-junpo` `jwa-toneara` `jwa-tonekako` `shimokubo` `jwa-chubu` `jwa-kiso-rt` `jwa-toyokawa` `jwa-aichi-yosui` `jwa-biwako` `jwa-yoshino` `jwa-chikugo` `jwa-chikugo-rt` `jwa-fukudou` `jwa-chiba-bouso` | hourly; `jwa-junpo`, `jwa-chiba-bouso` daily, `jwa-aichi-yosui` and `jwa-chikugo` twice daily; `jwa-chubu` three times each weekday around its report | JWA realtime pages, daily 0時 tables and the 旬報 |
| Prefectural river / disaster portals (43): `akita-kasen` `aomori-dam` `iwate-kasen` `miyagi-kasen` `yamagata-bousai` `fukushima-kasen` `ibaraki-bousai` `ibaraki-kasumigaura` `tochigi-bodik` `gunma-kasen` `saitama-suibo` `kanagawa-dam` `kanagawa-suibou` `yamanashi-dam` `nagano-kasen` `gifu-kasen` `aichi-kasen` `toyama-bousai` `ishikawa-kasen` `fukui-bousai` `shiga-bousai` `kyoto-bousai` `osaka-bousai` `hyogo-bodik` `nara-kasen` `wakayama-kasen` `tottori-dam` `tottori-bousai` `shimane-bousai` `okayama-bousai` `hiroshima-bousai` `yamaguchi-bousai` `tokushima-bousai` `kagawa-bousai` `ehime-bousai` `kochi-bousai` `saga-bousai` `nagasaki-kasen` `kumamoto-bousai` `oita-bousai` `miyazaki-bousai` `kagoshima-bousai` `kagoshima-kasen` | hourly (`nagasaki-kasen` twice an hour; `kanagawa-dam` is a daily 30-day window polled every 3 h) | 県管理 dam tables: 防災Web HTML, JSON feeds, BODIK CSVs |
| Agricultural (14): `fukushima-nourin` `chiba-nourin` `miyagi-nousei` `oita-nourin` `kyushu-nousei` `kagawa-tameike` `sado-nourin` `yonezawa-heiya` `sannoukai` `dainichigawa-lid` `tndam-hyogo` `syowaike` `shioda-sayamaike` `sokobaru-dam` | daily 03:22–07:13; `tndam-hyogo`, `syowaike`, `shioda-sayamaike` and `sokobaru-dam` hourly | 農業用ダム / ため池 survey tables and PDFs (mostly 貯水率 only); 土地改良区 weekly 貯水量 pages (水窪, 山王海/葛丸) and 大日川土地改良区's daily 9時 PDF; 丹波, 昭和池, 沢山池 and 石垣島 (底原ダム管理システム) telemetry |
| Water utilities, 企業局, other operators (23): `tokyo-waterworks` `chiba-suisei` `fukuoka-bodik` `kitakyushu-suido` `sasebo-suido` `matsue-suido` `nagasaki-city-suido` `shimonoseki-suido` `kudamatsu-suido` `awaji-suido` `omura-suido` `hirado-suido` `kanda-suido` `sue-suido` `okinawa-eb` `kochi-kigyo` `nagano-kigyo` `mie-kigyo` `hyogo-kigyo` `hyogo-suigen` `mc-tottori-hydro` `jpower-naharigawa` `aitoyo` | daily, `tokyo-waterworks` and `sasebo-suido` twice daily; `fukuoka-bodik`, `kochi-kigyo`, `mc-tottori-hydro`, `jpower-naharigawa` hourly, `aitoyo` hourly 09–20 JST (business-day page), `nagano-kigyo` twice an hour | Waterworks 水源状況, 企業局 dam data, 兵庫県's monthly 県内水源 table, hydro operators; weekly or monthly pages are polled daily |
| `backfill:mudam` | 20th of month 05:00 (last year); manual for more | NILIM ダム諸量DB daily history |
| `backfill:jwa-junpo` / `backfill:kagoshima-bodik` | manual | JWA 旬報 archive / 鹿児島県 BODIK ZIP archives |
| `backfill:suimon:enqueue` / `backfill:suimon:run` | manual | Populate and drain `backfill_progress` for 水文水質DB |
| `quality:recompute` | nightly 04:30 | Flag missing/mismatch rows; null phantom zero-storage series |
| `storageRate:recompute` | nightly 04:45 | Derive the rate for rows with a volume but no rate, chunk by chunk |
| `quality:freshness-check` | hourly :35 | Stale-source digest to Discord (or the log) |
| `aggregates:refresh` | 20th of month 08:00 | Refresh `obs_daily` / `obs_monthly` over full history |
| `observations:rebind` | manual | Move one source's observations to the right dam, keyed by NDI id |

## Plans authored

Five evolutionary plans, all merged to `main`:

| File | Scope |
|---|---|
| `docs/superpowers/specs/2026-05-01-dam-data-platform-design.md` | Product + architecture spec (canonical) |
| `docs/superpowers/plans/2026-05-01-foundation-and-master-db.md` | Plan 1 — repo + master + watershed-geocoding API |
| `docs/superpowers/plans/2026-05-01-realtime-ingest-and-backfill.md` | Plan 2 — observations hypertable + adapters |
| `docs/superpowers/plans/2026-05-02-public-frontend-and-api.md` | Plan 3 — pages + full API + auth + rate limit |
| `docs/superpowers/plans/2026-05-02-production-hardening.md` | Plan 4 — W07 boundaries, damnet rewrite, quality, deploy |

When doing a multi-task implementation, follow Plan 5 conventions: numbered
file under `docs/superpowers/plans/`, `## Task N:` headers, checkbox steps
with concrete code blocks. The Superpowers skill `writing-plans` formalizes
this.

## Tech stack snapshot

- **Runtime**: Bun ≥ 1.3, Node ≥ 24 (via Bun)
- **Web**: Next.js 15 App Router, React 19, Tailwind 3
- **DB**: PostgreSQL 16 + TimescaleDB 2.26 + PostGIS 3.6 + pg_trgm + pgcrypto
- **Storage**: MinIO (S3-compatible)
- **Worker**: graphile-worker on Postgres
- **Lint/format**: Biome (one tool — no ESLint or Prettier)
- **Test**: bun:test (unit/integration), Playwright (E2E)
- **Charts**: ECharts via `echarts-for-react`
- **Maps**: Leaflet directly (no react-leaflet) on GSI tiles
- **Build/deploy**: Coolify (self-hosted PaaS), pgBackRest for backups
- **CI**: GitHub Actions (lint → typecheck → migrate → unit → E2E)
