# Dam Data Platform — Design Spec

- Date: 2026-05-01
- Status: Draft (approved through brainstorming)
- Owner: matsubokkuri@gmail.com

## 1. Purpose and Goals

### Purpose

Build a web service that continuously collects, stores, and publishes reservoir data
for dams across Japan, with the goal of becoming **the largest dam data source in Japan**.

### Success Metrics (MVP)

- **Coverage**: real-time ingestion of **1,500+ dams** (national-managed + JWA + prefecture-managed).
- **Volume**: **10+ years** of historical data backfilled where available.
- **Frequency**: hourly ingestion in steady state with missing-rate < 5%.
- **Coverage report**: publish a cross-source coverage report (4 sources reconciled).
- **SEO**: every dam and watershed page is indexable (sitemap, schema.org, ISR).

### Long-term Success Metrics

- Cover all ~3,000 dams (including utility-owned and private).
- Used by external researchers, government, and media for disaster and drought
  forecasting.
- Sustained free public API ecosystem for research and education.

### Non-goals (MVP)

- Drought alerts (phase 2).
- Weather-forecast-driven prediction (phase 3).
- User accounts and favorites (phase 2+).
- Mobile apps (web only).
- Comprehensive river water-level/flow ingestion (focus on dam-related items).

## 2. Scope (MVP)

### In-scope subsystems

#### 2.1 Dam Master DB
- Import from National Land Numerical Information (NLNI / 国土数値情報): dam location,
  specs, watershed code.
- Augment attributes (manager, purpose, completion year, dam type) from the Dam Almanac
  (ダム便覧, damnet.or.jp).
- Cross-reconcile IDs across 4 sources.
- Watershed master (1st-class and 2nd-class systems).
- Watershed boundary polygons (PostGIS geometry).

#### 2.2 Realtime Reservoir Ingest (incremental coverage strategy)
- Scraping adapter for the Kasen-Bosai (川の防災情報) site as the first source.
- Hourly steady-state ingest.
- Save raw HTML/XML to S3-compatible storage.
- Insert normalized observations into the DB.
- Source-adapter abstraction so additional sources can be added in later phases.

#### 2.3 Historical Backfill
- Scraping adapter for the Suimon-Suishitsu DB (水文水質データベース).
- Bulk backfill jobs covering 10+ years.
- Both daily and hourly granularities.
- Integrates with the same normalized layer.

#### 2.4 Public API + Web Frontend
- Dam list page (SSG/ISR with filters).
- Dam detail page (ISR, ECharts graph, data quality display).
- Watershed page (aggregations + dam list).
- Prefecture page (dam list).
- Japan map view (cluster all dams).
- Public REST API (HATEOAS Level 3, API-key auth, rate limits).
- sitemap.xml and structured data (schema.org).

#### 2.5 Watershed Geocoding
- API: `/watershed?lat=&lng=` returning the watershed at the given coordinates.
- PostGIS point-in-polygon search.

### Out-of-scope (post-MVP)

- Per-utility scraping sources (electric utilities, private dams).
- Drought alerts (email / RSS / Webhook).
- Weather-forecast-driven trend prediction (JMA / ML).
- Public anomaly-detection dashboard.
- User accounts and favorites.
- Bulk download (CSV/Parquet) — likely tier-gated when added.
- Address input UI (external geocoding integration).

### MVP boundary

Per the data-first principle, MVP centers on the data foundation and public surface.
Notifications and prediction features are deferred until enough data is accumulated.

## 3. Data Source Strategy

### Master sources (priority order)
1. **NLNI dam data (W01)** — official, CC-BY-equivalent license, canonical for location
   and watershed code. **Source of truth**.
2. **NLNI watershed boundaries (W07)** — basis for the watershed-geocoding feature.
3. **Dam Almanac (damnet.or.jp)** — ~3,000 dams; attribute augmentation only. Scraping
   subject to terms of service.
4. **Dam lists from Kasen-Bosai and Suimon-Suishitsu DB** — for cross-reconciliation
   with realtime targets.

### Realtime sources (incremental coverage strategy)
- **MVP**: Kasen-Bosai (www.river.go.jp) — direct-managed + JWA + prefecture-managed.
- **Phase 2 onwards**: per-utility pages (electric utilities, private dams), added one
  adapter at a time to widen coverage.

### Historical sources
- **Suimon-Suishitsu DB** — 10+ years where hourly data is available.
- **Kasen-Bosai history pages** — where available.

