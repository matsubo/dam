# Data Flow

How a piece of data moves from upstream → DB → chart.

## Master ingest (NLNI W01 → dams table)

```
nlftp.mlit.go.jp/ksj/gml/data/W01/W01-14/W01-14_GML.zip
  └─ unzip → W01-14-g_Dam.shp (Shapefile)
       └─ ogr2ogr -f GeoJSON → data/nlni/w01.geojson (2,749 features)
            └─ apps/web/bin/import_real_ndi_w01.ts
                 ├─ map W01_001/002/003/… → ParsedDam shape
                 ├─ derive prefCode from W01_013 (address prefix)
                 ├─ resolve watershedId by W01_003 ↔ watersheds.name
                 ├─ generate slug via @dam/core/slug
                 └─ upsertDamByExternalId('ndi', …) →
                      INSERT INTO dams (…) ON CONFLICT (external_ids->>'ndi')
                      DO UPDATE … (idempotent)
```

After this: `dams` has 2,749 rows, all 47 prefectures, with NDI external_id.

## Watershed boundaries (NLNI W07 → watersheds.boundary)

```
nlftp.mlit.go.jp catalog page
  └─ 154 mesh ZIPs (~1 GB total) → data/nlni/w07/*.zip → *.shp
       └─ data/nlni/w07/dissolve_all.sh
            └─ per mesh: ogr2ogr SQLite-dialect dissolve
                 GROUP BY W07_004 → 30 polygons/mesh
                  → data/nlni/w07/dissolved/*.geojson (~2,862 features)
                       └─ apps/web/bin/import_real_ndi_w07.ts
                            ├─ load every dissolved geojson into stage_w07
                            ├─ ST_Multi(ST_Union(geom)) GROUP BY name → stage_w07_final
                            └─ UPDATE watersheds SET boundary = s.boundary
                                  WHERE w.name = s.name (backfill only)
```

Result: 463/644 watersheds get a real polygon boundary. `findWatershedContaining(lat, lng)`
uses GiST index on `boundary` for sub-100ms lookups.

## Watershed kind (NLNI codelist + W05 → watersheds.kind / ndi_code)

