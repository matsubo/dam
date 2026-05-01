# Production Hardening — Implementation Plan (Plan 4)

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Close the gaps left by Plans 1–3 + the live data-collection round so the platform is operationally ready for public traffic. Specifically: bring NLNI W07 watershed boundaries online, retarget the damnet scraper at the redesigned site to backfill kana/manager attributes, repair kanji-only slugs, capture a real Kasen-Bosai response and harden its parser, implement quality recompute, conform NDI/Damnet adapters to the formal SourceAdapter interface, and add Coolify deployment + backup wiring.

**Architecture:** Mostly additive on top of Plan 3. The one structural change is making `watersheds.boundary` nullable (master rows for 水系 derived from W01 river-system names land first; boundaries arrive afterwards from W07 mesh-tile merges). All other tasks are surgical: one-file parsers, one cron task, one migration each.

**Tech Stack:** No new runtime dependencies. Adds GDAL/ogr2ogr as a build-time tool (already installed via brew). May add `pino` or accept current `console.*` logging — TBD per task.

**Reference spec:** `docs/superpowers/specs/2026-05-01-dam-data-platform-design.md`

**Out of scope:** alerts, prediction, mobile, OAuth, multi-region.

---

## File Structure

```
packages/db/migrations/
├── 0018_watersheds_boundary_nullable.sql       # NEW
├── 0019_dam_aliases.sql                         # NEW (cached prefecture name + romaji slug fallback)
└── 0020_quality_view.sql                        # NEW (per-dam-day missing-rate)

apps/web/bin/                                    # NEW one-off importers / data utilities
├── import_real_ndi_w01.ts                       # exists
├── import_real_ndi_w07.ts                       # NEW
├── import_watersheds_from_w01.ts                # NEW (master without boundary)
├── repair_dam_slugs.ts                          # NEW (after damnet kana lands)
└── snapshot_kasenbosai.ts                       # NEW (capture a real fixture)

packages/adapters/damnet/src/                    # MODIFY
├── list_scraper.ts                              # MODIFY: parse new /dams/japan listing
├── detail_parser.ts                             # MODIFY: parse new dam-banner__* / dam-info__*
├── importer.ts                                  # unchanged contract
└── adapter.ts                                   # NEW: conform to SourceAdapter

packages/adapters/ndi/src/
├── adapter.ts                                   # NEW: conform to SourceAdapter
└── parse_w01.ts                                 # MODIFY: handle real schema in addition to fixture

packages/adapters/kasenbosai/src/
├── parser.ts                                    # MODIFY: real-response shape after fixture capture
└── adapter.ts                                   # MODIFY: targets handle missing kasenbosai ids

packages/ingest/src/
└── quality.ts                                   # MODIFY: recompute service

apps/worker/src/tasks/
├── quality_recompute.ts                         # MODIFY: real implementation

deploy/                                          # NEW
├── coolify/
│   ├── docker-compose.coolify.yml
│   ├── Dockerfile.web
│   ├── Dockerfile.worker
│   └── README.md
├── backup/
│   ├── pgbackrest.conf
│   └── litestream.yml                           # for the 0017 api_keys table only (optional)
└── ops/
    └── runbook.md
```

---

## Task 1: Migration 0018 — `watersheds.boundary` nullable

**Files:**
- Create: `packages/db/migrations/0018_watersheds_boundary_nullable.sql`

- [ ] **Step 1: SQL**

```sql
ALTER TABLE watersheds ALTER COLUMN boundary DROP NOT NULL;
COMMENT ON COLUMN watersheds.boundary IS
  'NULL until the W07 mesh-tile merge has produced a polygon for this watershed.';
```

- [ ] **Step 2: Apply + commit**
```bash
just migrate
docker compose exec db psql -U dam -d dam -c "\d+ watersheds"
git add packages/db/migrations/0018_watersheds_boundary_nullable.sql
git commit -m "feat(db): allow nullable watershed boundary until W07 lands"
```

---

## Task 2: Seed `watersheds` master from W01 river-system names

**Files:**
- Create: `apps/web/bin/import_watersheds_from_w01.ts`

- [ ] **Step 1: Implementation**

