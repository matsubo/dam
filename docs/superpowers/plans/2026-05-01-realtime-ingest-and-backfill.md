# Realtime Ingest + Historical Backfill — Implementation Plan (Plan 2)

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add the observation-time-series layer (TimescaleDB hypertable + continuous aggregates), introduce a formal `SourceAdapter` contract, raw-snapshot persistence, source priorities, hourly realtime ingestion from 川の防災情報, and historical backfill from 水文水質DB.

**Architecture:** Two-layer data pipeline. Each scheduled run (a) fetches the source's target list, (b) for each target downloads raw bytes, persists them to MinIO as a `raw_snapshot`, then (c) parses and normalizes into the `observations` hypertable with provenance to the `raw_snapshot`. All adapters conform to one `SourceAdapter` interface so future sources are an isolated package. Continuous aggregates produce daily / monthly rollups for fast SEO and API reads.

**Tech Stack:** Same as Plan 1 (Bun, TypeScript, PostgreSQL 16 + TimescaleDB + PostGIS, graphile-worker). Adds `@aws-sdk/client-s3` for MinIO, plus `xml2js` (or `fast-xml-parser`) for `川の防災情報` XML feeds.

**Reference spec:** `docs/superpowers/specs/2026-05-01-dam-data-platform-design.md`

**Out of scope (handled by Plan 3):** public site (dam list / detail / map), SEO, ECharts, API key auth, rate limits.

**Out of scope (post-MVP):** alerts, prediction, per-utility adapters beyond Kasen-Bosai and Suimon-Suishitsu DB.

---

## File Structure

```
packages/
├── core/
│   └── src/
│       ├── source_adapter.ts                  # NEW: formal interface
│       └── prefectures.ts                     # NEW: extracted from damnet
├── db/
│   ├── migrations/
│   │   ├── 0011_observations.sql              # NEW: hypertable + columns
│   │   ├── 0012_raw_snapshots.sql             # NEW
│   │   ├── 0013_source_priorities.sql         # NEW
│   │   ├── 0014_observation_indexes.sql       # NEW
│   │   ├── 0015_continuous_aggregates.sql     # NEW: daily / monthly
│   │   └── 0016_backfill_progress.sql         # NEW
│   └── src/
│       ├── schema/
│       │   ├── observations.ts                # NEW
│       │   ├── raw_snapshots.ts               # NEW
│       │   ├── source_priorities.ts           # NEW
│       │   └── backfill_progress.ts           # NEW
│       └── repo/
│           ├── observations.ts                # NEW
│           ├── raw_snapshots.ts               # NEW
│           ├── source_priorities.ts           # NEW
│           └── backfill_progress.ts           # NEW
├── storage/                                   # NEW package
│   ├── package.json                           # @dam/storage
│   ├── src/
│   │   ├── client.ts                          # MinIO/S3 client wrapper
│   │   ├── snapshot_store.ts                  # save / load / key utilities
│   │   └── snapshot_store.test.ts
│   └── tsconfig.json
├── ingest/                                    # NEW: shared ingest plumbing
│   ├── package.json                           # @dam/ingest
│   ├── src/
│   │   ├── pipeline.ts                        # fetch → snapshot → parse → upsert
│   │   ├── pipeline.test.ts
│   │   ├── quality.ts                         # missing / outlier / mismatch
│   │   └── quality.test.ts
│   └── tsconfig.json
├── adapters/
│   ├── kasenbosai/                            # NEW: 川の防災情報
│   │   ├── package.json                       # @dam/adapters-kasenbosai
│   │   ├── src/
│   │   │   ├── adapter.ts                     # SourceAdapter impl
│   │   │   ├── targets.ts                     # which dams to fetch
│   │   │   ├── fetcher.ts                     # HTML/XML fetcher
│   │   │   ├── parser.ts                      # parse hour table → ParsedReading
│   │   │   ├── parser.test.ts
│   │   │   ├── normalize.ts
│   │   │   └── normalize.test.ts
│   │   └── tsconfig.json
│   └── suimon/                                # NEW: 水文水質DB
│       ├── package.json                       # @dam/adapters-suimon
│       ├── src/
│       │   ├── adapter.ts
│       │   ├── targets.ts                     # year × dam permutations
│       │   ├── parser.ts
│       │   ├── parser.test.ts
│       │   ├── normalize.ts
│       │   └── normalize.test.ts
│       └── tsconfig.json
apps/worker/
├── src/
│   ├── crontab.ts                             # MODIFY: add hourly + backfill
│   └── tasks/
│       ├── ingest_kasenbosai_targets.ts       # NEW
│       ├── ingest_kasenbosai_fetch.ts         # NEW
│       ├── ingest_kasenbosai_parse.ts         # NEW
│       ├── backfill_suimon_enqueue.ts         # NEW
│       ├── backfill_suimon_run.ts             # NEW
│       └── quality_recompute.ts               # NEW
apps/web/
└── app/api/v1/
    ├── dams/[slug]/observations/route.ts      # NEW (read-only API for now)
    └── sources/route.ts                       # MODIFY: real last_fetched_at from DB
docker-compose.yml                             # MODIFY: pin a working MinIO image
.env.example                                   # MODIFY: add S3_* keys (already there)
tests/fixtures/
├── kasenbosai/
│   ├── targets.html
│   └── reading_yamba.xml                      # representative 1h XML
└── suimon/
    └── reading_yamba_2020.csv                 # representative annual CSV
```

---

## Task 1: Pin a working MinIO image and bring up the bucket

**Files:**
- Modify: `docker-compose.yml` (pin a current MinIO RELEASE tag)
- Modify: `justfile` (add `mc-bucket` recipe to ensure bucket exists)
- Modify: `.env.example` (already contains S3 keys; verify)

- [ ] **Step 1: Pick a current MinIO image**

The Plan 1 docker-compose pins `minio/minio:RELEASE.2024-09-01T00-00-00Z`, which has been removed from Docker Hub. Replace with a pinned recent release.

```yaml
  minio:
    image: minio/minio:RELEASE.2025-04-22T22-12-26Z
    command: server /data --console-address ':9001'
    environment:
      MINIO_ROOT_USER: minio
      MINIO_ROOT_PASSWORD: minio12345
    ports: ['${MINIO_PORT:-9000}:9000', '${MINIO_CONSOLE_PORT:-9001}:9001']
    volumes:
      - minio_data:/data
    healthcheck:
      test: ['CMD', 'mc', 'ready', 'local']
      interval: 5s
      timeout: 5s
      retries: 20
```

- [ ] **Step 2: Add a justfile recipe to ensure the bucket exists**

```make
# Ensure the local raw-snapshot bucket exists
ensure-bucket:
    docker run --rm --network host \
        -e MC_HOST_local=http://${S3_ACCESS_KEY:-minio}:${S3_SECRET_KEY:-minio12345}@localhost:${MINIO_PORT:-9000} \
        minio/mc:RELEASE.2025-04-08T15-39-49Z mb --ignore-existing local/${S3_BUCKET:-dam-raw}
```

- [ ] **Step 3: Run and verify**

```bash
just up
just ensure-bucket
```

Expected: `local/dam-raw` is created (or `Bucket already exists`).

- [ ] **Step 4: Commit**
```bash
git add docker-compose.yml justfile
git commit -m "chore: pin minio image and add ensure-bucket recipe"
```

---

## Task 2: `@dam/storage` package — S3-compatible snapshot store

**Files:**
- Create: `packages/storage/package.json`
- Create: `packages/storage/tsconfig.json`
- Create: `packages/storage/src/client.ts`
- Create: `packages/storage/src/snapshot_store.ts`
- Test:   `packages/storage/src/snapshot_store.test.ts`

- [ ] **Step 1: `package.json`**

```json
{
  "name": "@dam/storage",
  "version": "0.0.0",
  "private": true,
  "type": "module",
  "exports": {
    ".": "./src/index.ts",
    "./client": "./src/client.ts",
    "./snapshot_store": "./src/snapshot_store.ts"
  },
  "scripts": { "typecheck": "tsc --noEmit" },
  "dependencies": {
    "@aws-sdk/client-s3": "^3.660.0"
  }
}
```

- [ ] **Step 2: `tsconfig.json`**
```json
{ "extends": "../../tsconfig.base.json", "include": ["src/**/*"] }
```

- [ ] **Step 3: `client.ts`**

```ts
// packages/storage/src/client.ts
import { S3Client } from '@aws-sdk/client-s3';

const endpoint = process.env.S3_ENDPOINT;
if (!endpoint) throw new Error('S3_ENDPOINT not set');

export const s3 = new S3Client({
  endpoint,
  region: process.env.S3_REGION ?? 'us-east-1',
  forcePathStyle: true,
  credentials: {
    accessKeyId: process.env.S3_ACCESS_KEY ?? '',
    secretAccessKey: process.env.S3_SECRET_KEY ?? '',
  },
});

export const bucket = process.env.S3_BUCKET ?? 'dam-raw';
```

- [ ] **Step 4: Test (TDD)**

```ts
// packages/storage/src/snapshot_store.test.ts
import { afterAll, describe, expect, test } from 'bun:test';
import { rawSnapshotKey, putSnapshot, getSnapshot } from './snapshot_store.ts';

const SOURCE = 'kasenbosai';
const TARGET = `test-${Date.now()}`;
const FETCHED = new Date('2026-05-01T05:00:00Z');

afterAll(async () => {
  // best-effort cleanup left to the bucket lifecycle
});

describe('rawSnapshotKey', () => {
  test('encodes UTC time and target id', () => {
    const k = rawSnapshotKey(SOURCE, TARGET, FETCHED, 'xml');
    expect(k).toBe(`raw/${SOURCE}/2026/05/01/05/${TARGET}.xml`);
  });
});

describe('snapshot store round trip', () => {
  test('put then get returns the same bytes', async () => {
    const key = rawSnapshotKey(SOURCE, TARGET, FETCHED, 'xml');
    const body = new TextEncoder().encode('<root>ok</root>');
    await putSnapshot(key, body, 'application/xml');
    const got = await getSnapshot(key);
    expect(new TextDecoder().decode(got)).toBe('<root>ok</root>');
  });
});
```

- [ ] **Step 5: Implement**

```ts
// packages/storage/src/snapshot_store.ts
import { GetObjectCommand, PutObjectCommand } from '@aws-sdk/client-s3';
import { bucket, s3 } from './client.ts';

export function rawSnapshotKey(
  source: string,
  targetId: string,
  fetchedAt: Date,
  ext: string,
): string {
  const yyyy = fetchedAt.getUTCFullYear();
  const mm = String(fetchedAt.getUTCMonth() + 1).padStart(2, '0');
  const dd = String(fetchedAt.getUTCDate()).padStart(2, '0');
  const hh = String(fetchedAt.getUTCHours()).padStart(2, '0');
  return `raw/${source}/${yyyy}/${mm}/${dd}/${hh}/${targetId}.${ext}`;
}

export async function putSnapshot(
  key: string,
  body: Uint8Array,
  contentType: string,
): Promise<void> {
  await s3.send(
    new PutObjectCommand({ Bucket: bucket, Key: key, Body: body, ContentType: contentType }),
  );
}

export async function getSnapshot(key: string): Promise<Uint8Array> {
  const r = await s3.send(new GetObjectCommand({ Bucket: bucket, Key: key }));
  if (!r.Body) throw new Error(`empty body for ${key}`);
  const chunks: Uint8Array[] = [];
  // @ts-expect-error: AsyncIterable<Uint8Array> from S3 client
  for await (const chunk of r.Body) chunks.push(chunk);
  const total = chunks.reduce((n, c) => n + c.byteLength, 0);
  const out = new Uint8Array(total);
  let o = 0;
  for (const c of chunks) {
    out.set(c, o);
    o += c.byteLength;
  }
  return out;
}
```