### Source adapter abstraction
```ts
interface SourceAdapter {
  readonly id: string
  readonly schedule: 'hourly' | 'daily' | 'on-demand'
  fetchTargets(ctx): Promise<TargetList>      // list of URLs to fetch
  fetchRaw(target): Promise<RawSnapshot>      // raw bytes
  parse(raw): Promise<ParsedRecords[]>        // pre-normalization rows
  normalize(parsed): Promise<Observation[]>   // unified schema
}
```
Each adapter is independent. Adding a new source means implementing the interface once.

## 4. Data Model

### Two-layer schema

**Raw layer (S3-compatible object storage)**
- Path: `raw/{source_id}/{yyyy}/{mm}/{dd}/{hh}/{target_id}.{ext}`
- Stores fetched_at, HTTP status, ETag as metadata.
- Referenced from the `raw_snapshots` table via storage URI.

**Normalized layer (PostgreSQL + TimescaleDB)**

```sql
-- Master
dams (
  id BIGSERIAL PK,
  slug TEXT UNIQUE,            -- URL-safe identifier
  name TEXT, name_kana TEXT,
  pref_code CHAR(2),
  river_id BIGINT FK,
  watershed_id BIGINT FK,
  manager TEXT,
  type TEXT,                   -- gravity / arch / rockfill ...
  height_m NUMERIC, total_capacity_m3 NUMERIC,
  effective_capacity_m3 NUMERIC,
  flood_capacity_m3 NUMERIC,
  completed_year INT,
  location GEOGRAPHY(POINT,4326),
  external_ids JSONB,          -- {ndi:..., damnet:..., kasenbosai:..., suimon:...}
  created_at, updated_at
)

watersheds ( id, code, name, kind ('1st'|'2nd'), boundary GEOGRAPHY(POLYGON,4326) )
rivers     ( id, watershed_id, name, kind )

-- Raw snapshots
raw_snapshots (
  id BIGSERIAL PK,
  source_id TEXT,
  target_id TEXT,
  fetched_at TIMESTAMPTZ,
  storage_uri TEXT,            -- s3://...
  http_status INT,
  etag TEXT,
  bytes INT,
  parse_status TEXT
)

-- Observations (hypertable)
observations (
  observed_at TIMESTAMPTZ NOT NULL,
  dam_id BIGINT NOT NULL,
  source_id TEXT NOT NULL,
  storage_volume_m3 NUMERIC,
  storage_rate NUMERIC,
  inflow_m3s NUMERIC,
  outflow_m3s NUMERIC,
  water_level_m NUMERIC,
  rainfall_mm NUMERIC,
  raw_id BIGINT,
  quality_flag SMALLINT,       -- bitfield: missing / outlier / interpolated / mismatch
  PRIMARY KEY (dam_id, observed_at, source_id)
);
SELECT create_hypertable('observations','observed_at');

-- Continuous aggregate (daily)
CREATE MATERIALIZED VIEW obs_daily WITH (timescaledb.continuous) AS
SELECT dam_id, time_bucket('1 day', observed_at) AS day,
       avg(storage_volume_m3) AS avg_storage,
       max(storage_volume_m3) AS max_storage,
       min(storage_volume_m3) AS min_storage,
       last(storage_volume_m3, observed_at) AS last_storage,
       count(*) FILTER (WHERE storage_volume_m3 IS NOT NULL) AS n
FROM observations GROUP BY dam_id, day;
```

### Entity reconciliation
- **Step 1**: NLNI is primary; populate `dams` with `external_ids.ndi`.
- **Step 2**: For each other source, match using location (≤500m radius) + name
  similarity (Levenshtein / trigram) + manager.
- **Step 3**: Below the confidence threshold, push to a `match_review` table for
  semi-manual review.
- **Step 4**: After confirmation, append source IDs to `external_ids`.

### Provenance
- Every observation has `raw_id` linking back to `raw_snapshots` for full reconstruction.
- Multiple sources may store values for the same dam × timestamp (PK includes source_id).
- Display picks one source per priority rules (priorities live in `source_priorities`).

## 5. Architecture