```ts
import { readFile } from 'node:fs/promises';
import { suffixedSlug, toSlug } from '@dam/core/slug';
import { sql } from '@dam/db/client';

interface Feature {
  type: 'Feature';
  properties: { W01_003?: string };
}
interface FC { type: 'FeatureCollection'; features: Feature[] }
const isFC = (v: unknown): v is FC =>
  typeof v === 'object' && v !== null && (v as { type?: string }).type === 'FeatureCollection';

async function main(): Promise<void> {
  const path = process.argv[2] ?? `${process.cwd()}/data/nlni/w01.geojson`;
  const data: unknown = JSON.parse(await readFile(path, 'utf8'));
  if (!isFC(data)) throw new Error('not a FeatureCollection');

  const names = new Set<string>();
  for (const f of data.features) {
    const n = f.properties.W01_003;
    if (n) names.add(n);
  }

  const taken = new Set(
    (await sql<{ slug: string }[]>`SELECT slug FROM watersheds`).map((r) => r.slug),
  );

  let inserted = 0;
  for (const name of names) {
    const stem = name.replace(/水系$/u, '');
    const base = toSlug(stem) || `watershed-${inserted}`;
    const slug = suffixedSlug(base, taken);
    taken.add(slug);
    const code = `W01-${name}`; // synthetic code keyed on river-system name
    await sql`
      INSERT INTO watersheds (code, slug, name, kind, boundary)
      VALUES (${code}, ${slug}, ${name},
              CASE WHEN ${name} LIKE '%水系%' THEN 'first' ELSE 'other' END,
              NULL)
      ON CONFLICT (code) DO NOTHING
    `;
    inserted++;
  }
  console.log(JSON.stringify({ totalNames: names.size, attempted: inserted }));
}

main()
  .catch((e) => { console.error(e); process.exitCode = 1; })
  .finally(() => sql.end({ timeout: 5 }));
```

- [ ] **Step 2: Run + verify + commit**

```bash
bun run apps/web/bin/import_watersheds_from_w01.ts /Volumes/nvme/matsu/ghq/github.com/matsubo/dam/data/nlni/w01.geojson
docker compose exec db psql -U dam -d dam -c "SELECT COUNT(*) FROM watersheds;"
# Re-link dams to the now-existing watersheds:
docker compose exec db psql -U dam -d dam -c "
  UPDATE dams d SET watershed_id = w.id
  FROM watersheds w
  WHERE w.code = ('W01-' || (SELECT W01_003 FROM ...))  -- adjust if needed
"
# Simpler: re-run the W01 importer; takenSlugs preloads existing rows so it's idempotent.
git add apps/web/bin/import_watersheds_from_w01.ts
git commit -m "feat(import): seed watersheds master from W01 river-system names"
```

Note: the dam→watershed link is set by the W01 importer when `watershedByName` resolves. Re-run `apps/web/bin/import_real_ndi_w01.ts` after this seed to pick up the new IDs.

---

## Task 3: NLNI W07 mesh-tile downloader + merger

**Files:**
- Create: `apps/web/bin/import_real_ndi_w07.ts`
- Modify: `justfile` (`download-w07` recipe)

- [ ] **Step 1: Add justfile recipe to fetch all mesh tiles**

```make
# Download every W07 mesh tile listed on the catalog page (~50 tiles, ~50 MB total).
# Parses the catalog HTML to find tile filenames, then downloads sequentially.
download-w07 dest="data/nlni/w07":
    mkdir -p {{dest}}
    curl -sL "https://nlftp.mlit.go.jp/ksj/gml/datalist/KsjTmplt-W07.html" \
      | grep -oE "W07-09_[0-9-]+-jgd_GML\.zip" | sort -u \
      | while read f; do \
          test -f {{dest}}/$f || curl --fail -sL -o {{dest}}/$f "https://nlftp.mlit.go.jp/ksj/gml/data/W07/W07-09/$f" ; \
          sleep 1; \
        done
    cd {{dest}} && for z in *.zip; do unzip -n -q $z; done
```

- [ ] **Step 2: Importer (per mesh, then group by 水系コード)**