- [ ] **Step 6: `index.ts`**

```ts
export * from './snapshot_store.ts';
```

- [ ] **Step 7: Run**
```bash
just up && just ensure-bucket
bun install
bun test packages/storage
```

Expected: 2/2 pass.

- [ ] **Step 8: Commit**
```bash
git add packages/storage
git commit -m "feat(storage): @dam/storage snapshot store with key encoding"
```

---

## Task 3: Migration 0011 — observations hypertable

**Files:**
- Create: `packages/db/migrations/0011_observations.sql`

- [ ] **Step 1: Migration**

```sql
-- Time-series of normalized observations.
-- One row per (dam, observed_at, source). Multiple sources can disagree.
CREATE TABLE observations (
  observed_at         TIMESTAMPTZ NOT NULL,
  dam_id              BIGINT NOT NULL REFERENCES dams(id) ON DELETE RESTRICT,
  source_id           TEXT NOT NULL,                 -- 'kasenbosai', 'suimon', etc.

  storage_volume_m3   NUMERIC(18,2),                 -- 貯水量
  storage_rate        NUMERIC(6,4),                  -- 貯水率 [0..1]
  inflow_m3s          NUMERIC(12,3),                 -- 流入量
  outflow_m3s         NUMERIC(12,3),                 -- 放流量
  water_level_m       NUMERIC(8,3),                  -- 水位
  rainfall_mm         NUMERIC(8,2),                  -- 雨量

  raw_snapshot_id     BIGINT,                        -- FK added in 0012
  quality_flag        SMALLINT NOT NULL DEFAULT 0,   -- bitfield
  created_at          TIMESTAMPTZ NOT NULL DEFAULT NOW(),

  PRIMARY KEY (dam_id, observed_at, source_id)
);

SELECT create_hypertable(
  'observations',
  'observed_at',
  chunk_time_interval => INTERVAL '14 days',
  if_not_exists => TRUE
);

COMMENT ON COLUMN observations.quality_flag IS
  'bitfield: 1=missing(imputed), 2=outlier, 4=interpolated, 8=mismatch_with_other_source, 16=manual_review';
```

- [ ] **Step 2: Apply and verify**
```bash
just migrate
docker compose exec db psql -U dam -d dam -c "\dt+ observations"
docker compose exec db psql -U dam -d dam -c "SELECT * FROM timescaledb_information.hypertables WHERE hypertable_name = 'observations';"
```
Expected: hypertable row present.

- [ ] **Step 3: Commit**
```bash
git add packages/db/migrations/0011_observations.sql
git commit -m "feat(db): observations hypertable"
```

---

## Task 4: Migration 0012 — raw_snapshots

**Files:**
- Create: `packages/db/migrations/0012_raw_snapshots.sql`

- [ ] **Step 1: Migration**

```sql
CREATE TABLE raw_snapshots (
  id              BIGSERIAL PRIMARY KEY,
  source_id       TEXT NOT NULL,
  target_id       TEXT NOT NULL,
  fetched_at      TIMESTAMPTZ NOT NULL,
  storage_uri     TEXT NOT NULL,                  -- e.g. s3://dam-raw/raw/kasenbosai/...
  http_status     INT,
  etag            TEXT,
  bytes           INT,
  content_type    TEXT,
  parse_status    TEXT NOT NULL DEFAULT 'pending'
                  CHECK (parse_status IN ('pending','parsed','parse_error','skipped')),
  parse_error     TEXT,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (source_id, target_id, fetched_at)
);

CREATE INDEX raw_snapshots_source_fetched_at
  ON raw_snapshots (source_id, fetched_at DESC);

ALTER TABLE observations
  ADD CONSTRAINT observations_raw_snapshot_fk
  FOREIGN KEY (raw_snapshot_id) REFERENCES raw_snapshots(id) ON DELETE SET NULL;
```

- [ ] **Step 2: Apply**
```bash
just migrate
```

- [ ] **Step 3: Commit**
```bash
git add packages/db/migrations/0012_raw_snapshots.sql
git commit -m "feat(db): raw_snapshots table and FK from observations"
```

---

## Task 5: Migration 0013 — source_priorities

**Files:**
- Create: `packages/db/migrations/0013_source_priorities.sql`

- [ ] **Step 1: Migration**

```sql
CREATE TABLE source_priorities (
  source_id   TEXT PRIMARY KEY,
  priority    INT NOT NULL,                  -- higher wins on tie
  description TEXT,
  active      BOOLEAN NOT NULL DEFAULT TRUE
);

INSERT INTO source_priorities (source_id, priority, description) VALUES
  ('kasenbosai', 100, '川の防災情報 (real-time MLIT)'),
  ('suimon',      90, '水文水質DB (historical MLIT)'),
  ('damnet',      50, 'ダム便覧 (master attributes)'),
  ('ndi',         80, '国土数値情報 (master location/code)');
```

- [ ] **Step 2: Apply and verify**
```bash
just migrate
docker compose exec db psql -U dam -d dam -c "SELECT * FROM source_priorities ORDER BY priority DESC;"
```

- [ ] **Step 3: Commit**
```bash
git add packages/db/migrations/0013_source_priorities.sql
git commit -m "feat(db): source_priorities seed table"
```

---

## Task 6: Migration 0014 — observation indexes + retention setup

**Files:**
- Create: `packages/db/migrations/0014_observation_indexes.sql`

- [ ] **Step 1: Migration**

```sql
-- Most queries: "give me the time series for one dam"
CREATE INDEX observations_dam_time
  ON observations (dam_id, observed_at DESC);

-- Source-tracking and provenance lookups
CREATE INDEX observations_source_time
  ON observations (source_id, observed_at DESC);

-- Compress chunks older than 30 days (TimescaleDB columnar compression)
ALTER TABLE observations SET (
  timescaledb.compress,
  timescaledb.compress_segmentby = 'dam_id',
  timescaledb.compress_orderby = 'observed_at DESC, source_id'
);

SELECT add_compression_policy('observations', INTERVAL '30 days', if_not_exists => TRUE);
```

- [ ] **Step 2: Apply and verify**
```bash
just migrate
docker compose exec db psql -U dam -d dam -c "\di+ observations*"
docker compose exec db psql -U dam -d dam -c "SELECT * FROM timescaledb_information.compression_settings WHERE hypertable_name = 'observations';"
```

- [ ] **Step 3: Commit**
```bash
git add packages/db/migrations/0014_observation_indexes.sql
git commit -m "feat(db): observation indexes and compression policy"
```

---

## Task 7: Migration 0015 — daily and monthly continuous aggregates

**Files:**
- Create: `packages/db/migrations/0015_continuous_aggregates.sql`

- [ ] **Step 1: Migration**

Note: continuous aggregates cannot be created inside a transaction in some
TimescaleDB versions. The migration runner wraps each file in a transaction.
Adjust the runner once (if needed) to skip the wrapper for files marked
with a leading `-- @no-transaction` comment, OR create the agg via CREATE
... WITH NO DATA followed by `add_continuous_aggregate_policy` (which is
transaction-safe).

```sql
-- Daily aggregate, one bucket per dam per day, summarized across all sources.
-- For per-source separation see continuous-agg refinement in Plan 3.
CREATE MATERIALIZED VIEW obs_daily WITH (timescaledb.continuous) AS
SELECT
  dam_id,
  time_bucket('1 day', observed_at) AS day,
  avg(storage_volume_m3)            AS avg_storage_volume_m3,
  max(storage_volume_m3)            AS max_storage_volume_m3,
  min(storage_volume_m3)            AS min_storage_volume_m3,
  last(storage_volume_m3, observed_at) AS last_storage_volume_m3,
  avg(storage_rate)                 AS avg_storage_rate,
  sum(rainfall_mm)                  AS total_rainfall_mm,
  count(*) FILTER (WHERE storage_volume_m3 IS NOT NULL) AS n_storage_volume,
  count(*) FILTER (WHERE rainfall_mm      IS NOT NULL) AS n_rainfall
FROM observations
GROUP BY dam_id, day
WITH NO DATA;

SELECT add_continuous_aggregate_policy(
  'obs_daily',
  start_offset => INTERVAL '60 days',
  end_offset   => INTERVAL '1 hour',
  schedule_interval => INTERVAL '30 minutes'
);

CREATE MATERIALIZED VIEW obs_monthly WITH (timescaledb.continuous) AS
SELECT
  dam_id,
  time_bucket('1 month', day) AS month,
  avg(avg_storage_volume_m3) AS avg_storage_volume_m3,
  max(max_storage_volume_m3) AS max_storage_volume_m3,
  min(min_storage_volume_m3) AS min_storage_volume_m3,
  sum(total_rainfall_mm)     AS total_rainfall_mm
FROM obs_daily
GROUP BY dam_id, month
WITH NO DATA;

SELECT add_continuous_aggregate_policy(
  'obs_monthly',
  start_offset => INTERVAL '5 years',
  end_offset   => INTERVAL '1 day',
  schedule_interval => INTERVAL '1 day'
);
```

- [ ] **Step 2: Apply and verify**
```bash
just migrate
docker compose exec db psql -U dam -d dam -c "\dv obs_*"
docker compose exec db psql -U dam -d dam -c "SELECT view_name, view_definition FROM timescaledb_information.continuous_aggregates;"
```

- [ ] **Step 3: Commit**
```bash
git add packages/db/migrations/0015_continuous_aggregates.sql
git commit -m "feat(db): obs_daily and obs_monthly continuous aggregates"
```

---

## Task 8: Migration 0016 — backfill_progress

**Files:**
- Create: `packages/db/migrations/0016_backfill_progress.sql`

- [ ] **Step 1: Migration**

```sql
CREATE TABLE backfill_progress (
  source_id   TEXT NOT NULL,
  dam_id      BIGINT NOT NULL REFERENCES dams(id) ON DELETE CASCADE,
  year        INT NOT NULL,
  status      TEXT NOT NULL CHECK (status IN ('pending','running','completed','failed','skipped')),
  attempts    INT NOT NULL DEFAULT 0,
  last_error  TEXT,
  started_at  TIMESTAMPTZ,
  completed_at TIMESTAMPTZ,
  rows_written INT,
  PRIMARY KEY (source_id, dam_id, year)
);

CREATE INDEX backfill_progress_status_year
  ON backfill_progress (status, year DESC);
```

- [ ] **Step 2: Apply and commit**
```bash
just migrate
git add packages/db/migrations/0016_backfill_progress.sql
git commit -m "feat(db): backfill_progress tracking table"
```

---

## Task 9: Drizzle schemas for new tables

**Files:**
- Create: `packages/db/src/schema/observations.ts`
- Create: `packages/db/src/schema/raw_snapshots.ts`
- Create: `packages/db/src/schema/source_priorities.ts`
- Create: `packages/db/src/schema/backfill_progress.ts`
- Modify: `packages/db/src/schema/index.ts` (re-export new tables)