```
┌─────────────────────────────────────────────────┐
│ Coolify (VPS)                                   │
│                                                 │
│ ┌─────────────┐  ┌─────────────────────────┐    │
│ │ Next.js     │  │ Worker (Bun)            │    │
│ │  - SSR/ISR  │  │  - graphile-worker      │    │
│ │  - API      │  │  - source adapters      │    │
│ └──────┬──────┘  └────────┬────────────────┘    │
│        │                  │                     │
│        ▼                  ▼                     │
│ ┌────────────────────────────────────────┐      │
│ │ PostgreSQL 16 + TimescaleDB + PostGIS  │      │
│ │  - dams / watersheds / observations    │      │
│ │  - graphile_worker.* (job queue)       │      │
│ │  - continuous aggregates               │      │
│ └────────────────────────────────────────┘      │
│                                                 │
│ ┌────────────────────────────────────────┐      │
│ │ MinIO (S3-compatible) — raw snapshots  │      │
│ └────────────────────────────────────────┘      │
└─────────────────────────────────────────────────┘
        │                              ▲
        ▼                              │
   pgBackRest → external S3            (mirrored backups)
```

### Job flow
1. **Scheduler** (graphile-worker cron) enqueues `fetchTargets` jobs per source.
2. **Fetcher** runs `fetchRaw`, writes raw to S3, inserts a `raw_snapshots` row, then
   enqueues `parse`.
3. **Parser** runs `parse` → `normalize`, UPSERTs into `observations`, computes
   `quality_flag`.
4. **Quality checker** recomputes missing/outlier/mismatch from continuous aggregates
   and updates `quality_flag`.
5. **Aggregator** is handled by TimescaleDB continuous aggregates.

### Rendering strategy
- ISR (revalidate=900s): `/dams`, `/dams/[slug]`, `/watersheds/[slug]`,
  `/prefectures/[code]`.
- SSG: `/`, `/map` (marker positions are static; time-series fetched client-side).
- Client Components: ECharts graphs, filter UI, map interactions.
- API: Next.js Route Handlers, Cache-Control + ETag.

## 6. URL Design and SEO

### URL structure
- `/dams` — all dams (filter by pref / watershed / manager).
- `/dams/[slug]` — dam detail.
- `/watersheds` — list.
- `/watersheds/[slug]` — watershed detail.
- `/prefectures/[code]` — by prefecture.
- `/map` — Japan map view.
- `/api/v1/...` — public API.
- `/sitemap.xml`, `/robots.txt`.

### Slugs
- Dam: `{name-romaji}-{pref}` (suffix `-2`, `-3` on collision).
- Watershed: `{name-romaji}` (109 1st-class + 2,720 2nd-class).

### Metadata and structured data
- Open Graph / Twitter Card on every page.
- Dam detail: schema.org `Place` + `GeoCoordinates` (with custom dam attributes).
- Watershed: schema.org `Place`.
- Lists: `BreadcrumbList`, `ItemList`.
- Breadcrumb UI on every page.

### Internal linking
- On each dam detail page: "dams in the same watershed", "dams in the same prefecture",
  "dams within 10km", "dams under the same manager".
- Watershed pages link to upstream/downstream dams (cascade view).
- All pages link to the map view (centered on the relevant area).

### Sitemap
- ~3,000 dams + ~2,800 watersheds + 47 prefectures + static pages — fits in one file.
- `/sitemap.xml` is generated dynamically and updated daily via ISR.

## 7. Public API

### Principles
- HATEOAS Level 3 with HAL `_links` on every response.
- Default media type: `application/hal+json` (also serve `application/json`).
- Versioning: URL path `/api/v1/`.
- Pagination: RFC 5988 `Link` header + JSON `_links.next/prev`.

### Endpoints

```
GET  /api/v1/dams                       List dams (filter: pref, watershed, manager,
                                        pageSize, cursor)
GET  /api/v1/dams/{slug}                Dam detail
GET  /api/v1/dams/{slug}/observations   Time-series observations
                                        (from, to, interval=hourly|daily|monthly)
GET  /api/v1/watersheds                 Watershed list
GET  /api/v1/watersheds/{slug}          Watershed detail
GET  /api/v1/watersheds/{slug}/aggregate  Watershed aggregation (sum/avg, with interval)
GET  /api/v1/prefectures/{code}/dams    By prefecture
GET  /api/v1/watershed?lat=&lng=        Watershed geocoding
GET  /api/v1/sources                    Data sources and last-fetch times
GET  /api/v1/healthz                    Health check
```