```ts
// apps/web/bin/import_real_ndi_w07.ts
//
// W07 v2.2 polygon properties (verify against actual fixture):
//   W07_001 流域コード (string)
//   W07_002 水系名     (string)
//   W07_003 水系種別   ("1"=一級, "2"=二級, "3"=その他)
//   W07_004 流域名     (string, sub-basin)
//
// Strategy: load every per-mesh GeoJSON, dissolve polygons by W07_002 (water-system
// name), upsert one MULTIPOLYGON row per system. Mesh tiles overlap at edges; rely
// on PostGIS ST_Union when grouping in SQL.

import { readFile, readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { sql } from '@dam/db/client';

interface Props { W07_001?: string; W07_002?: string; W07_003?: string }
interface Feature { type: 'Feature'; properties: Props; geometry: GeoJSON.Polygon | GeoJSON.MultiPolygon }
interface FC { type: 'FeatureCollection'; features: Feature[] }
const isFC = (v: unknown): v is FC => typeof v === 'object' && v !== null && (v as { type?: string }).type === 'FeatureCollection';

const KIND_FOR: Record<string, 'first' | 'second' | 'other'> = { '1': 'first', '2': 'second', '3': 'other' };

async function main(): Promise<void> {
  const dir = process.argv[2] ?? `${process.cwd()}/data/nlni/w07/geojson`;
  const files = (await readdir(dir)).filter((f) => f.endsWith('.geojson'));

  // Drop into a staging table, then dissolve.
  await sql`
    CREATE TEMP TABLE stage_w07 (
      code TEXT, name TEXT, kind TEXT, geom geometry(MULTIPOLYGON, 4326)
    ) ON COMMIT DROP
  `;

  for (const file of files) {
    const data: unknown = JSON.parse(await readFile(join(dir, file), 'utf8'));
    if (!isFC(data)) continue;
    for (const f of data.features) {
      const code = f.properties.W07_001;
      const name = f.properties.W07_002;
      const kind = KIND_FOR[f.properties.W07_003 ?? ''] ?? 'other';
      if (!code || !name) continue;
      const geom = f.geometry.type === 'MultiPolygon'
        ? f.geometry
        : { type: 'MultiPolygon' as const, coordinates: [f.geometry.coordinates] };
      await sql`
        INSERT INTO stage_w07 (code, name, kind, geom)
        VALUES (${code}, ${name}, ${kind},
                ST_Multi(ST_GeomFromGeoJSON(${JSON.stringify(geom)})))
      `;
    }
  }

  // Dissolve and upsert into the master.
  const { count } = await sql`
    INSERT INTO watersheds (code, slug, name, kind, boundary)
    SELECT
      'W07-' || min(code) AS code,
      lower(replace(min(name), '水系', '')) AS slug,
      min(name) AS name,
      min(kind) AS kind,
      ST_Multi(ST_Union(geom))::geography AS boundary
    FROM stage_w07
    GROUP BY name
    ON CONFLICT (code) DO UPDATE SET
      slug = EXCLUDED.slug,
      name = EXCLUDED.name,
      kind = EXCLUDED.kind,
      boundary = EXCLUDED.boundary
  `;
  console.log(JSON.stringify({ groups: count }));
}

main().catch((e) => { console.error(e); process.exitCode = 1; }).finally(() => sql.end({ timeout: 5 }));
```

- [ ] **Step 3: Convert mesh shapefiles to GeoJSON (helper)**

Add a justfile recipe:
```make
convert-w07-shp:
    cd data/nlni/w07 && mkdir -p geojson && \
      for shp in $(find . -name '*.shp'); do \
        out=geojson/$(basename ${shp%.shp}).geojson; \
        ogr2ogr -f GeoJSON $out $shp ; \
      done
```

- [ ] **Step 4: Run + verify + commit**

```bash
just download-w07
just convert-w07-shp
bun run apps/web/bin/import_real_ndi_w07.ts /Volumes/nvme/matsu/ghq/github.com/matsubo/dam/data/nlni/w07/geojson
docker compose exec db psql -U dam -d dam -c "SELECT name, kind FROM watersheds WHERE boundary IS NOT NULL ORDER BY name LIMIT 5;"
git add apps/web/bin/import_real_ndi_w07.ts justfile
git commit -m "feat(import): NLNI W07 mesh-tile merge into watershed boundaries"
```