- [ ] **Step 1: `observations.ts`**

```ts
import { bigint, numeric, pgTable, primaryKey, smallint, text, timestamp } from 'drizzle-orm/pg-core';

export const observations = pgTable(
  'observations',
  {
    observedAt: timestamp('observed_at', { withTimezone: true }).notNull(),
    damId: bigint('dam_id', { mode: 'bigint' }).notNull(),
    sourceId: text('source_id').notNull(),
    storageVolumeM3: numeric('storage_volume_m3'),
    storageRate: numeric('storage_rate'),
    inflowM3s: numeric('inflow_m3s'),
    outflowM3s: numeric('outflow_m3s'),
    waterLevelM: numeric('water_level_m'),
    rainfallMm: numeric('rainfall_mm'),
    rawSnapshotId: bigint('raw_snapshot_id', { mode: 'bigint' }),
    qualityFlag: smallint('quality_flag').notNull().default(0),
    createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => ({ pk: primaryKey({ columns: [t.damId, t.observedAt, t.sourceId] }) }),
);

export type Observation = typeof observations.$inferSelect;
export type NewObservation = typeof observations.$inferInsert;
```

- [ ] **Step 2: `raw_snapshots.ts`**

```ts
import { bigserial, integer, pgTable, text, timestamp, unique } from 'drizzle-orm/pg-core';

export const rawSnapshots = pgTable(
  'raw_snapshots',
  {
    id: bigserial('id', { mode: 'bigint' }).primaryKey(),
    sourceId: text('source_id').notNull(),
    targetId: text('target_id').notNull(),
    fetchedAt: timestamp('fetched_at', { withTimezone: true }).notNull(),
    storageUri: text('storage_uri').notNull(),
    httpStatus: integer('http_status'),
    etag: text('etag'),
    bytes: integer('bytes'),
    contentType: text('content_type'),
    parseStatus: text('parse_status').notNull().default('pending'),
    parseError: text('parse_error'),
    createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => ({ uniq: unique('raw_snapshots_uniq').on(t.sourceId, t.targetId, t.fetchedAt) }),
);

export type RawSnapshot = typeof rawSnapshots.$inferSelect;
export type NewRawSnapshot = typeof rawSnapshots.$inferInsert;
```

- [ ] **Step 3: `source_priorities.ts`**

```ts
import { boolean, integer, pgTable, text } from 'drizzle-orm/pg-core';

export const sourcePriorities = pgTable('source_priorities', {
  sourceId: text('source_id').primaryKey(),
  priority: integer('priority').notNull(),
  description: text('description'),
  active: boolean('active').notNull().default(true),
});

export type SourcePriority = typeof sourcePriorities.$inferSelect;
```

- [ ] **Step 4: `backfill_progress.ts`**

```ts
import { bigint, integer, pgTable, primaryKey, text, timestamp } from 'drizzle-orm/pg-core';

export const backfillProgress = pgTable(
  'backfill_progress',
  {
    sourceId: text('source_id').notNull(),
    damId: bigint('dam_id', { mode: 'bigint' }).notNull(),
    year: integer('year').notNull(),
    status: text('status', {
      enum: ['pending', 'running', 'completed', 'failed', 'skipped'],
    }).notNull(),
    attempts: integer('attempts').notNull().default(0),
    lastError: text('last_error'),
    startedAt: timestamp('started_at', { withTimezone: true }),
    completedAt: timestamp('completed_at', { withTimezone: true }),
    rowsWritten: integer('rows_written'),
  },
  (t) => ({ pk: primaryKey({ columns: [t.sourceId, t.damId, t.year] }) }),
);

export type BackfillProgress = typeof backfillProgress.$inferSelect;
```

- [ ] **Step 5: `schema/index.ts` re-exports**

Append:
```ts
export * from './observations.ts';
export * from './raw_snapshots.ts';
export * from './source_priorities.ts';
export * from './backfill_progress.ts';
```

- [ ] **Step 6: Typecheck and commit**
```bash
bun run --filter @dam/db typecheck
git add packages/db/src/schema
git commit -m "feat(db): drizzle schemas for observations and surrounding tables"
```

---

## Task 10: Repos for the new tables (TDD with integration)

**Files:**
- Create: `packages/db/src/repo/raw_snapshots.ts`
- Create: `packages/db/src/repo/observations.ts`
- Create: `packages/db/src/repo/source_priorities.ts`
- Create: `packages/db/src/repo/backfill_progress.ts`
- Test:   `packages/db/src/repo/observations.test.ts`

- [ ] **Step 1: `raw_snapshots.ts`**

```ts
import { sql } from '../client.ts';

export interface NewRawSnapshotInput {
  sourceId: string;
  targetId: string;
  fetchedAt: Date;
  storageUri: string;
  httpStatus?: number | null;
  etag?: string | null;
  bytes?: number | null;
  contentType?: string | null;
}

export async function recordRawSnapshot(input: NewRawSnapshotInput): Promise<bigint> {
  const rows = await sql<{ id: bigint }[]>`
    INSERT INTO raw_snapshots (source_id, target_id, fetched_at, storage_uri,
                               http_status, etag, bytes, content_type, parse_status)
    VALUES (${input.sourceId}, ${input.targetId}, ${input.fetchedAt}, ${input.storageUri},
            ${input.httpStatus ?? null}, ${input.etag ?? null}, ${input.bytes ?? null},
            ${input.contentType ?? null}, 'pending')
    ON CONFLICT (source_id, target_id, fetched_at) DO UPDATE SET
      storage_uri = EXCLUDED.storage_uri,
      http_status = EXCLUDED.http_status,
      etag = EXCLUDED.etag,
      bytes = EXCLUDED.bytes,
      content_type = EXCLUDED.content_type
    RETURNING id
  `;
  const row = rows[0];
  if (!row) throw new Error('recordRawSnapshot returned no row');
  return row.id;
}

export async function markParsed(id: bigint): Promise<void> {
  await sql`UPDATE raw_snapshots SET parse_status = 'parsed', parse_error = NULL WHERE id = ${id}`;
}

export async function markParseError(id: bigint, message: string): Promise<void> {
  await sql`UPDATE raw_snapshots SET parse_status = 'parse_error', parse_error = ${message} WHERE id = ${id}`;
}

export async function previousEtag(sourceId: string, targetId: string): Promise<string | null> {
  const rows = await sql<{ etag: string | null }[]>`
    SELECT etag FROM raw_snapshots
    WHERE source_id = ${sourceId} AND target_id = ${targetId}
    ORDER BY fetched_at DESC LIMIT 1
  `;
  return rows[0]?.etag ?? null;
}
```

- [ ] **Step 2: `observations.ts`**

```ts
import { sql } from '../client.ts';

export interface ObservationInput {
  observedAt: Date;
  damId: bigint;
  sourceId: string;
  storageVolumeM3?: number | null;
  storageRate?: number | null;
  inflowM3s?: number | null;
  outflowM3s?: number | null;
  waterLevelM?: number | null;
  rainfallMm?: number | null;
  rawSnapshotId?: bigint | null;
  qualityFlag?: number;
}

export async function upsertObservations(rows: ObservationInput[]): Promise<number> {
  if (rows.length === 0) return 0;
  // Build a single multi-row INSERT for performance
  const values = rows.map((r) => ({
    observed_at: r.observedAt,
    dam_id: r.damId,
    source_id: r.sourceId,
    storage_volume_m3: r.storageVolumeM3 ?? null,
    storage_rate: r.storageRate ?? null,
    inflow_m3s: r.inflowM3s ?? null,
    outflow_m3s: r.outflowM3s ?? null,
    water_level_m: r.waterLevelM ?? null,
    rainfall_mm: r.rainfallMm ?? null,
    raw_snapshot_id: r.rawSnapshotId ?? null,
    quality_flag: r.qualityFlag ?? 0,
  }));
  const result = await sql`
    INSERT INTO observations ${sql(values)}
    ON CONFLICT (dam_id, observed_at, source_id) DO UPDATE SET
      storage_volume_m3 = EXCLUDED.storage_volume_m3,
      storage_rate      = EXCLUDED.storage_rate,
      inflow_m3s        = EXCLUDED.inflow_m3s,
      outflow_m3s       = EXCLUDED.outflow_m3s,
      water_level_m     = EXCLUDED.water_level_m,
      rainfall_mm       = EXCLUDED.rainfall_mm,
      raw_snapshot_id   = COALESCE(EXCLUDED.raw_snapshot_id, observations.raw_snapshot_id),
      quality_flag      = EXCLUDED.quality_flag
  `;
  return result.count;
}

export interface SeriesPoint {
  observedAt: Date;
  storageVolumeM3: number | null;
  storageRate: number | null;
  qualityFlag: number;
  sourceId: string;
}

export async function findSeries(opts: {
  damId: bigint;
  from: Date;
  to: Date;
  bucket: 'hourly' | 'daily' | 'monthly';
  preferredSource?: string | null;
}): Promise<SeriesPoint[]> {
  if (opts.bucket === 'hourly') {
    return sql<SeriesPoint[]>`
      SELECT observed_at AS "observedAt",
             storage_volume_m3 AS "storageVolumeM3",
             storage_rate AS "storageRate",
             quality_flag AS "qualityFlag",
             source_id AS "sourceId"
      FROM observations
      WHERE dam_id = ${opts.damId}
        AND observed_at >= ${opts.from}
        AND observed_at <  ${opts.to}
        AND (${opts.preferredSource ?? null}::text IS NULL OR source_id = ${opts.preferredSource ?? null})
      ORDER BY observed_at
    `;
  }
  const view = opts.bucket === 'daily' ? sql`obs_daily` : sql`obs_monthly`;
  const ts = opts.bucket === 'daily' ? sql`day` : sql`month`;
  return sql<SeriesPoint[]>`
    SELECT ${ts} AS "observedAt",
           last_storage_volume_m3 AS "storageVolumeM3",
           NULL::NUMERIC AS "storageRate",
           0::SMALLINT AS "qualityFlag",
           'aggregate' AS "sourceId"
    FROM ${view}
    WHERE dam_id = ${opts.damId}
      AND ${ts} >= ${opts.from}
      AND ${ts} <  ${opts.to}
    ORDER BY ${ts}
  `;
}
```

- [ ] **Step 3: `source_priorities.ts`**

```ts
import { sql } from '../client.ts';

export async function preferredSource(): Promise<string | null> {
  const rows = await sql<{ source_id: string }[]>`
    SELECT source_id FROM source_priorities WHERE active ORDER BY priority DESC LIMIT 1
  `;
  return rows[0]?.source_id ?? null;
}

export async function priorityMap(): Promise<Map<string, number>> {
  const rows = await sql<{ source_id: string; priority: number }[]>`
    SELECT source_id, priority FROM source_priorities WHERE active
  `;
  return new Map(rows.map((r) => [r.source_id, r.priority] as const));
}
```

- [ ] **Step 4: `backfill_progress.ts`**