`kind` is NOT derivable from W07 (it carries no 一級/二級 flag; #21). It comes
from the 水系域コード (河川コード上位 6 桁) plus W05 区間種別:

```
nlftp.mlit.go.jp codelist WaterSystemCodeCd.html   (code → 水系名, 5,476 rows)
nlftp.mlit.go.jp W05 × 47 prefectures              (*_Stream.dbf: W05_001 code, W05_003 区間種別)
  └─ bin/fetch_w05.sh → data/nlni/w05/
       └─ apps/web/bin/classify_watershed_kind.ts
            ├─ name-match watersheds (NFKC + 曾/曽 etc.) → candidate codes
            ├─ code prefix 81–89 → first (the 109 一級水系, by 地方整備局)
            ├─ any 区間種別 3/7 (二級河川区間) → second, else other
            ├─ same-named systems: prefer 8x, else the dams' prefecture, else best kind
            └─ packages/db/migrations/0041_watersheds_kind_from_ndi.sql (UPDATE by code)
                 └─ deploy/seed/master_upsert.sql.gz re-generated (it rewrites kind on every deploy)
```

Result: 102 first (108 unique 8x names minus 6 with no W01 dams), 458 second,
84 other (49 names never matched the codelist, `ndi_code` NULL).

## Damnet attribute backfill (kana, manager, completion year)

```
dambinran.damnet.or.jp/wp-json/dmap/dam-info/{wp_post_id}
  └─ apps/web/bin/capture_damnet.ts (concurrent probe of post-id range)
       └─ data/damnet/dams.jsonl (1,500 dams with full attributes)
            └─ apps/web/bin/match_damnet.ts
                 ├─ load all 2,749 dams into a (prefCode, normName) map
                 ├─ for each capture: pref name → code, normalize name
                 ├─ if matched:
                 │    ├─ append external_ids.damnet
                 │    ├─ COALESCE-fill name_kana, manager, type, height, capacity, year
                 │    └─ if slug starts with 'dam-' and we now have kana:
                 │         recompute slug via toSlug(kana) + suffixedSlug
                 └─ unmatched 131 → no-op (could feed match_review later)
```

Result: 1,360 dams gain kana, 1,326 gain manager, 1,479 get readable kana-romaji slugs.

## Realtime observation ingest (currently synthetic)

The intended flow exists but the upstream blocks scrapers:

```
www.river.go.jp/kawabou/...   ← 403 "Access Restrictions"
                               ↓
                              [blocked]
```

Until that's resolved, the synthetic seeder fills in:

```
apps/web/bin/seed_synthetic_observations.ts
  ├─ pin source_priorities.synthetic = 200 (highest)
  ├─ for each dam with total_capacity_m3:
  │    ├─ Tier 1 (older): for d in [HOURLY_DAYS+1 .. YEARS*365]
  │    │   one obs per day at 12:00 JST
  │    │   storage_rate = random walk + seasonal sin
  │    │   storage_volume = capacity × rate
  │    ├─ Tier 2 (recent): for h in [1 .. HOURLY_DAYS*24]
  │    │   hourly resolution, diurnal variation
  │    └─ batched INSERT (5,000 rows per batch)
  └─ refresh_continuous_aggregate('obs_daily'); same for obs_monthly
```

When a real upstream lands:

```
apps/worker/src/tasks/ingest_kasenbosai.ts (cron @ :05)
  └─ runIngestForAdapter(kasenbosaiAdapter, { runAt: now })
       ├─ adapter.fetchTargets() — DB query for dams with kasenbosai external_id
       ├─ for each target:
       │    ├─ adapter.fetchRaw() — HttpClient.get with If-None-Match (skip on 304)
       │    ├─ putSnapshot() — body bytes → MinIO at raw/kasenbosai/yyyy/mm/dd/hh/{id}.xml
       │    ├─ recordRawSnapshot() → DB ledger
       │    ├─ adapter.parse() — XML → ParsedReading[]
       │    ├─ for each reading:
       │    │    ├─ damIdByExternalId('kasenbosai', id) → dam_id
       │    │    ├─ isPhysicallyValid() / detectOutlier() → quality_flag bits
       │    │    └─ accumulate ObservationInput
       │    └─ upsertObservations(batch) → ON CONFLICT DO UPDATE
       │         (PK is dam_id+observed_at+source_id, so multiple sources coexist)
       └─ markParsed(rawId)
```

## Read path (chart → API → DB)

```
ECharts client component (apps/web/components/observation-chart.tsx)
  ├─ useState selects 'hourly' | 'daily' | 'monthly'
  ├─ fetch /api/v1/dams/{slug}/observations?from=&to=&interval=
  │    └─ Next.js route handler (apps/web/app/api/v1/dams/[slug]/observations/route.ts)
  │         ├─ authorize(req) — API key + rate limit
  │         ├─ findDamBySlug(slug) → dam.id
  │         ├─ preferredSource() → top-priority source_id
  │         └─ findSeries({ damId, from, to, bucket, preferredSource }) →
  │              hourly:  SELECT ... FROM observations WHERE source_id=preferred
  │              daily:   SELECT day, last_storage_volume_m3 FROM obs_daily
  │              monthly: SELECT month, avg_storage_volume_m3 FROM obs_monthly
  ├─ ECharts renders line series with auto-scaled Y-axis (億 vs 万)
  └─ tooltip formatter shows value with proper unit
```

## Read path (page → DB)

Pages are Server Components. They import repo functions from `@dam/db/repo/*`
and call them directly during the SSR pass. Postgres connections come from
the singleton `sql` in `packages/db/src/client.ts`. ISR with
`export const revalidate = 900` caches each page for 15 minutes.

```
GET /dams/yamba-10
  ├─ Next.js routes to apps/web/app/dams/[slug]/page.tsx
  ├─ slug param decodeURIComponent (kanji safety)
  ├─ Promise.all:
  │    ├─ findDamBySlug → DamDetail (joins watersheds for slug+name)
  │    ├─ latestObservation(d.id) → most recent observation (any source)
  │    ├─ nearbyDams(d.id, 20km, 6) → spatial query
  │    ├─ findWatershedBySlug(d.watershedSlug) → watershed metadata
  │    └─ listDams({ watershedSlug, pageSize: 12 }) → siblings in same system
  ├─ render breadcrumbs, stat block, latest panel, ECharts mount, watershed
  │   section, nearby section, schema.org Place JSON-LD
  └─ stream HTML; ECharts component hydrates client-side and fetches data
```

## Quality / provenance

Every `observation` row carries:
- `source_id` — which adapter wrote it (`synthetic`, `kasenbosai`, `suimon`, …)
- `raw_snapshot_id` — FK to the row in `raw_snapshots`, whose `storage_uri`
  points at MinIO so the original bytes can be re-parsed
- `quality_flag` bitfield — `1=missing`, `2=outlier`, `4=interpolated`,
  `8=mismatch_with_other_source`, `16=manual_review`

The nightly `quality:recompute` worker task recomputes those bits.
`/sources` and per-row API responses surface them publicly.