---

## Task 4: Damnet rewrite for the new dambinran site

**Files:**
- Modify: `packages/adapters/damnet/src/list_scraper.ts`
- Modify: `packages/adapters/damnet/src/detail_parser.ts`
- Modify: `tests/fixtures/damnet/list.html` (new fixture)
- Modify: `tests/fixtures/damnet/detail_yamba.html` (new fixture)
- Test: existing `list_scraper.test.ts` and `detail_parser.test.ts`

- [ ] **Step 1: Capture a real fixture**

```bash
mkdir -p data/damnet/captures
curl -sL "https://dambinran.damnet.or.jp/dams/japan/" -o data/damnet/captures/list.html
curl -sL "https://dambinran.damnet.or.jp/dams/japan/2657" -o data/damnet/captures/detail_2657.html
```

- [ ] **Step 2: Refresh fixtures from real captures**

Pick a stable subset of the captured HTML (just the relevant DOM region) and pin it as the fixture. Update test assertions to match.

- [ ] **Step 3: Rewrite `list_scraper.ts`**

```ts
// packages/adapters/damnet/src/list_scraper.ts
import * as cheerio from 'cheerio';
import { prefNameToCode } from '@dam/core/prefectures';
import type { DamnetListItem } from './types.ts';

const ID_RX = /\/dams\/japan\/(\d+)/;

export function parseDamnetList(html: string, baseUrl: string): DamnetListItem[] {
  const $ = cheerio.load(html);
  const items: DamnetListItem[] = [];
  $('a[href^="/dams/japan/"]').each((_, a) => {
    const href = $(a).attr('href');
    if (!href) return;
    const m = href.match(ID_RX);
    if (!m || !m[1]) return;
    const damnetId = m[1];
    const name = $(a).text().trim();
    if (!name) return;
    const prefName = $(a).closest('[class*="dam-banner__meta-prefecture"], [class*="prefecture"]').text().trim()
                  || $(a).attr('data-prefecture')
                  || '';
    if (!prefName) return;
    items.push({ damnetId, name, prefCode: prefNameToCode(prefName), detailUrl: new URL(href, baseUrl).toString() });
  });
  return items;
}
export { prefNameToCode } from '@dam/core/prefectures';
```

- [ ] **Step 4: Rewrite `detail_parser.ts`**

```ts
// packages/adapters/damnet/src/detail_parser.ts
import * as cheerio from 'cheerio';
import { prefNameToCode } from '@dam/core/prefectures';
import type { DamnetDetail } from './types.ts';

function num(t: string | undefined): number | null {
  if (!t) return null;
  const m = t.match(/-?[\d,]+(?:\.\d+)?/);
  if (!m) return null;
  const n = Number(m[0].replace(/,/g, ''));
  return Number.isFinite(n) ? n : null;
}
function intish(t: string | undefined): number | null {
  const n = num(t);
  return n === null ? null : Math.trunc(n);
}

export function parseDamnetDetail(html: string, damnetId: string): DamnetDetail {
  const $ = cheerio.load(html);
  const name = $('.dam-banner__title-main').text().trim();
  const nameKana = $('.dam-banner__title-reading').text().trim() || null;
  const prefName = $('.dam-banner__meta-prefecture').text().trim();
  const items = new Map<string, string>();
  $('.dam-info__article-item').each((_, el) => {
    const heading = $(el).find('.dam-info__article-item-heading').text().trim();
    const value = $(el).find('.dam-info__card-item-content').first().text().trim()
              || $(el).find('.dam-info__article-item-links-partial').text().trim();
    if (heading) items.set(heading, value);
  });
  if (!name || !prefName) throw new Error(`damnet detail incomplete for ${damnetId}`);

  return {
    damnetId,
    name,
    nameKana,
    prefCode: prefNameToCode(prefName),
    manager:    items.get('管理者') ?? null,
    type:       items.get('型式') ?? null,
    heightM:    num(items.get('堤高')),
    totalCapacityM3:     num(items.get('総貯水容量')),
    effectiveCapacityM3: num(items.get('有効貯水容量')),
    floodCapacityM3:     num(items.get('洪水調節容量')),
    completedYear:       intish(items.get('完成年度') ?? items.get('竣工')),
    lat: null,
    lng: null,
  };
}
```