```ts
import { sql } from '../client.ts';

export async function nextPending(sourceId: string, limit = 10): Promise<{ damId: bigint; year: number }[]> {
  const rows = await sql<{ damId: bigint; year: number }[]>`
    SELECT dam_id AS "damId", year FROM backfill_progress
    WHERE source_id = ${sourceId} AND status = 'pending'
    ORDER BY year DESC LIMIT ${limit}
  `;
  return rows;
}

export async function startRunning(sourceId: string, damId: bigint, year: number): Promise<void> {
  await sql`
    UPDATE backfill_progress
    SET status = 'running', started_at = NOW(), attempts = attempts + 1
    WHERE source_id = ${sourceId} AND dam_id = ${damId} AND year = ${year}
  `;
}

export async function complete(sourceId: string, damId: bigint, year: number, rowsWritten: number): Promise<void> {
  await sql`
    UPDATE backfill_progress
    SET status = 'completed', completed_at = NOW(), rows_written = ${rowsWritten}, last_error = NULL
    WHERE source_id = ${sourceId} AND dam_id = ${damId} AND year = ${year}
  `;
}

export async function fail(sourceId: string, damId: bigint, year: number, msg: string): Promise<void> {
  await sql`
    UPDATE backfill_progress
    SET status = 'failed', last_error = ${msg}
    WHERE source_id = ${sourceId} AND dam_id = ${damId} AND year = ${year}
  `;
}

export async function enqueueAllDams(sourceId: string, fromYear: number, toYear: number): Promise<number> {
  const r = await sql`
    INSERT INTO backfill_progress (source_id, dam_id, year, status)
    SELECT ${sourceId}, d.id, y.year, 'pending'
    FROM dams d
    CROSS JOIN generate_series(${fromYear}, ${toYear}) AS y(year)
    ON CONFLICT (source_id, dam_id, year) DO NOTHING
  `;
  return r.count;
}
```

- [ ] **Step 5: Test (integration TDD)**

```ts
// packages/db/src/repo/observations.test.ts
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { sql } from '../client.ts';
import { upsertDamByExternalId } from './dams.ts';
import { findSeries, upsertObservations } from './observations.ts';

let damId: bigint;

beforeAll(async () => {
  await sql`DELETE FROM dams WHERE external_ids ->> 'ndi' = 'OBS-TEST-1'`;
  damId = await upsertDamByExternalId('ndi', {
    slug: 'obs-test-1',
    name: 'Obs Test',
    prefCode: '13',
    lat: 35.7,
    lng: 139.5,
    externalIds: { ndi: 'OBS-TEST-1' },
  });
});

afterAll(async () => {
  await sql`DELETE FROM observations WHERE dam_id = ${damId}`;
  await sql`DELETE FROM dams WHERE id = ${damId}`;
});

describe('observations repo', () => {
  test('upsert + find round trip', async () => {
    const t0 = new Date('2026-04-30T10:00:00Z');
    const t1 = new Date('2026-04-30T11:00:00Z');
    await upsertObservations([
      { observedAt: t0, damId, sourceId: 'kasenbosai', storageVolumeM3: 1_000_000, storageRate: 0.5 },
      { observedAt: t1, damId, sourceId: 'kasenbosai', storageVolumeM3: 1_010_000, storageRate: 0.51 },
    ]);
    const series = await findSeries({
      damId,
      from: new Date('2026-04-30T00:00:00Z'),
      to: new Date('2026-05-01T00:00:00Z'),
      bucket: 'hourly',
    });
    expect(series.length).toBe(2);
    expect(Number(series[0]?.storageVolumeM3)).toBe(1_000_000);
  });

  test('upsert is idempotent', async () => {
    const t = new Date('2026-04-30T12:00:00Z');
    await upsertObservations([
      { observedAt: t, damId, sourceId: 'kasenbosai', storageVolumeM3: 999_999 },
    ]);
    await upsertObservations([
      { observedAt: t, damId, sourceId: 'kasenbosai', storageVolumeM3: 999_999 },
    ]);
    const rows = await sql<{ n: bigint }[]>`
      SELECT COUNT(*)::BIGINT AS n FROM observations
      WHERE dam_id = ${damId} AND observed_at = ${t} AND source_id = 'kasenbosai'
    `;
    expect(Number(rows[0]?.n ?? 0)).toBe(1);
  });
});
```

- [ ] **Step 6: Run, then commit**
```bash
bun test packages/db/src/repo/observations.test.ts
git add packages/db/src/repo
git commit -m "feat(db): repos for observations, raw_snapshots, source_priorities, backfill_progress"
```

---

## Task 11: `SourceAdapter` interface in `@dam/core`

**Files:**
- Create: `packages/core/src/source_adapter.ts`
- Modify: `packages/core/src/index.ts`
- Modify: `packages/core/package.json` (add `./source_adapter` subpath export)

- [ ] **Step 1: `source_adapter.ts`**

```ts
// packages/core/src/source_adapter.ts
export type Schedule = 'hourly' | 'daily' | 'on-demand';

export interface FetchTarget {
  /** Stable identifier within the source (e.g., kasenbosai dam id) */
  targetId: string;
  /** URL to fetch */
  url: string;
  /** Optional metadata that the parser will need (no I/O here) */
  meta?: Record<string, string>;
}

export interface RawBytes {
  bytes: Uint8Array;
  contentType: string;
  etag?: string;
  status: number;
}

export interface ParsedReading {
  damExternalId: { source: string; id: string };
  observedAt: Date;
  storageVolumeM3?: number | null;
  storageRate?: number | null;
  inflowM3s?: number | null;
  outflowM3s?: number | null;
  waterLevelM?: number | null;
  rainfallMm?: number | null;
}

export interface SourceAdapter {
  readonly id: string;                     // matches source_priorities.source_id
  readonly schedule: Schedule;
  fetchTargets(ctx: FetchContext): Promise<FetchTarget[]>;
  fetchRaw(target: FetchTarget, ctx: FetchContext): Promise<RawBytes | null>;  // null = unchanged (304)
  parse(raw: RawBytes, target: FetchTarget): Promise<ParsedReading[]>;
}

export interface FetchContext {
  /** When the run started — adapters should use this for snapshot timestamps */
  runAt: Date;
}
```

- [ ] **Step 2: re-export from `index.ts`**

Append:
```ts
export * from './source_adapter.ts';
```

- [ ] **Step 3: Add `./source_adapter` subpath in `packages/core/package.json` exports**

Update the `exports` block to include:
```json
"./source_adapter": "./src/source_adapter.ts",
```

- [ ] **Step 4: Typecheck and commit**
```bash
bun run --filter @dam/core typecheck
git add packages/core/src/source_adapter.ts packages/core/src/index.ts packages/core/package.json
git commit -m "feat(core): SourceAdapter interface"
```

---

## Task 12: Extract prefectures lookup to `@dam/core`

**Files:**
- Create: `packages/core/src/prefectures.ts`
- Modify: `packages/adapters/damnet/src/list_scraper.ts` (re-export the helper from core)
- Modify: `packages/core/package.json` (subpath export `./prefectures`)
- Modify: `packages/core/src/index.ts` (re-export)

- [ ] **Step 1: `prefectures.ts`**

```ts
// packages/core/src/prefectures.ts
export const PREFECTURES: ReadonlyArray<{ code: string; name: string }> = [
  { code: '01', name: '北海道' },  { code: '02', name: '青森県' },  { code: '03', name: '岩手県' },
  { code: '04', name: '宮城県' },  { code: '05', name: '秋田県' },  { code: '06', name: '山形県' },
  { code: '07', name: '福島県' },  { code: '08', name: '茨城県' },  { code: '09', name: '栃木県' },
  { code: '10', name: '群馬県' },  { code: '11', name: '埼玉県' },  { code: '12', name: '千葉県' },
  { code: '13', name: '東京都' },  { code: '14', name: '神奈川県' }, { code: '15', name: '新潟県' },
  { code: '16', name: '富山県' },  { code: '17', name: '石川県' },  { code: '18', name: '福井県' },
  { code: '19', name: '山梨県' },  { code: '20', name: '長野県' },  { code: '21', name: '岐阜県' },
  { code: '22', name: '静岡県' },  { code: '23', name: '愛知県' },  { code: '24', name: '三重県' },
  { code: '25', name: '滋賀県' },  { code: '26', name: '京都府' },  { code: '27', name: '大阪府' },
  { code: '28', name: '兵庫県' },  { code: '29', name: '奈良県' },  { code: '30', name: '和歌山県' },
  { code: '31', name: '鳥取県' },  { code: '32', name: '島根県' },  { code: '33', name: '岡山県' },
  { code: '34', name: '広島県' },  { code: '35', name: '山口県' },  { code: '36', name: '徳島県' },
  { code: '37', name: '香川県' },  { code: '38', name: '愛媛県' },  { code: '39', name: '高知県' },
  { code: '40', name: '福岡県' },  { code: '41', name: '佐賀県' },  { code: '42', name: '長崎県' },
  { code: '43', name: '熊本県' },  { code: '44', name: '大分県' },  { code: '45', name: '宮崎県' },
  { code: '46', name: '鹿児島県' },{ code: '47', name: '沖縄県' },
];

const NAME_TO_CODE = new Map(PREFECTURES.map((p) => [p.name, p.code] as const));

export function prefNameToCode(name: string): string {
  const code = NAME_TO_CODE.get(name);
  if (!code) throw new Error(`Unknown prefecture name: ${name}`);
  return code;
}
```

- [ ] **Step 2: Replace duplicate map in damnet `list_scraper.ts`**

In `packages/adapters/damnet/src/list_scraper.ts`, delete the local `PREF_NAME_TO_CODE` map and `prefNameToCode` function and import from `@dam/core/prefectures`. Re-export the imported `prefNameToCode` so existing imports in `detail_parser.ts` continue to work:
```ts
export { prefNameToCode } from '@dam/core/prefectures';
```

- [ ] **Step 3: Update `packages/core/package.json` exports and `index.ts`**

Add subpath export `./prefectures` and re-export from `index.ts`.

- [ ] **Step 4: Run tests + commit**
```bash
bun test packages/adapters/damnet
bun run typecheck
git add packages/core/src/prefectures.ts packages/core/src/index.ts packages/core/package.json packages/adapters/damnet/src/list_scraper.ts
git commit -m "refactor(core): extract prefectures lookup; reuse in damnet"
```

---

## Task 13: `@dam/ingest` package — shared pipeline + quality functions

**Files:**
- Create: `packages/ingest/package.json`
- Create: `packages/ingest/tsconfig.json`
- Create: `packages/ingest/src/pipeline.ts`
- Test:   `packages/ingest/src/pipeline.test.ts`
- Create: `packages/ingest/src/quality.ts`
- Test:   `packages/ingest/src/quality.test.ts`

- [ ] **Step 1: `package.json`**

```json
{
  "name": "@dam/ingest",
  "version": "0.0.0",
  "private": true,
  "type": "module",
  "exports": {
    ".": "./src/index.ts",
    "./pipeline": "./src/pipeline.ts",
    "./quality": "./src/quality.ts"
  },
  "scripts": { "typecheck": "tsc --noEmit" },
  "dependencies": {
    "@dam/core": "workspace:*",
    "@dam/db": "workspace:*",
    "@dam/storage": "workspace:*"
  }
}
```

- [ ] **Step 2: Quality test (TDD)**