### Example response
```json
{
  "id": 234,
  "slug": "yamba-gunma",
  "name": "Yamba Dam",
  "pref_code": "10",
  "manager": "MLIT Kanto Regional Bureau",
  "location": {"lat":36.55, "lng":138.69},
  "total_capacity_m3": 107500000,
  "latest": {
    "observed_at": "2026-05-01T10:00:00+09:00",
    "storage_volume_m3": 65000000,
    "storage_rate": 0.604,
    "quality": {"flag":"ok", "source":"kasenbosai"}
  },
  "_links": {
    "self":         {"href":"/api/v1/dams/yamba-gunma"},
    "observations": {"href":"/api/v1/dams/yamba-gunma/observations{?from,to,interval}", "templated":true},
    "watershed":    {"href":"/api/v1/watersheds/tone"},
    "prefecture":   {"href":"/api/v1/prefectures/10/dams"},
    "raw_sources":  {"href":"/api/v1/dams/yamba-gunma/sources"},
    "web":          {"href":"/dams/yamba-gunma"}
  }
}
```

### Auth and rate limits
- API key required (email registration → instant issue).
- Header: `X-API-Key: ...`.
- Limits: 60 req/min, 10,000 req/day per key by default.
- Headers: `RateLimit-Limit / RateLimit-Remaining / RateLimit-Reset`.
- 429 responses include `Retry-After`.
- Terms of service require attribution.

### OpenAPI 3
- Declare operationId chains via `components.links`.
- Served at `/api/v1/openapi.json`, with Swagger UI at `/api/docs`.

## 8. Data Quality Design

### Missing-data detection
- Generate the expected observation timestamps per schedule.
- Flag the `missing` bit in `quality_flag` when no observation exists at the expected
  time.
- Compute missing-rate per dam per day from `obs_daily`.

### Outlier detection
- Field-specific thresholds for ±X% versus the previous value.
- Reject physically impossible values (exceeds capacity, negative).
- On detection set the `outlier` bit; values are kept (never discarded).

### Cross-source reconciliation
- When the same dam × timestamp has values from multiple sources, compute differences.
- Differences beyond a threshold record `mismatch`.
- Display selects the value from the highest-priority source (priorities live in
  `source_priorities`).

### Public UI
- Dam detail page shows:
  - Last-fetched time, source name, last-24h missing-rate.
  - Markers on the graph for missing/outlier points.
  - "Sources used" section listing X / Y / Z explicitly.
- API responses always include a `quality` field.
- A `/sources` page publishes per-source last-fetch time and success rate.

## 9. Watershed Geocoding

### Ingestion
- Load NLNI W07 watershed boundaries (GeoJSON) into `watersheds.boundary`.
- 109 1st-class + 2,720 2nd-class watersheds; areas outside both are "no watershed".

### Lookup
```sql
SELECT id, code, name, kind
FROM watersheds
WHERE ST_Contains(boundary, ST_SetSRID(ST_MakePoint($lng, $lat), 4326))
LIMIT 1;
```
GiST index keeps this in the tens-of-milliseconds range.

### API
```
GET /api/v1/watershed?lat=35.681&lng=139.767
→ {
    "watershed": {"id":..., "code":"01", "name":"Tone River System", "kind":"1st"},
    "_links": {
      "self":  {"href":"/api/v1/watershed?lat=35.681&lng=139.767"},
      "watershed": {"href":"/api/v1/watersheds/tone"},
      "dams_in_watershed": {"href":"/api/v1/watersheds/tone/dams"}
    }
  }
```
- If no watershed contains the point, return 404 and surface the nearest watershed via
  `_links.nearest`.

## 10. ETL and Job Operations

### graphile-worker jobs
| Job | Schedule | Action |
|-----|----------|--------|
| `master.refresh.ndi` | Monthly | Diff-import NLNI |
| `master.refresh.damnet` | Monthly | Diff-scrape Dam Almanac |
| `master.match` | After master refresh | Run reconciliation |
| `ingest.kasenbosai.fetch_targets` | Hourly :00 | Enumerate target URLs |
| `ingest.kasenbosai.fetch` | Queue | Fetch HTML → S3 → enqueue parse |
| `ingest.kasenbosai.parse` | Queue | parse → normalize → UPSERT |
| `ingest.suimon.backfill` | Manual | Bulk historical ingest |
| `quality.recompute` | Daily | Recompute missing-rate / mismatches |
| `aggregate.refresh` | Auto (continuous agg) | Handled by TimescaleDB |
| `sitemap.regenerate` | Daily | Regenerate sitemap.xml |