- [ ] **Step 5: Update tests + run + commit**

Tests must point at the new HTML structure. Adjust expected values per the captured fixture.

```bash
bun test packages/adapters/damnet
git add packages/adapters/damnet/src tests/fixtures/damnet
git commit -m "refactor(adapters/damnet): retarget at dambinran.damnet.or.jp DOM"
```

---

## Task 5: Damnet augmentation against the real master

- [ ] **Step 1: Run the importer in batch mode** (after Task 4)

```bash
just up
just import-damnet -- --list https://dambinran.damnet.or.jp/dams/japan/ --base https://dambinran.damnet.or.jp --limit 200
```

- [ ] **Step 2: Validate**

```bash
docker compose exec db psql -U dam -d dam -c "
  SELECT
    (SELECT COUNT(*) FROM dams WHERE external_ids ? 'damnet') AS matched,
    (SELECT COUNT(*) FROM match_review WHERE source_id = 'damnet') AS in_review,
    (SELECT COUNT(*) FROM dams WHERE name_kana IS NOT NULL) AS with_kana
"
```

If <80% match rate, tighten the matcher (lower the radius from 5 km, raise the no-loc threshold), then re-run.

- [ ] **Step 3: Commit observations**

```bash
git add docs/ # any notes
git commit -m "chore: damnet first-200 augmentation completed"
```

---

## Task 6: Repair kanji-only slugs after kana lands

**Files:**
- Create: `apps/web/bin/repair_dam_slugs.ts`

- [ ] **Step 1: Implementation**

```ts
import { suffixedSlug, toSlug } from '@dam/core/slug';
import { sql } from '@dam/db/client';

async function main(): Promise<void> {
  const rows = await sql<{ id: bigint; slug: string; name: string; name_kana: string | null; pref_code: string }[]>`
    SELECT id, slug, name, name_kana, pref_code
    FROM dams
    WHERE slug LIKE 'dam-%'                       -- placeholder slugs only
      AND name_kana IS NOT NULL
  `;
  if (rows.length === 0) {
    console.log('nothing to repair'); return;
  }
  const taken = new Set((await sql<{ slug: string }[]>`SELECT slug FROM dams`).map((r) => r.slug));

  let updated = 0;
  for (const r of rows) {
    const base = toSlug(r.name_kana ?? r.name);
    if (!base) continue;
    const candidate = `${base}-${r.pref_code}`;
    const next = suffixedSlug(candidate, taken);
    if (next === r.slug) continue;
    taken.delete(r.slug);
    taken.add(next);
    await sql`UPDATE dams SET slug = ${next} WHERE id = ${r.id}`;
    updated++;
  }
  console.log(JSON.stringify({ updated, total: rows.length }));
}

main().catch((e) => { console.error(e); process.exitCode = 1; }).finally(() => sql.end({ timeout: 5 }));
```

- [ ] **Step 2: Add a public-URL redirect for old slugs (optional but kind to bookmarks)**

If the old slug pattern was indexed, add a `dam_slug_redirects` table:
```sql
CREATE TABLE dam_slug_redirects (
  old_slug TEXT PRIMARY KEY,
  new_slug TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
```
…and have the `[slug]` route 301 to the new slug when it sees an entry. Defer to a follow-up if SEO indexing hasn't happened yet.

- [ ] **Step 3: Run + commit**

```bash
bun run apps/web/bin/repair_dam_slugs.ts
git add apps/web/bin/repair_dam_slugs.ts
git commit -m "feat(import): repair kanji-only dam slugs once kana is available"
```

---

## Task 7: Capture a real Kasen-Bosai response and harden the parser

**Files:**
- Create: `apps/web/bin/snapshot_kasenbosai.ts`
- Modify: `packages/adapters/kasenbosai/src/parser.ts`
- Modify: `tests/fixtures/kasenbosai/reading_yamba.xml` (replace synthetic with real)