```ts
// packages/ingest/src/quality.test.ts
import { describe, expect, test } from 'bun:test';
import { detectOutlier, isPhysicallyValid, QualityFlag } from './quality.ts';

describe('isPhysicallyValid', () => {
  test('rejects negative storage rate', () => {
    expect(isPhysicallyValid({ storageRate: -0.1 })).toBe(false);
  });
  test('rejects storage rate > 1.5 (allow some headroom for emergency overflow)', () => {
    expect(isPhysicallyValid({ storageRate: 1.6 })).toBe(false);
    expect(isPhysicallyValid({ storageRate: 1.4 })).toBe(true);
  });
  test('accepts zero', () => {
    expect(isPhysicallyValid({ storageRate: 0, storageVolumeM3: 0 })).toBe(true);
  });
});

describe('detectOutlier', () => {
  test('flag when delta > 30% in 1h', () => {
    expect(detectOutlier({ prev: 1_000_000, current: 1_400_000 })).toBe(true);
  });
  test('do not flag normal change', () => {
    expect(detectOutlier({ prev: 1_000_000, current: 1_010_000 })).toBe(false);
  });
  test('null prev disables detection', () => {
    expect(detectOutlier({ prev: null, current: 1_000_000 })).toBe(false);
  });
});

describe('QualityFlag bit math', () => {
  test('exposes the documented bits', () => {
    expect(QualityFlag.Missing).toBe(1);
    expect(QualityFlag.Outlier).toBe(2);
    expect(QualityFlag.Interpolated).toBe(4);
    expect(QualityFlag.Mismatch).toBe(8);
    expect(QualityFlag.ManualReview).toBe(16);
  });
});
```

- [ ] **Step 3: Quality impl**

```ts
// packages/ingest/src/quality.ts
export const QualityFlag = {
  Missing: 1,
  Outlier: 2,
  Interpolated: 4,
  Mismatch: 8,
  ManualReview: 16,
} as const;

export interface PhysicalCheck {
  storageRate?: number | null;
  storageVolumeM3?: number | null;
  inflowM3s?: number | null;
  outflowM3s?: number | null;
  rainfallMm?: number | null;
}

export function isPhysicallyValid(input: PhysicalCheck): boolean {
  if (input.storageRate != null && (input.storageRate < 0 || input.storageRate > 1.5)) return false;
  if (input.storageVolumeM3 != null && input.storageVolumeM3 < 0) return false;
  if (input.inflowM3s != null && input.inflowM3s < 0) return false;
  if (input.outflowM3s != null && input.outflowM3s < 0) return false;
  if (input.rainfallMm != null && input.rainfallMm < 0) return false;
  return true;
}

export interface OutlierInput {
  prev: number | null;
  current: number;
  thresholdRatio?: number;          // default 0.30 (= ±30%)
}

export function detectOutlier({ prev, current, thresholdRatio = 0.3 }: OutlierInput): boolean {
  if (prev == null) return false;
  if (prev === 0) return Math.abs(current) > 0;
  return Math.abs(current - prev) / Math.abs(prev) > thresholdRatio;
}
```

- [ ] **Step 4: Pipeline test (TDD with mock adapter)**

```ts
// packages/ingest/src/pipeline.test.ts
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { sql } from '@dam/db/client';
import { upsertDamByExternalId } from '@dam/db/repo/dams';
import type { SourceAdapter } from '@dam/core/source_adapter';
import { runIngestForAdapter } from './pipeline.ts';

let damId: bigint;

beforeAll(async () => {
  await sql`DELETE FROM dams WHERE external_ids ->> 'ndi' = 'ING-TEST-1'`;
  damId = await upsertDamByExternalId('ndi', {
    slug: 'ing-test-1',
    name: 'Ingest Test',
    prefCode: '13',
    lat: 35.7,
    lng: 139.5,
    externalIds: { ndi: 'ING-TEST-1', kasenbosai: 'KB-TEST-1' },
  });
});

afterAll(async () => {
  await sql`DELETE FROM observations WHERE dam_id = ${damId}`;
  await sql`DELETE FROM raw_snapshots WHERE source_id = 'kasenbosai-mock'`;
  await sql`DELETE FROM dams WHERE id = ${damId}`;
});

const adapter: SourceAdapter = {
  id: 'kasenbosai-mock',
  schedule: 'hourly',
  async fetchTargets() {
    return [{ targetId: 'KB-TEST-1', url: 'mock://x' }];
  },
  async fetchRaw() {
    return { bytes: new TextEncoder().encode('<x/>'), contentType: 'application/xml', status: 200 };
  },
  async parse() {
    return [
      {
        damExternalId: { source: 'kasenbosai', id: 'KB-TEST-1' },
        observedAt: new Date('2026-04-30T10:00:00Z'),
        storageVolumeM3: 500_000,
        storageRate: 0.5,
      },
    ];
  },
};

describe('runIngestForAdapter', () => {
  test('persists raw snapshot and observation', async () => {
    const r = await runIngestForAdapter(adapter, { runAt: new Date('2026-04-30T10:30:00Z') });
    expect(r.observationsWritten).toBe(1);
    expect(r.rawSnapshots).toBe(1);
    const obs = await sql<{ n: bigint }[]>`
      SELECT COUNT(*)::BIGINT AS n FROM observations WHERE dam_id = ${damId}
    `;
    expect(Number(obs[0]?.n ?? 0)).toBe(1);
  });
});
```

- [ ] **Step 5: Pipeline impl**

```ts
// packages/ingest/src/pipeline.ts
import type { FetchContext, ParsedReading, SourceAdapter } from '@dam/core/source_adapter';
import { sql } from '@dam/db/client';
import { upsertObservations } from '@dam/db/repo/observations';
import { markParsed, markParseError, recordRawSnapshot } from '@dam/db/repo/raw_snapshots';
import { putSnapshot, rawSnapshotKey } from '@dam/storage/snapshot_store';
import { QualityFlag, detectOutlier, isPhysicallyValid } from './quality.ts';

export interface IngestResult {
  rawSnapshots: number;
  observationsWritten: number;
  errors: number;
}

async function damIdByExternalId(source: string, id: string): Promise<bigint | null> {
  const rows = await sql<{ id: bigint }[]>`
    SELECT id FROM dams WHERE external_ids ->> ${source} = ${id}
  `;
  return rows[0]?.id ?? null;
}

async function previousValue(damId: bigint, sourceId: string): Promise<number | null> {
  const rows = await sql<{ storage_volume_m3: string | null }[]>`
    SELECT storage_volume_m3 FROM observations
    WHERE dam_id = ${damId} AND source_id = ${sourceId}
    ORDER BY observed_at DESC LIMIT 1
  `;
  const v = rows[0]?.storage_volume_m3;
  return v == null ? null : Number(v);
}

export async function runIngestForAdapter(
  adapter: SourceAdapter,
  ctx: FetchContext,
): Promise<IngestResult> {
  const targets = await adapter.fetchTargets(ctx);
  let rawSnapshots = 0;
  let observationsWritten = 0;
  let errors = 0;

  for (const target of targets) {
    try {
      const raw = await adapter.fetchRaw(target, ctx);
      if (!raw) continue;                                    // unchanged (e.g. 304)
      const ext = raw.contentType.includes('json') ? 'json'
                : raw.contentType.includes('xml')  ? 'xml'
                : raw.contentType.includes('html') ? 'html'
                : 'bin';
      const key = rawSnapshotKey(adapter.id, target.targetId, ctx.runAt, ext);
      const uri = `s3://${process.env.S3_BUCKET ?? 'dam-raw'}/${key}`;
      await putSnapshot(key, raw.bytes, raw.contentType);
      const rawId = await recordRawSnapshot({
        sourceId: adapter.id,
        targetId: target.targetId,
        fetchedAt: ctx.runAt,
        storageUri: uri,
        httpStatus: raw.status,
        etag: raw.etag ?? null,
        bytes: raw.bytes.byteLength,
        contentType: raw.contentType,
      });
      rawSnapshots++;

      let parsed: ParsedReading[];
      try {
        parsed = await adapter.parse(raw, target);
      } catch (e) {
        await markParseError(rawId, (e as Error).message);
        errors++;
        continue;
      }

      const inputs = [];
      for (const p of parsed) {
        const damId = await damIdByExternalId(p.damExternalId.source, p.damExternalId.id);
        if (damId === null) continue;       // unknown dam: skip silently for now
        let flag = 0;
        if (!isPhysicallyValid(p)) flag |= QualityFlag.Outlier;
        const prev = await previousValue(damId, adapter.id);
        if (p.storageVolumeM3 != null && detectOutlier({ prev, current: p.storageVolumeM3 })) {
          flag |= QualityFlag.Outlier;
        }
        inputs.push({
          observedAt: p.observedAt,
          damId,
          sourceId: adapter.id,
          storageVolumeM3: p.storageVolumeM3 ?? null,
          storageRate: p.storageRate ?? null,
          inflowM3s: p.inflowM3s ?? null,
          outflowM3s: p.outflowM3s ?? null,
          waterLevelM: p.waterLevelM ?? null,
          rainfallMm: p.rainfallMm ?? null,
          rawSnapshotId: rawId,
          qualityFlag: flag,
        });
      }
      observationsWritten += await upsertObservations(inputs);
      await markParsed(rawId);
    } catch (e) {
      console.error(`ingest ${adapter.id} ${target.targetId}: ${(e as Error).message}`);
      errors++;
    }
  }

  return { rawSnapshots, observationsWritten, errors };
}
```

- [ ] **Step 6: `index.ts` and verify**

```ts
// packages/ingest/src/index.ts
export * from './pipeline.ts';
export * from './quality.ts';
```

```bash
bun install
bun test packages/ingest
bun run typecheck
git add packages/ingest
git commit -m "feat(ingest): shared pipeline runner with quality flags"
```

---

## Task 14: Kasen-Bosai adapter (川の防災情報)

**Files:**
- Create: `packages/adapters/kasenbosai/package.json`
- Create: `packages/adapters/kasenbosai/tsconfig.json`
- Create: `packages/adapters/kasenbosai/src/targets.ts`
- Create: `packages/adapters/kasenbosai/src/parser.ts`
- Test:   `packages/adapters/kasenbosai/src/parser.test.ts`
- Create: `packages/adapters/kasenbosai/src/adapter.ts`
- Create: `packages/adapters/kasenbosai/src/index.ts`
- Create: `tests/fixtures/kasenbosai/reading_yamba.xml`

- [ ] **Step 1: Fixture (representative XML — replace with a real captured file before production)**

```xml
<?xml version="1.0" encoding="UTF-8"?>
<damReadings>
  <dam id="KB-1234">
    <reading>
      <observedAt>2026-04-30T10:00:00+09:00</observedAt>
      <storageVolumeM3>107500000</storageVolumeM3>
      <storageRate>0.604</storageRate>
      <inflowM3s>12.3</inflowM3s>
      <outflowM3s>9.5</outflowM3s>
      <waterLevelM>586.2</waterLevelM>
      <rainfallMm>0.0</rainfallMm>
    </reading>
  </dam>