### Scraping rate control and compliance
- Honor robots.txt.
- Common header: `User-Agent: DamDataPlatform/1.0 (+https://example.com/bot; contact@example.com)`.
- Per-source RPS limit (default: 0.5 req/sec).
- Exponential backoff on failure (max 5 retries).
- Skip parse when ETag/Content-Length match the prior raw.
- Detect upstream HTML/API changes via fixture diff.

### Backfill strategy
- Partition Suimon-Suishitsu DB pulls by year × dam, low-priority queue.
- Enforce a per-day cap to avoid stressing the upstream.
- Track progress in `backfill_progress`.

## 11. Deployment

### Topology (Coolify)
- **app**: Next.js (Bun) — SSR/ISR/API.
- **worker**: Bun + graphile-worker.
- **db**: PostgreSQL 16 + TimescaleDB + PostGIS (official extension image).
- **storage**: MinIO (S3-compatible).
- **proxy**: Coolify default (Caddy/Traefik) with automatic SSL.

### Backups
- DB: pgBackRest (incremental → external S3, full weekly, PITR 7 days).
- Raw snapshots: MinIO mirrored to external S3.
- Coolify resource definitions managed via GitOps.

### Env and secrets
- Use Coolify secret management.
- Repo includes `.env.example`; real values are not committed.
- API keys encrypted at rest with `pgcrypto`.

### CI/CD
- GitHub Actions: lint → typecheck → test → build → push image → trigger Coolify webhook.
- Migrations: Drizzle/Kysely, run as a pre-start `migrate` job.

## 12. Test Strategy

### Unit (`bun test`)
- Adapter parse/normalize with fixture HTML/XML at
  `tests/fixtures/sources/{source}/{date}/`.
- Reconciliation logic (location + name similarity).
- Quality rules (missing / outlier).
- HATEOAS helper (`_links` builder).

### Integration (real DB; testcontainers or compose)
- ETL E2E: feed fixtures into S3 mock → run jobs → assert DB state.
- API E2E: walk through a sequence of endpoints → validate response schema with zod.
- Geocoding: known coordinates → expected watershed.

### Frontend E2E (Playwright)
- Main pages render and graphs paint.
- List filters and pagination.
- Map click → watershed lookup → navigate to watershed page.
- API docs page works.

### Coverage
- 80%+ unit coverage required (per CLAUDE.md).
- All major jobs covered by integration tests.
- E2E covers the golden path plus key edge cases.

## 13. Non-functional Requirements

### Performance
- API p95 latency < 200ms (excluding observation time-series).
- Observation time-series API (1 month) p95 < 500ms via continuous aggregates.
- Dam detail TTFB on ISR cache hit < 100ms.
- Map view first paint < 2s after marker clustering.

### Availability
- MVP: single VPS with monthly maintenance allowed.
- Targets: RTO 4h, RPO 24h (pgBackRest PITR).

### Data retention
- Observations: kept indefinitely (compressed).
- Raw snapshots: 5 years; afterwards monthly samples only.
- Job logs: 90 days.

### Scraping compliance
- Honor robots.txt.
- Every source carries a User-Agent and contact endpoint.
- Fetch rate never exceeds the upstream publish rate.
- Detect terms-of-service changes and stop ingest immediately.

## 14. Risks and Open Questions

### Scraping terms and legal review
- Confirm Dam Almanac terms (redistribution, commercial use).
- Per-utility terms when phase 2 begins.
- Surface usage conditions to API consumers (attribution required).
- **Open question**: schedule a legal review pass before implementation.

### Robustness to upstream changes
- Kasen-Bosai or Suimon-Suishitsu DB UI/API changes will break adapters.
- Mitigation: fixture-snapshot diffs raise alerts immediately.
- **Open question**: choose alert destination (Slack/Discord) and operational owner.

### Scaling plan
- Current topology supports up to a few hundred thousand PV/day.
- Beyond that: add Cloudflare/CDN front, add read replicas.
- When observations grow past hundreds of millions of rows, tune `chunk_time_interval`.

### Reconciliation accuracy
- Items below the auto-match confidence threshold need a manual review UI.
- **Open question**: include the manual review UI in MVP, or defer?
- Proposal: in MVP, expose only an "unmatched dams" listing and confirm via direct
  DB updates if needed.

### API usage analytics
- Decide retention and granularity for API-key usage logs.
- **Open question**: include per-key usage analytics now, considering privacy?