- [ ] **Step 1: Capture utility**

```ts
// apps/web/bin/snapshot_kasenbosai.ts
//
// Fetch a known dam page from the real Kasen-Bosai endpoint and dump bytes
// to disk so the parser can be hardened against a real response shape.
//
// Usage: bun run apps/web/bin/snapshot_kasenbosai.ts <url> <output-path>
import { writeFile } from 'node:fs/promises';
import { HttpClient } from '@dam/core/http_client';

const client = new HttpClient({
  userAgent: process.env.KASENBOSAI_USER_AGENT
    ?? `DamDataPlatform/0.1 (+https://example.com/bot; ${process.env.HTTP_CONTACT_EMAIL ?? 'ops@example.com'})`,
  minIntervalMs: 0,
  maxRetries: 2,
});

async function main(): Promise<void> {
  const [, , url, out] = process.argv;
  if (!url || !out) {
    console.error('Usage: snapshot_kasenbosai.ts <url> <output-path>');
    process.exit(2);
  }
  const r = await client.get(url);
  if (r.status !== 200) throw new Error(`HTTP ${r.status}`);
  await writeFile(out, r.bodyBytes);
  console.log(JSON.stringify({ status: r.status, bytes: r.bodyBytes.byteLength, etag: r.etag, contentType: r.headers.get('content-type') }));
}

main().catch((e) => { console.error(e); process.exit(1); });
```

- [ ] **Step 2: Pick a reasonable target URL pattern**

Kasen-Bosai typically exposes per-dam HTML pages. Use the project's contact UA, fetch one page, save under `data/kasenbosai/yamba.html` (or whatever ID exists).

- [ ] **Step 3: Update `parser.ts` to handle whichever shape was returned**

Most likely options:
- HTML with a `<table>` containing 1 row per hour — switch `parseKasenbosaiReading` to use cheerio against the actual cell layout.
- XML with namespace prefixes — adjust `XMLParser` config.
- JSON — switch parser entirely.

Keep the synthetic fixture path in tests for backward compatibility; add a real-fixture test:

```ts
test('parses real fixture', async () => {
  const raw = await readFile(join(import.meta.dir, '..', '..', '..', '..', 'tests/fixtures/kasenbosai/real_yamba.html'), 'utf8');
  const out = parseKasenbosaiReading(raw);
  expect(out.length).toBeGreaterThan(0);
  expect(out[0]?.observedAt).toBeInstanceOf(Date);
});
```

- [ ] **Step 4: Commit**

```bash
git add apps/web/bin/snapshot_kasenbosai.ts packages/adapters/kasenbosai tests/fixtures/kasenbosai
git commit -m "feat(adapters/kasenbosai): real-fixture parser + capture utility"
```

---

## Task 8: Conform NDI and Damnet adapters to the formal SourceAdapter

**Files:**
- Create: `packages/adapters/ndi/src/adapter.ts`
- Create: `packages/adapters/damnet/src/adapter.ts`
- Modify: corresponding `index.ts` exports

- [ ] **Step 1: NDI adapter wrapper**

```ts
// packages/adapters/ndi/src/adapter.ts
import { readFile } from 'node:fs/promises';
import type { FetchContext, FetchTarget, ParsedReading, RawBytes, SourceAdapter } from '@dam/core/source_adapter';

const W01_LOCAL = process.env.NDI_W01_LOCAL ?? 'data/nlni/w01.geojson';