</damReadings>
```

- [ ] **Step 2: `package.json`**

```json
{
  "name": "@dam/adapters-kasenbosai",
  "version": "0.0.0",
  "private": true,
  "type": "module",
  "exports": { ".": "./src/index.ts" },
  "scripts": { "typecheck": "tsc --noEmit" },
  "dependencies": {
    "@dam/core": "workspace:*",
    "@dam/db": "workspace:*",
    "fast-xml-parser": "^4.5.0"
  }
}
```

- [ ] **Step 3: Parser test (TDD)**

```ts
// packages/adapters/kasenbosai/src/parser.test.ts
import { describe, expect, test } from 'bun:test';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { parseKasenbosaiReading } from './parser.ts';

const FIXTURE = join(import.meta.dir, '..', '..', '..', '..', 'tests/fixtures/kasenbosai/reading_yamba.xml');

describe('parseKasenbosaiReading', () => {
  test('extracts a single hourly reading', async () => {
    const xml = await readFile(FIXTURE, 'utf8');
    const out = parseKasenbosaiReading(xml);
    expect(out.length).toBe(1);
    expect(out[0]).toMatchObject({
      damId: 'KB-1234',
      storageVolumeM3: 107500000,
      storageRate: 0.604,
      inflowM3s: 12.3,
      outflowM3s: 9.5,
      waterLevelM: 586.2,
      rainfallMm: 0,
    });
    expect(out[0]?.observedAt.toISOString()).toBe('2026-04-30T01:00:00.000Z');
  });
});
```

- [ ] **Step 4: Parser impl**

```ts
// packages/adapters/kasenbosai/src/parser.ts
import { XMLParser } from 'fast-xml-parser';

export interface KasenbosaiReading {
  damId: string;
  observedAt: Date;
  storageVolumeM3: number | null;
  storageRate: number | null;
  inflowM3s: number | null;
  outflowM3s: number | null;
  waterLevelM: number | null;
  rainfallMm: number | null;
}

const parser = new XMLParser({ ignoreAttributes: false, attributeNamePrefix: '@_' });

