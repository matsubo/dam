# Project Overview

Two-page summary of what's in this repo and why each piece exists.

## Goal

Be the most complete dam-reservoir dataset for Japan. Three concrete things
the project must do:

1. **Master**: enumerate every dam (currently 2,749) and every river system
   (644) with location, attributes, and a stable URL slug.
2. **Time-series**: store hourly reservoir observations (storage volume,
   storage rate, inflow, outflow, water level, rainfall) with provenance.
3. **Public surface**: serve a SEO-friendly website + a HATEOAS REST API
   that external consumers can rely on, plus a Japan map view.

Current state: master is loaded with real NLNI W01 + Damnet data; watershed
boundaries from NLNI W07 are loaded for 463/644 systems; observations are
synthetic placeholder while we sort out a non-blocked upstream
(www.river.go.jp returns 403 to scrapers).

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
    └── src/tasks/          #  master.refresh.ndi, ingest.kasenbosai, …

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
    ├── kasenbosai/         # 川の防災情報 (currently synthetic — upstream blocks scrapers)
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
source_priorities ── source_id → priority (synthetic=200, kasenbosai=100, suimon=90, ndi=80, damnet=50)
backfill_progress ── (source_id, dam_id, year) → status
api_keys / api_key_usage ── public-API auth + per-key rate-limit
obs_daily / obs_monthly  ── TimescaleDB continuous aggregates
quality_missing_24h      ── view: per-dam missing rate over last 24h
```

12 numbered SQL migrations live in `packages/db/migrations/0000–0020_*.sql`.
They're applied in lexicographic order by `packages/db/src/migrate.ts`. New
migrations land as the next number.

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

Cron schedule lives in `apps/worker/src/crontab.ts`. Task names use `:`
separators because graphile-worker rejects `.` in identifiers.

| Task | Schedule | What it does |
|---|---|---|
| `master:refresh:ndi` | 1st of month 03:00 | Reimport NLNI W01/W07 |
| `master:refresh:damnet` | 5th of month 03:00 | Reimport Damnet attribute table |
| `master:match` | nightly 04:00 | Re-run reconciliation for low-confidence matches |
| `ingest:kasenbosai` | every hour at :05 | Pull realtime observations (currently synth-only) |
| `backfill:suimon:enqueue` | manual | Populate `backfill_progress` for a year×dam range |
| `backfill:suimon:run` | every 5 min | Drain the backfill queue |
| `quality:recompute` | nightly 04:30 | Flag missing/outlier/mismatch in last 24 h |

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