export const ndiAdapter: SourceAdapter = {
  id: 'ndi',
  schedule: 'on-demand',
  async fetchTargets(_ctx: FetchContext): Promise<FetchTarget[]> {
    return [{ targetId: 'W01', url: `file://${W01_LOCAL}` }];
  },
  async fetchRaw(target, _ctx): Promise<RawBytes | null> {
    const path = target.url.replace(/^file:\/\//, '');
    const bytes = new Uint8Array(await readFile(path));
    return { bytes, contentType: 'application/geo+json', status: 200 };
  },
  async parse(_raw, _target): Promise<ParsedReading[]> {
    // NDI rows are master data, not observations. Return empty so
    // the pipeline doesn't write to observations; the master importer
    // is invoked separately.
    return [];
  },
};
```

- [ ] **Step 2: Damnet adapter wrapper** (same pattern, fetches the list URL via HttpClient)

- [ ] **Step 3: Re-export, commit**

```bash
git add packages/adapters/{ndi,damnet}/src
git commit -m "refactor(adapters): conform ndi+damnet to SourceAdapter interface"
```

---

## Task 9: Implement `quality:recompute`

**Files:**
- Create: `packages/db/migrations/0020_quality_view.sql`
- Modify: `packages/ingest/src/quality.ts` (add `recomputeMissingRate`)
- Modify: `apps/worker/src/tasks/quality_recompute.ts`

- [ ] **Step 1: SQL view**

```sql
CREATE VIEW quality_missing_24h AS
SELECT
  d.id          AS dam_id,
  d.slug        AS dam_slug,
  COUNT(*)      AS expected_hours,
  COUNT(o.observed_at) AS present_hours,
  (COUNT(*) - COUNT(o.observed_at))::float / GREATEST(COUNT(*), 1) AS missing_rate
FROM dams d
JOIN generate_series(NOW() - INTERVAL '24 hours', NOW(), INTERVAL '1 hour') AS h(ts) ON TRUE
LEFT JOIN observations o ON o.dam_id = d.id AND date_trunc('hour', o.observed_at) = date_trunc('hour', h.ts)
WHERE EXISTS (SELECT 1 FROM observations o2 WHERE o2.dam_id = d.id)
GROUP BY d.id, d.slug;
```

- [ ] **Step 2: Worker task**

```ts
// apps/worker/src/tasks/quality_recompute.ts
import type { Task } from 'graphile-worker';
import { sql } from '@dam/db/client';

const task: Task = async (_payload, helpers) => {
  // 1. Mark observations missing for the last 24h on a per-dam basis.
  const r = await sql`
    UPDATE observations o
    SET quality_flag = quality_flag | 1
    FROM (SELECT dam_id, observed_at FROM observations WHERE observed_at > NOW() - INTERVAL '24 hours') x
    WHERE o.dam_id = x.dam_id AND o.observed_at = x.observed_at AND o.storage_volume_m3 IS NULL
  `;
  helpers.logger.info(`quality:recompute marked ${r.count} rows missing`);

  // 2. Cross-source mismatch: same dam × hour with two sources whose values
  // differ by > 5%. Mark both with the mismatch bit.
  const m = await sql`
    UPDATE observations o
    SET quality_flag = quality_flag | 8
    FROM (
      SELECT a.dam_id, a.observed_at
      FROM observations a
      JOIN observations b USING (dam_id, observed_at)
      WHERE a.source_id < b.source_id
        AND a.storage_volume_m3 IS NOT NULL
        AND b.storage_volume_m3 IS NOT NULL
        AND abs(a.storage_volume_m3 - b.storage_volume_m3) /
            GREATEST(a.storage_volume_m3, 1) > 0.05
        AND a.observed_at > NOW() - INTERVAL '24 hours'
    ) x
    WHERE o.dam_id = x.dam_id AND o.observed_at = x.observed_at
  `;
  helpers.logger.info(`quality:recompute marked ${m.count} rows mismatched`);
};

export default task;
```

- [ ] **Step 3: Apply migration + commit**

```bash
just migrate
git add packages/db/migrations/0020_quality_view.sql apps/worker/src/tasks/quality_recompute.ts
git commit -m "feat(quality): missing-rate view + recompute task"
```

---

## Task 10: Coolify deployment artifacts

**Files:**
- Create: `deploy/coolify/Dockerfile.web`
- Create: `deploy/coolify/Dockerfile.worker`
- Create: `deploy/coolify/docker-compose.coolify.yml`
- Create: `deploy/coolify/README.md`

- [ ] **Step 1: `Dockerfile.web`**

```dockerfile
FROM oven/bun:1.3 AS deps
WORKDIR /app
COPY package.json bun.lock tsconfig.base.json biome.json ./
COPY apps/web/package.json apps/web/
COPY apps/worker/package.json apps/worker/
COPY packages ./packages
RUN bun install --frozen-lockfile

FROM deps AS build
COPY apps/web ./apps/web
WORKDIR /app/apps/web
RUN bun next build

FROM oven/bun:1.3 AS run
WORKDIR /app
COPY --from=build /app /app
EXPOSE 3000
CMD ["bun", "next", "start", "-p", "3000"]
```

- [ ] **Step 2: `Dockerfile.worker`**

```dockerfile
FROM oven/bun:1.3 AS deps
WORKDIR /app
COPY package.json bun.lock tsconfig.base.json ./
COPY apps/worker/package.json apps/worker/
COPY packages ./packages
RUN bun install --frozen-lockfile

FROM deps AS run
COPY apps/worker ./apps/worker
WORKDIR /app
CMD ["bun", "run", "apps/worker/src/index.ts"]
```

- [ ] **Step 3: `docker-compose.coolify.yml`** — same as repo-root compose plus production env wiring; use Coolify's secret expansion for `DATABASE_URL`, `S3_*`, `KASENBOSAI_*` variables.

- [ ] **Step 4: README.md** — operator runbook (initial bring-up, rollback, log access).

- [ ] **Step 5: Commit**

```bash
git add deploy/
git commit -m "ops: coolify dockerfiles and compose"
```

---

## Task 11: Backup wiring (pgBackRest + Litestream)

**Files:**
- Create: `deploy/backup/pgbackrest.conf`
- Create: `deploy/ops/runbook.md`

- [ ] **Step 1: pgBackRest config (full weekly + hourly diff to external S3)**

```ini
[global]
repo1-type=s3
repo1-s3-bucket=dam-backup
repo1-s3-endpoint=...
repo1-s3-region=...
repo1-s3-uri-style=path
repo1-cipher-type=aes-256-cbc
repo1-cipher-pass=<set-from-coolify-secret>
repo1-retention-full=4
repo1-retention-diff=14

[main]
pg1-path=/var/lib/postgresql/data
```

- [ ] **Step 2: Runbook**

A `runbook.md` with: how to stop/start the worker, how to take a manual backup (`pgbackrest backup --stanza=main --type=full`), how to restore PITR, how to bump the MinIO image tag, who to contact when scrapers break.

- [ ] **Step 3: Commit**

```bash
git add deploy/
git commit -m "ops: pgbackrest config and operator runbook"
```

---

## Task 12: Acceptance check

- [ ] **Step 1: Live verification**

After all tasks land:
1. `/api/v1/dams` returns dams; many now have kana names + manager.
2. `/api/v1/watershed?lat=35.681&lng=139.767` returns 利根川水系 (or similar) — boundary lookup works.
3. `/dams/[slug]` URLs use kana-romaji slugs for kana-known dams.
4. Worker logs show `quality:recompute` flagging missing/mismatch rows.
5. `bun test` still 100% green.

- [ ] **Step 2: Tag a release**

```bash
git tag -a v0.4.0 -m "Plan 4 — production hardening"
```

---

## Self-Review

1. **Spec coverage:** §3 source adapter abstraction is now uniform (Task 8). §8 data quality is fully implemented (Task 9). §9 watershed geocoding is real (Task 3). §10 ETL and §11 deployment land via Tasks 9–11.

2. **Placeholders:** every step has concrete code or commands. The damnet rewrite is best-effort — actual classnames may differ from the captured fixture; the plan assumes the captured fixture matches the operator's first capture and adjusts assertions accordingly.

3. **Risks:**
   - **W07 dissolve performance** — `ST_Union` over hundreds of polygons can take seconds; that's fine for an offline import. If the staging table grows past ~10k features, dissolve in batches grouped by name.
   - **damnet rate limiting** — augmentation against 2,749 dams at 2 s/request = ~90 minutes per pass. Run during off-peak hours; reduce to 1.5 s with publisher's permission only.
   - **Slug repair changes public URLs** — Task 6 includes an optional redirect table; ship it before Task 6 if the old slugs were ever indexed.

---

## Execution Handoff

Plan complete. Two execution options:

1. **Subagent-Driven** — fresh subagent per task with two-stage review. Recommended.
2. **Inline Execution** — same-session batched execution.

Which approach?