function num(v: unknown): number | null {
  if (v == null || v === '') return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

interface XmlReading {
  observedAt?: string;
  storageVolumeM3?: string | number;
  storageRate?: string | number;
  inflowM3s?: string | number;
  outflowM3s?: string | number;
  waterLevelM?: string | number;
  rainfallMm?: string | number;
}

interface XmlDam {
  '@_id'?: string;
  reading?: XmlReading | XmlReading[];
}

export function parseKasenbosaiReading(xml: string): KasenbosaiReading[] {
  const data = parser.parse(xml) as { damReadings?: { dam?: XmlDam | XmlDam[] } };
  const damsRaw = data.damReadings?.dam;
  if (!damsRaw) return [];
  const dams = Array.isArray(damsRaw) ? damsRaw : [damsRaw];
  const out: KasenbosaiReading[] = [];
  for (const d of dams) {
    const damId = d['@_id'];
    if (!damId) continue;
    const readingsRaw = d.reading;
    if (!readingsRaw) continue;
    const readings = Array.isArray(readingsRaw) ? readingsRaw : [readingsRaw];
    for (const r of readings) {
      if (!r.observedAt) continue;
      const observedAt = new Date(r.observedAt);
      if (Number.isNaN(observedAt.valueOf())) continue;
      out.push({
        damId,
        observedAt,
        storageVolumeM3: num(r.storageVolumeM3),
        storageRate: num(r.storageRate),
        inflowM3s: num(r.inflowM3s),
        outflowM3s: num(r.outflowM3s),
        waterLevelM: num(r.waterLevelM),
        rainfallMm: num(r.rainfallMm),
      });
    }
  }
  return out;
}
```

- [ ] **Step 5: Run tests (red → green)**
```bash
bun install
bun test packages/adapters/kasenbosai/src/parser.test.ts
```

- [ ] **Step 6: Targets**

```ts
// packages/adapters/kasenbosai/src/targets.ts
import { sql } from '@dam/db/client';
import type { FetchTarget } from '@dam/core/source_adapter';

const BASE = process.env.KASENBOSAI_BASE_URL ?? 'https://www.river.go.jp/kawabou/sample/?fid=';

/**
 * Resolve all dams that have a kasenbosai external_id. The crawler only
 * targets dams already in the master.
 */
export async function buildTargets(): Promise<FetchTarget[]> {
  const rows = await sql<{ kb: string }[]>`
    SELECT external_ids ->> 'kasenbosai' AS kb
    FROM dams
    WHERE external_ids ? 'kasenbosai'
    ORDER BY id
  `;
  return rows.map((r) => ({ targetId: r.kb, url: `${BASE}${encodeURIComponent(r.kb)}` }));
}
```

- [ ] **Step 7: Adapter**

```ts
// packages/adapters/kasenbosai/src/adapter.ts
import { HttpClient } from '@dam/core/http_client';
import type {
  FetchContext, FetchTarget, ParsedReading, RawBytes, SourceAdapter,
} from '@dam/core/source_adapter';
import { previousEtag } from '@dam/db/repo/raw_snapshots';
import { parseKasenbosaiReading } from './parser.ts';
import { buildTargets } from './targets.ts';

const client = new HttpClient({
  userAgent: process.env.KASENBOSAI_USER_AGENT
    ?? `DamDataPlatform/0.1 (+https://example.com/bot; ${process.env.HTTP_CONTACT_EMAIL ?? 'ops@example.com'})`,
  minIntervalMs: Number(process.env.KASENBOSAI_MIN_INTERVAL_MS ?? '1500'),
  maxRetries: 3,
  timeoutMs: 30_000,
});

export const kasenbosaiAdapter: SourceAdapter = {
  id: 'kasenbosai',
  schedule: 'hourly',
  async fetchTargets(_ctx: FetchContext): Promise<FetchTarget[]> {
    return buildTargets();
  },
  async fetchRaw(target, _ctx): Promise<RawBytes | null> {
    const ifNoneMatch = (await previousEtag('kasenbosai', target.targetId)) ?? undefined;
    const r = await client.get(target.url, { ifNoneMatch });
    if (r.status === 304) return null;
    if (r.status !== 200) throw new Error(`HTTP ${r.status} ${target.url}`);
    return {
      bytes: r.bodyBytes,
      contentType: r.headers.get('content-type') ?? 'application/xml',
      etag: r.etag,
      status: r.status,
    };
  },
  async parse(raw, _target): Promise<ParsedReading[]> {
    const xml = new TextDecoder('utf-8').decode(raw.bytes);
    const readings = parseKasenbosaiReading(xml);
    return readings.map((r) => ({
      damExternalId: { source: 'kasenbosai', id: r.damId },
      observedAt: r.observedAt,
      storageVolumeM3: r.storageVolumeM3,
      storageRate: r.storageRate,
      inflowM3s: r.inflowM3s,
      outflowM3s: r.outflowM3s,
      waterLevelM: r.waterLevelM,
      rainfallMm: r.rainfallMm,
    }));
  },
};
```

- [ ] **Step 8: `index.ts` and commit**

```ts
// packages/adapters/kasenbosai/src/index.ts
export { kasenbosaiAdapter } from './adapter.ts';
export { parseKasenbosaiReading } from './parser.ts';
```

```bash
bun run typecheck
git add packages/adapters/kasenbosai tests/fixtures/kasenbosai
git commit -m "feat(adapters/kasenbosai): hourly realtime adapter"
```

---

## Task 15: Suimon backfill adapter (水文水質DB)

**Files:**
- Create: `packages/adapters/suimon/package.json`
- Create: `packages/adapters/suimon/tsconfig.json`
- Create: `packages/adapters/suimon/src/parser.ts`
- Test:   `packages/adapters/suimon/src/parser.test.ts`
- Create: `packages/adapters/suimon/src/adapter.ts`
- Create: `packages/adapters/suimon/src/index.ts`
- Create: `tests/fixtures/suimon/reading_yamba_2020.csv`

- [ ] **Step 1: Fixture (representative annual hourly CSV)**

```csv
observed_at,storage_volume_m3,storage_rate,inflow_m3s,outflow_m3s,water_level_m,rainfall_mm
2020-01-01T00:00:00+09:00,90000000,0.50,5.0,4.5,580.0,0.0
2020-01-01T01:00:00+09:00,90000500,0.501,5.1,4.6,580.1,0.0
```

- [ ] **Step 2: `package.json`**
```json
{
  "name": "@dam/adapters-suimon",
  "version": "0.0.0",
  "private": true,
  "type": "module",
  "exports": { ".": "./src/index.ts" },
  "scripts": { "typecheck": "tsc --noEmit" },
  "dependencies": {
    "@dam/core": "workspace:*",
    "@dam/db": "workspace:*",
    "papaparse": "^5.4.1"
  },
  "devDependencies": { "@types/papaparse": "^5.3.14" }
}
```

- [ ] **Step 3: Parser test (TDD)**

```ts
import { describe, expect, test } from 'bun:test';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { parseSuimonCsv } from './parser.ts';

const F = join(import.meta.dir, '..', '..', '..', '..', 'tests/fixtures/suimon/reading_yamba_2020.csv');

describe('parseSuimonCsv', () => {
  test('extracts hourly rows', async () => {
    const csv = await readFile(F, 'utf8');
    const out = parseSuimonCsv(csv);
    expect(out.length).toBe(2);
    expect(out[0]).toMatchObject({
      storageVolumeM3: 90_000_000,
      storageRate: 0.5,
      inflowM3s: 5,
      outflowM3s: 4.5,
      waterLevelM: 580,
      rainfallMm: 0,
    });
    expect(out[0]?.observedAt.toISOString()).toBe('2019-12-31T15:00:00.000Z');
  });
});
```

- [ ] **Step 4: Parser impl**

```ts
// packages/adapters/suimon/src/parser.ts
import Papa from 'papaparse';

export interface SuimonRow {
  observedAt: Date;
  storageVolumeM3: number | null;
  storageRate: number | null;
  inflowM3s: number | null;
  outflowM3s: number | null;
  waterLevelM: number | null;
  rainfallMm: number | null;
}

function num(v: unknown): number | null {
  if (v == null || v === '') return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

export function parseSuimonCsv(csv: string): SuimonRow[] {
  const out: SuimonRow[] = [];
  const parsed = Papa.parse<Record<string, string>>(csv, { header: true, skipEmptyLines: true });
  for (const r of parsed.data) {
    const ts = r.observed_at;
    if (!ts) continue;
    const observedAt = new Date(ts);
    if (Number.isNaN(observedAt.valueOf())) continue;
    out.push({
      observedAt,
      storageVolumeM3: num(r.storage_volume_m3),
      storageRate: num(r.storage_rate),
      inflowM3s: num(r.inflow_m3s),
      outflowM3s: num(r.outflow_m3s),
      waterLevelM: num(r.water_level_m),
      rainfallMm: num(r.rainfall_mm),
    });
  }
  return out;
}
```

- [ ] **Step 5: Adapter (per-target = `damExternalId × year`)**

```ts
// packages/adapters/suimon/src/adapter.ts
import { HttpClient } from '@dam/core/http_client';
import type {
  FetchContext, FetchTarget, ParsedReading, RawBytes, SourceAdapter,
} from '@dam/core/source_adapter';
import { sql } from '@dam/db/client';
import { nextPending } from '@dam/db/repo/backfill_progress';
import { parseSuimonCsv } from './parser.ts';

const client = new HttpClient({
  userAgent: process.env.SUIMON_USER_AGENT
    ?? `DamDataPlatform/0.1 (+https://example.com/bot; ${process.env.HTTP_CONTACT_EMAIL ?? 'ops@example.com'})`,
  minIntervalMs: Number(process.env.SUIMON_MIN_INTERVAL_MS ?? '5000'),
  maxRetries: 3,
  timeoutMs: 60_000,
});

interface SuimonTarget extends FetchTarget {
  meta: { suimonId: string; year: string; damId: string };
}

const BASE = process.env.SUIMON_BASE_URL ?? 'https://www1.river.go.jp/sample/?type=DamReservoir&id=';

async function suimonIdsByDamIds(damIds: bigint[]): Promise<Map<bigint, string>> {
  if (damIds.length === 0) return new Map();
  const rows = await sql<{ id: bigint; suimon: string | null }[]>`
    SELECT id, external_ids ->> 'suimon' AS suimon FROM dams WHERE id = ANY(${damIds}::bigint[])
  `;
  return new Map(rows.filter((r) => r.suimon).map((r) => [r.id, r.suimon!] as const));
}

export const suimonAdapter: SourceAdapter = {
  id: 'suimon',
  schedule: 'on-demand',
  async fetchTargets(_ctx: FetchContext): Promise<FetchTarget[]> {
    const pending = await nextPending('suimon', Number(process.env.SUIMON_BATCH ?? '5'));
    const ids = await suimonIdsByDamIds(pending.map((p) => p.damId));
    return pending
      .map((p): SuimonTarget | null => {
        const suimonId = ids.get(p.damId);
        if (!suimonId) return null;
        return {
          targetId: `${suimonId}-${p.year}`,
          url: `${BASE}${encodeURIComponent(suimonId)}&year=${p.year}`,
          meta: { suimonId, year: String(p.year), damId: String(p.damId) },
        };
      })
      .filter((t): t is SuimonTarget => t !== null);
  },
  async fetchRaw(target, _ctx): Promise<RawBytes | null> {
    const r = await client.get(target.url);
    if (r.status !== 200) throw new Error(`HTTP ${r.status} ${target.url}`);
    return { bytes: r.bodyBytes, contentType: r.headers.get('content-type') ?? 'text/csv', status: r.status, etag: r.etag };
  },
  async parse(raw, target): Promise<ParsedReading[]> {
    const csv = new TextDecoder('utf-8').decode(raw.bytes);
    const rows = parseSuimonCsv(csv);
    const meta = (target as SuimonTarget).meta;
    return rows.map((row) => ({
      damExternalId: { source: 'suimon', id: meta.suimonId },
      observedAt: row.observedAt,
      storageVolumeM3: row.storageVolumeM3,
      storageRate: row.storageRate,
      inflowM3s: row.inflowM3s,
      outflowM3s: row.outflowM3s,
      waterLevelM: row.waterLevelM,
      rainfallMm: row.rainfallMm,
    }));
  },
};
```

- [ ] **Step 6: `index.ts` and verify**
```ts
export { suimonAdapter } from './adapter.ts';
export { parseSuimonCsv } from './parser.ts';
```
```bash
bun install
bun test packages/adapters/suimon
bun run typecheck
git add packages/adapters/suimon tests/fixtures/suimon
git commit -m "feat(adapters/suimon): historical backfill adapter"
```

---

## Task 16: Worker tasks for hourly ingest + backfill

**Files:**
- Create: `apps/worker/src/tasks/ingest_kasenbosai.ts`
- Create: `apps/worker/src/tasks/backfill_suimon_enqueue.ts`
- Create: `apps/worker/src/tasks/backfill_suimon_run.ts`
- Create: `apps/worker/src/tasks/quality_recompute.ts`
- Modify: `apps/worker/src/index.ts`
- Modify: `apps/worker/src/crontab.ts`
- Modify: `apps/worker/package.json` (add new adapter deps)

- [ ] **Step 1: `ingest_kasenbosai.ts`**

```ts
import type { Task } from 'graphile-worker';
import { kasenbosaiAdapter } from '@dam/adapters-kasenbosai';
import { runIngestForAdapter } from '@dam/ingest';

const task: Task = async (_payload, helpers) => {
  const r = await runIngestForAdapter(kasenbosaiAdapter, { runAt: new Date() });
  helpers.logger.info(`kasenbosai: snapshots=${r.rawSnapshots} obs=${r.observationsWritten} errors=${r.errors}`);
};

export default task;
```

- [ ] **Step 2: `backfill_suimon_enqueue.ts`**

```ts
import type { Task } from 'graphile-worker';
import { enqueueAllDams } from '@dam/db/repo/backfill_progress';

interface Payload {
  fromYear?: number;
  toYear?: number;
}

const task: Task<Payload> = async (payload, helpers) => {
  const fromYear = payload?.fromYear ?? 2014;
  const toYear = payload?.toYear ?? new Date().getUTCFullYear() - 1;
  const r = await enqueueAllDams('suimon', fromYear, toYear);
  helpers.logger.info(`suimon enqueued ${r} (${fromYear}..${toYear})`);
};

export default task;
```

- [ ] **Step 3: `backfill_suimon_run.ts`**

```ts
import type { Task } from 'graphile-worker';
import { suimonAdapter } from '@dam/adapters-suimon';
import { runIngestForAdapter } from '@dam/ingest';
import { complete, fail, startRunning } from '@dam/db/repo/backfill_progress';

const task: Task = async (_payload, helpers) => {
  // The adapter returns at most SUIMON_BATCH targets at a time.
  const ctx = { runAt: new Date() };
  const targets = await suimonAdapter.fetchTargets(ctx);
  let totalObs = 0;
  for (const t of targets) {
    const meta = (t as { meta: { suimonId: string; year: string; damId: string } }).meta;
    const damId = BigInt(meta.damId);
    const year = Number(meta.year);
    try {
      await startRunning('suimon', damId, year);
      // Re-run for a single target by calling the adapter directly (re-using
      // the pipeline machinery for this single target).
      const raw = await suimonAdapter.fetchRaw(t, ctx);
      if (!raw) {
        await complete('suimon', damId, year, 0);
        continue;
      }
      const parsed = await suimonAdapter.parse(raw, t);
      // Use the same pipeline route by calling runIngestForAdapter with a
      // fixed-target adapter wrapper — but for clarity, call the existing
      // observation upsert directly.
      const { upsertObservations } = await import('@dam/db/repo/observations');
      const { recordRawSnapshot, markParsed } = await import('@dam/db/repo/raw_snapshots');
      const { putSnapshot, rawSnapshotKey } = await import('@dam/storage/snapshot_store');
      const key = rawSnapshotKey('suimon', t.targetId, ctx.runAt, 'csv');
      const uri = `s3://${process.env.S3_BUCKET ?? 'dam-raw'}/${key}`;
      await putSnapshot(key, raw.bytes, raw.contentType);
      const rawId = await recordRawSnapshot({
        sourceId: 'suimon',
        targetId: t.targetId,
        fetchedAt: ctx.runAt,
        storageUri: uri,
        httpStatus: raw.status,
        bytes: raw.bytes.byteLength,
        contentType: raw.contentType,
      });
      const inputs = parsed.map((p) => ({
        observedAt: p.observedAt,
        damId,
        sourceId: 'suimon',
        storageVolumeM3: p.storageVolumeM3 ?? null,
        storageRate: p.storageRate ?? null,
        inflowM3s: p.inflowM3s ?? null,
        outflowM3s: p.outflowM3s ?? null,
        waterLevelM: p.waterLevelM ?? null,
        rainfallMm: p.rainfallMm ?? null,
        rawSnapshotId: rawId,
        qualityFlag: 0,
      }));
      const written = await upsertObservations(inputs);
      await markParsed(rawId);
      await complete('suimon', damId, year, written);
      totalObs += written;
    } catch (e) {
      await fail('suimon', damId, year, (e as Error).message);
      helpers.logger.error(`suimon ${damId} ${year}: ${(e as Error).message}`);
    }
  }
  helpers.logger.info(`suimon backfill batch: obs=${totalObs}`);
};

export default task;
```

- [ ] **Step 4: `quality_recompute.ts` (placeholder for now — flesh out in a follow-up)**

```ts
import type { Task } from 'graphile-worker';

const task: Task = async (_payload, helpers) => {
  // TODO: per-dam-day missing-rate recomputation; cross-source mismatch detection.
  // Placeholder so the cron entry is real.
  helpers.logger.info('quality:recompute: noop placeholder');
};

export default task;
```

- [ ] **Step 5: Wire into worker `index.ts`**

```ts
// apps/worker/src/index.ts
import { run } from 'graphile-worker';
import refreshNdi from './tasks/master_refresh_ndi.ts';
import refreshDamnet from './tasks/master_refresh_damnet.ts';
import match from './tasks/master_match.ts';
import ingestKasenbosai from './tasks/ingest_kasenbosai.ts';
import backfillEnqueue from './tasks/backfill_suimon_enqueue.ts';
import backfillRun from './tasks/backfill_suimon_run.ts';
import qualityRecompute from './tasks/quality_recompute.ts';
import { CRONTAB } from './crontab.ts';

async function main(): Promise<void> {
  const url = process.env.DATABASE_URL;
  if (!url) throw new Error('DATABASE_URL not set');

  const runner = await run({
    connectionString: url,
    concurrency: Number(process.env.WORKER_CONCURRENCY ?? '4'),
    noHandleSignals: false,
    pollInterval: 5_000,
    crontab: CRONTAB,
    taskList: {
      'master:refresh:ndi': refreshNdi,
      'master:refresh:damnet': refreshDamnet,
      'master:match': match,
      'ingest:kasenbosai': ingestKasenbosai,
      'backfill:suimon:enqueue': backfillEnqueue,
      'backfill:suimon:run': backfillRun,
      'quality:recompute': qualityRecompute,
    },
  });

  await runner.promise;
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
```

- [ ] **Step 6: `crontab.ts`**

```ts
// apps/worker/src/crontab.ts
// graphile-worker disallows '.' in identifiers — use ':'.
export const CRONTAB = `
# Master refresh
0 3 1 * * master:refresh:ndi
0 3 5 * * master:refresh:damnet
0 4 * * * master:match

# Realtime ingest (every hour at :05)
5 * * * * ingest:kasenbosai

# Backfill scheduling (rarely; run manually via add_job for ad-hoc enqueue)
# Run actual fetches every 5 minutes (small batches, respects upstream)
*/5 * * * * backfill:suimon:run

# Quality recomputation
30 4 * * * quality:recompute
`;
```

- [ ] **Step 7: Update `apps/worker/package.json`** — add `@dam/adapters-kasenbosai`, `@dam/adapters-suimon`, `@dam/ingest`, `@dam/storage` to `dependencies`. Run `bun install`.

- [ ] **Step 8: Smoke (worker register / cron parse only)**
```bash
bun run --filter @dam/worker typecheck
bun run lint
DATABASE_URL=postgres://dam:dam@localhost:5433/dam bun run apps/worker/src/index.ts &
WPID=$!
sleep 6
docker compose exec db psql -U dam -d dam -c "SELECT graphile_worker.add_job('quality:recompute');"
sleep 3
kill $WPID
```
Expected log: `quality:recompute: noop placeholder`.

- [ ] **Step 9: Commit**
```bash
git add apps/worker
git commit -m "feat(worker): hourly kasenbosai ingest, suimon backfill, quality recompute cron"
```

---

## Task 17: `/api/v1/dams/[slug]/observations` read-only endpoint (TDD)

**Files:**
- Create: `apps/web/app/api/v1/dams/[slug]/observations/route.ts`
- Test:   `apps/web/app/api/v1/dams/[slug]/observations/route.test.ts`

- [ ] **Step 1: Test (integration)**

```ts
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { sql } from '@dam/db/client';
import { upsertDamByExternalId } from '@dam/db/repo/dams';
import { upsertObservations } from '@dam/db/repo/observations';
import { GET } from './route.ts';

let damId: bigint;

beforeAll(async () => {
  await sql`DELETE FROM dams WHERE external_ids ->> 'ndi' = 'API-OBS-1'`;
  damId = await upsertDamByExternalId('ndi', {
    slug: 'api-obs-1',
    name: 'API Obs Test',
    prefCode: '13',
    lat: 35.7,
    lng: 139.5,
    externalIds: { ndi: 'API-OBS-1' },
  });
  await upsertObservations([
    {
      observedAt: new Date('2026-04-30T10:00:00Z'),
      damId,
      sourceId: 'kasenbosai',
      storageVolumeM3: 1_000_000,
      storageRate: 0.5,
    },
  ]);
});

afterAll(async () => {
  await sql`DELETE FROM observations WHERE dam_id = ${damId}`;
  await sql`DELETE FROM dams WHERE id = ${damId}`;
});

function makeReq(slug: string, qs: string): Request {
  return new Request(`http://localhost/api/v1/dams/${slug}/observations${qs}`);
}

describe('GET /api/v1/dams/[slug]/observations', () => {
  test('200 returns hourly series', async () => {
    const res = await GET(makeReq('api-obs-1', '?from=2026-04-30T00:00:00Z&to=2026-05-01T00:00:00Z&interval=hourly'),
      { params: Promise.resolve({ slug: 'api-obs-1' }) });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.series.length).toBe(1);
    expect(body._links.self.href).toContain('api-obs-1');
  });

  test('404 on unknown slug', async () => {
    const res = await GET(makeReq('does-not-exist', '?from=2026-04-30T00:00:00Z&to=2026-05-01T00:00:00Z&interval=hourly'),
      { params: Promise.resolve({ slug: 'does-not-exist' }) });
    expect(res.status).toBe(404);
  });

  test('400 on missing params', async () => {
    const res = await GET(makeReq('api-obs-1', ''),
      { params: Promise.resolve({ slug: 'api-obs-1' }) });
    expect(res.status).toBe(400);
  });
});
```

- [ ] **Step 2: Implement**

```ts
// apps/web/app/api/v1/dams/[slug]/observations/route.ts
import { z } from 'zod';
import { sql } from '@dam/db/client';
import { findSeries } from '@dam/db/repo/observations';
import { preferredSource } from '@dam/db/repo/source_priorities';
import { HttpError, asProblem } from '../../../../../lib/api/error.ts';
import { hal } from '../../../../../lib/api/response.ts';

export const dynamic = 'force-dynamic';

const Query = z.object({
  from: z.string().min(1),
  to: z.string().min(1),
  interval: z.enum(['hourly', 'daily', 'monthly']),
});

export async function GET(
  req: Request,
  { params }: { params: Promise<{ slug: string }> },
): Promise<Response> {
  try {
    const { slug } = await params;
    const url = new URL(req.url);
    const parsed = Query.safeParse({
      from: url.searchParams.get('from'),
      to: url.searchParams.get('to'),
      interval: url.searchParams.get('interval'),
    });
    if (!parsed.success) throw new HttpError(400, 'Invalid query');
    const from = new Date(parsed.data.from);
    const to = new Date(parsed.data.to);
    if (Number.isNaN(from.valueOf()) || Number.isNaN(to.valueOf())) {
      throw new HttpError(400, 'Invalid from/to');
    }

    const damRows = await sql<{ id: bigint }[]>`SELECT id FROM dams WHERE slug = ${slug} LIMIT 1`;
    const dam = damRows[0];
    if (!dam) throw new HttpError(404, 'Dam not found');

    const preferred = parsed.data.interval === 'hourly' ? await preferredSource() : null;
    const series = await findSeries({
      damId: dam.id,
      from,
      to,
      bucket: parsed.data.interval,
      preferredSource: preferred,
    });

    const self = `/api/v1/dams/${slug}/observations?from=${parsed.data.from}&to=${parsed.data.to}&interval=${parsed.data.interval}`;
    return hal(
      { series, count: series.length, source: preferred ?? null },
      {
        self: { href: self },
        dam: { href: `/api/v1/dams/${slug}` },
      },
    );
  } catch (e) {
    return asProblem(e);
  }
}
```

- [ ] **Step 3: Run + commit**
```bash
bun test apps/web/app/api/v1/dams
git add apps/web/app/api/v1/dams
git commit -m "feat(web): /api/v1/dams/[slug]/observations time-series API"
```

---

## Task 18: Wire real `last_fetched_at` into `/api/v1/sources`

**Files:**
- Modify: `apps/web/app/api/v1/sources/route.ts`

- [ ] **Step 1: Replace static config with a DB-driven query**

```ts
import { sql } from '@dam/db/client';
import { hal } from '../../../../lib/api/response.ts';

export const dynamic = 'force-dynamic';

interface Row {
  source_id: string;
  description: string | null;
  priority: number;
  active: boolean;
  last_fetched_at: Date | null;
  last_status: string | null;
}

export async function GET() {
  const rows = await sql<Row[]>`
    SELECT
      sp.source_id,
      sp.description,
      sp.priority,
      sp.active,
      lf.last_fetched_at,
      lf.last_status
    FROM source_priorities sp
    LEFT JOIN LATERAL (
      SELECT fetched_at AS last_fetched_at, parse_status AS last_status
      FROM raw_snapshots WHERE source_id = sp.source_id
      ORDER BY fetched_at DESC LIMIT 1
    ) lf ON TRUE
    ORDER BY sp.priority DESC
  `;
  return hal({ sources: rows }, { self: { href: '/api/v1/sources' } });
}
```

- [ ] **Step 2: Commit**
```bash
git add apps/web/app/api/v1/sources/route.ts
git commit -m "feat(web): /api/v1/sources backed by raw_snapshots"
```

---

## Task 19: README + runbook updates

**Files:**
- Modify: `README.md`

- [ ] **Step 1: Append a "Plan 2 — running ingest" section**

```markdown
## Running ingest (Plan 2)

```sh
just up                  # postgres + minio
just ensure-bucket       # create the dam-raw bucket if missing
just migrate
just dev-worker          # graphile-worker (registers all tasks)

# Trigger a one-off run from the DB
docker compose exec db psql -U dam -d dam \
  -c "SELECT graphile_worker.add_job('ingest:kasenbosai');"

# Backfill: enqueue the full year × dam matrix once
docker compose exec db psql -U dam -d dam \
  -c "SELECT graphile_worker.add_job('backfill:suimon:enqueue', '{\"fromYear\":2015,\"toYear\":2024}');"
```

The hourly cron triggers `ingest:kasenbosai` at minute :05 of every hour.
Backfill batches run every 5 minutes with `SUIMON_BATCH` targets each.
```

- [ ] **Step 2: Commit**
```bash
git add README.md
git commit -m "docs: README runbook for Plan 2 ingest"
```

---

## Task 20: CI updates

**Files:**
- Modify: `.github/workflows/ci.yml`

- [ ] **Step 1: Add a MinIO service for the storage tests**

```yaml
    services:
      db:
        image: timescale/timescaledb-ha:pg16
        env:
          POSTGRES_DB: dam
          POSTGRES_USER: dam
          POSTGRES_PASSWORD: dam
        ports: ['5432:5432']
        options: >-
          --health-cmd "pg_isready -U dam -d dam"
          --health-interval 5s
          --health-timeout 5s
          --health-retries 20
      minio:
        image: minio/minio:RELEASE.2025-04-22T22-12-26Z
        env:
          MINIO_ROOT_USER: minio
          MINIO_ROOT_PASSWORD: minio12345
        ports: ['9000:9000']
        options: >-
          --entrypoint sh
        # Run server in CI via override below
```

(Note: GitHub Actions doesn't accept `command` on services. As a workaround,
use `services` for the DB only and start MinIO via a docker compose step in
the workflow, or skip MinIO in CI and gate `bun test packages/storage` on an
env flag. Simplest: add a step that starts MinIO via `docker run` before
tests.)

```yaml
      - name: Start MinIO
        run: |
          docker run -d --name minio \
            -p 9000:9000 -e MINIO_ROOT_USER=minio -e MINIO_ROOT_PASSWORD=minio12345 \
            minio/minio:RELEASE.2025-04-22T22-12-26Z server /data
          # Wait until ready
          for i in 1 2 3 4 5 6 7 8 9 10; do
            curl -sf http://localhost:9000/minio/health/ready && break
            sleep 2
          done
          # Create bucket
          docker run --rm --network host \
            -e MC_HOST_local=http://minio:minio12345@localhost:9000 \
            minio/mc:RELEASE.2025-04-08T15-39-49Z mb local/dam-raw || true
        env:
          S3_ENDPOINT: http://localhost:9000
          S3_ACCESS_KEY: minio
          S3_SECRET_KEY: minio12345
          S3_BUCKET: dam-raw
```

Add the same `S3_*` env vars to the `env:` block of the `test` job.

- [ ] **Step 2: Commit**
```bash
git add .github/workflows/ci.yml
git commit -m "ci: add MinIO and storage env to test job"
```

---

## Self-Review

1. **Spec coverage:**
   - §2.2 Realtime ingest: covered (Task 14, 16).
   - §2.3 Backfill: covered (Task 15, 16).
   - §3 Source adapter abstraction: covered (Task 11) and applied uniformly to NDI/Damnet/Kasenbosai/Suimon. Retrofitting NDI/Damnet to the formal interface is **out of scope** here (they already work via package boundaries; we'll align them in Plan 3 when more adapters land).
   - §4 raw layer / observations / continuous aggregates: Tasks 3-7, 9-10.
   - §8 Data quality: Task 13 + `quality_flag`. Public UI follow-up is in Plan 3.
   - §10 ETL/jobs: Task 16.
   - §13 Performance: continuous aggregates (Task 7) and compression (Task 6) directly support the API SLOs in Plan 3.

2. **Placeholders:** `quality_recompute` is an explicit placeholder per Task 16 Step 4. `master:match` from Plan 1 is also a placeholder; calling out as known.

3. **Type consistency:** `ParsedReading.damExternalId` is the single contract used in `runIngestForAdapter` to look up the matching dam — verified that both kasenbosai and suimon adapters emit it.

4. **Risks:**
   - Real Kasen-Bosai endpoints may not be XML; the parser may need an HTML branch. Capture a real fixture before production.
   - Suimon CSV column names are guessed; replace fixture with a real captured file before going live.
   - Continuous aggregate creation may need migration-runner adjustment to skip transaction wrapping. Task 7 calls this out; the runner change can land as a separate small commit if needed.

---

## Execution Handoff

Plan complete and saved. Two execution options:

1. **Subagent-Driven** — fresh subagent per task with two-stage review. Recommended.
2. **Inline Execution** — same-session batched execution.

Which approach?
