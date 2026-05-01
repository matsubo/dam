# Foundation, Master DB, and Watershed Geocoding — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Stand up the project foundation (Bun monorepo, PostgreSQL + TimescaleDB + PostGIS, Next.js, graphile-worker), import the dam and watershed master from NLNI, augment dam attributes from the Dam Almanac, and ship the watershed-geocoding API.

**Architecture:** Bun workspaces split into `apps/web` (Next.js, hosts public API), `apps/worker` (graphile-worker process), and `packages/*` (db schema, core utilities, source adapters, reconciler). Master data lives in PostgreSQL with PostGIS for geometry; watershed lookup uses ST_Contains over a GiST-indexed boundary column.

**Tech Stack:** Bun, TypeScript, Next.js 15 (App Router), PostgreSQL 16 + TimescaleDB + PostGIS, Drizzle ORM (schema + migrations) with raw SQL for spatial work, graphile-worker, MinIO (S3-compatible) for raw snapshots, Biome for lint/format, `bun:test` for unit and integration tests, Playwright for browser E2E.

**Reference spec:** `docs/superpowers/specs/2026-05-01-dam-data-platform-design.md`

**Out of scope (handled by later plans):** realtime/historical observation ingest, full public API surface (`/dams`, `/watersheds`, `/observations` …), web pages, ECharts graphs, sitemap, CDN/cache, alerting, prediction.

---

## File Structure

```
/
├── package.json                       # Bun workspace root
├── bun.lock
├── tsconfig.base.json
├── biome.json
├── .env.example
├── .gitignore
├── justfile
├── docker-compose.yml                 # local PG + MinIO
├── README.md
├── apps/
│   ├── web/                           # Next.js app + public API routes
│   │   ├── package.json
│   │   ├── next.config.ts
│   │   ├── tsconfig.json
│   │   ├── app/
│   │   │   ├── layout.tsx
│   │   │   ├── page.tsx
│   │   │   └── api/v1/
│   │   │       ├── healthz/route.ts
│   │   │       ├── sources/route.ts
│   │   │       └── watershed/route.ts
│   │   └── lib/
│   │       └── api/
│   │           ├── error.ts
│   │           └── response.ts
│   └── worker/                        # graphile-worker process
│       ├── package.json
│       ├── tsconfig.json
│       └── src/
│           ├── index.ts
│           ├── crontab.ts
│           └── tasks/
│               ├── master_refresh_ndi.ts
│               ├── master_refresh_damnet.ts
│               └── master_match.ts
├── packages/
│   ├── db/                            # Drizzle schema, migrations, repos
│   │   ├── package.json
│   │   ├── tsconfig.json
│   │   ├── drizzle.config.ts
│   │   ├── migrations/                # raw SQL migrations
│   │   │   ├── 0000_extensions.sql
│   │   │   ├── 0001_master.sql
│   │   │   └── 0002_indexes.sql
│   │   └── src/
│   │       ├── client.ts
│   │       ├── schema/
│   │       │   ├── dams.ts
│   │       │   ├── watersheds.ts
│   │       │   ├── rivers.ts
│   │       │   ├── match_review.ts
│   │       │   └── index.ts
│   │       ├── repo/
│   │       │   ├── dams.ts
│   │       │   ├── watersheds.ts
│   │       │   └── match_review.ts
│   │       └── migrate.ts
│   ├── core/                          # types, utilities
│   │   ├── package.json
│   │   ├── tsconfig.json
│   │   └── src/
│   │       ├── slug.ts
│   │       ├── hateoas.ts
│   │       ├── similarity.ts
│   │       └── http_client.ts
│   ├── adapters/
│   │   ├── ndi/                       # NLNI W01 (dams) + W07 (watersheds)
│   │   │   ├── package.json
│   │   │   ├── tsconfig.json
│   │   │   └── src/
│   │   │       ├── fetcher.ts
│   │   │       ├── parse_w01.ts
│   │   │       ├── parse_w07.ts
│   │   │       └── importer.ts
│   │   └── damnet/                    # Dam Almanac
│   │       ├── package.json
│   │       ├── tsconfig.json
│   │       └── src/
│   │           ├── list_scraper.ts
│   │           ├── detail_parser.ts
│   │           └── importer.ts
│   └── reconciler/
│       ├── package.json
│       ├── tsconfig.json
│       └── src/
│           ├── geo_match.ts
│           ├── name_match.ts
│           └── reconcile.ts
├── tests/
│   ├── fixtures/
│   │   ├── ndi/
│   │   │   ├── w01_sample.geojson
│   │   │   └── w07_sample.geojson
│   │   └── damnet/
│   │       ├── list.html
│   │       └── detail_yamba.html
│   └── integration/
│       └── helpers.ts
└── .github/
    └── workflows/
        └── ci.yml
```

---

## Task 1: Initialize repository and Bun workspace

**Files:**
- Create: `package.json`
- Create: `bun.lock` (auto)
- Create: `.gitignore`
- Create: `tsconfig.base.json`

- [ ] **Step 1: Initialize Bun workspace `package.json`**

```json
{
  "name": "dam",
  "private": true,
  "type": "module",
  "workspaces": ["apps/*", "packages/*", "packages/adapters/*"],
  "scripts": {
    "lint": "biome check .",
    "format": "biome format --write .",
    "typecheck": "bun run --filter '*' typecheck",
    "test": "bun test"
  },
  "engines": { "bun": ">=1.1.0", "node": ">=24" },
  "devDependencies": {
    "@biomejs/biome": "^1.9.0",
    "typescript": "^5.6.0",
    "@types/bun": "latest"
  }
}
```

- [ ] **Step 2: Create `tsconfig.base.json`**

```json
{
  "compilerOptions": {
    "target": "ES2022",
    "module": "ESNext",
    "moduleResolution": "Bundler",
    "strict": true,
    "noUncheckedIndexedAccess": true,
    "noImplicitOverride": true,
    "exactOptionalPropertyTypes": true,
    "isolatedModules": true,
    "esModuleInterop": true,
    "skipLibCheck": true,
    "resolveJsonModule": true,
    "allowImportingTsExtensions": false,
    "verbatimModuleSyntax": true,
    "lib": ["ES2022", "DOM"]
  }
}
```

- [ ] **Step 3: Create `.gitignore`**

```
node_modules
.next
dist
build
coverage
.env
.env.local
.DS_Store
*.log
playwright-report
test-results
```

- [ ] **Step 4: Install workspace dev deps**

```bash
bun install
```

Expected: `bun.lock` is created, `node_modules/` populated.

- [ ] **Step 5: Commit**

```bash
git add package.json bun.lock tsconfig.base.json .gitignore
git commit -m "chore: initialize bun workspace"
```

---

## Task 2: Configure Biome for lint and format

**Files:**
- Create: `biome.json`

- [ ] **Step 1: Write `biome.json`**

```json
{
  "$schema": "https://biomejs.dev/schemas/1.9.0/schema.json",
  "organizeImports": { "enabled": true },
  "linter": {
    "enabled": true,
    "rules": {
      "recommended": true,
      "style": { "noNonNullAssertion": "error" },
      "suspicious": { "noExplicitAny": "error" }
    }
  },
  "formatter": {
    "enabled": true,
    "indentStyle": "space",
    "indentWidth": 2,
    "lineWidth": 100
  },
  "javascript": {
    "formatter": { "quoteStyle": "single", "trailingCommas": "all", "semicolons": "always" }
  },
  "files": {
    "ignore": ["**/node_modules/**", "**/.next/**", "**/dist/**", "**/migrations/**"]
  }
}
```

- [ ] **Step 2: Run lint to verify config**

```bash
bun run lint
```

Expected: PASS (no files to lint yet → no errors).

- [ ] **Step 3: Commit**

```bash
git add biome.json
git commit -m "chore: configure biome"
```

---

## Task 3: Local infrastructure via docker-compose

**Files:**
- Create: `docker-compose.yml`
- Create: `.env.example`

- [ ] **Step 1: Write `docker-compose.yml`**

```yaml
name: dam

services:
  db:
    image: timescale/timescaledb-ha:pg16
    environment:
      POSTGRES_DB: dam
      POSTGRES_USER: dam
      POSTGRES_PASSWORD: dam
    ports: ['5432:5432']
    volumes:
      - db_data:/home/postgres/pgdata/data
    healthcheck:
      test: ['CMD-SHELL', 'pg_isready -U dam -d dam']
      interval: 5s
      timeout: 5s
      retries: 20

  minio:
    image: minio/minio:RELEASE.2024-09-01T00-00-00Z
    command: server /data --console-address ':9001'
    environment:
      MINIO_ROOT_USER: minio
      MINIO_ROOT_PASSWORD: minio12345
    ports: ['9000:9000', '9001:9001']
    volumes:
      - minio_data:/data

volumes:
  db_data:
  minio_data:
```

Note: `timescaledb-ha:pg16` ships PostgreSQL 16 with TimescaleDB and PostGIS pre-installed.

- [ ] **Step 2: Write `.env.example`**

```dotenv
# Database
DATABASE_URL=postgres://dam:dam@localhost:5432/dam

# MinIO (S3-compatible)
S3_ENDPOINT=http://localhost:9000
S3_REGION=us-east-1
S3_BUCKET=dam-raw
S3_ACCESS_KEY=minio
S3_SECRET_KEY=minio12345

# Worker
WORKER_CONCURRENCY=4

# Web
PORT=3000
NEXT_PUBLIC_SITE_URL=http://localhost:3000
```

- [ ] **Step 3: Bring up the stack and verify**

```bash
cp .env.example .env
docker compose up -d
docker compose ps
```

Expected: `db` and `minio` show `running (healthy)`.

- [ ] **Step 4: Verify extensions exist**

```bash
docker compose exec db psql -U dam -d dam -c "SELECT extname FROM pg_available_extensions WHERE extname IN ('timescaledb','postgis') ORDER BY extname;"
```

Expected: rows for both `postgis` and `timescaledb`.

- [ ] **Step 5: Commit**

```bash
git add docker-compose.yml .env.example
git commit -m "chore: add local docker-compose with TimescaleDB and MinIO"
```

---

## Task 4: justfile shortcuts

**Files:**
- Create: `justfile`

- [ ] **Step 1: Write `justfile`**

```make
set shell := ["bash", "-cu"]

default:
    @just --list

# Bring up the local infra (db + minio)
up:
    docker compose up -d

down:
    docker compose down

# Run all migrations
migrate:
    bun run --filter @dam/db migrate

# Reset the database (drops volume — local only)
reset-db:
    docker compose down -v
    docker compose up -d
    sleep 2
    bun run --filter @dam/db migrate

# Lint, format, typecheck, test
check:
    bun run lint
    bun run typecheck
    bun test

# Run the web app
dev-web:
    bun run --filter @dam/web dev

# Run the worker
dev-worker:
    bun run --filter @dam/worker dev

# Master imports
import-ndi-watersheds *args:
    bun run --filter @dam/adapters-ndi import:watersheds {{args}}

import-ndi-dams *args:
    bun run --filter @dam/adapters-ndi import:dams {{args}}

import-damnet *args:
    bun run --filter @dam/adapters-damnet import {{args}}

reconcile:
    bun run --filter @dam/reconciler run
```

- [ ] **Step 2: Verify just is installed (or document install)**

```bash
just --version || brew install just
just
```

Expected: list of recipes printed.

- [ ] **Step 3: Commit**

```bash
git add justfile
git commit -m "chore: add justfile"
```

---

## Task 5: `packages/db` skeleton (Drizzle, client, migration runner)

**Files:**
- Create: `packages/db/package.json`
- Create: `packages/db/tsconfig.json`
- Create: `packages/db/drizzle.config.ts`
- Create: `packages/db/src/client.ts`
- Create: `packages/db/src/migrate.ts`

- [ ] **Step 1: Write `packages/db/package.json`**

```json
{
  "name": "@dam/db",
  "version": "0.0.0",
  "private": true,
  "type": "module",
  "exports": {
    ".": "./src/index.ts",
    "./schema": "./src/schema/index.ts",
    "./client": "./src/client.ts",
    "./repo/*": "./src/repo/*.ts"
  },
  "scripts": {
    "typecheck": "tsc --noEmit",
    "migrate": "bun run src/migrate.ts"
  },
  "dependencies": {
    "drizzle-orm": "^0.36.0",
    "pg": "^8.13.0",
    "postgres": "^3.4.4"
  },
  "devDependencies": {
    "drizzle-kit": "^0.27.0",
    "@types/pg": "^8.11.10"
  }
}
```

- [ ] **Step 2: Write `packages/db/tsconfig.json`**

```json
{
  "extends": "../../tsconfig.base.json",
  "compilerOptions": {
    "outDir": "dist",
    "rootDir": "src"
  },
  "include": ["src/**/*"]
}
```

- [ ] **Step 3: Write `packages/db/src/client.ts`**

```ts
import postgres from 'postgres';

const url = process.env.DATABASE_URL;
if (!url) {
  throw new Error('DATABASE_URL is not set');
}

export const sql = postgres(url, {
  max: 10,
  prepare: false,
  types: {
    bigint: postgres.BigInt,
  },
});

export type Sql = typeof sql;
```

- [ ] **Step 4: Write `packages/db/src/migrate.ts`**

Apply numbered SQL files from `migrations/` in lexicographic order, tracking applied
files in `_migrations`.

```ts
import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { sql } from './client.ts';

async function ensureTable(): Promise<void> {
  await sql`CREATE TABLE IF NOT EXISTS _migrations (
    name TEXT PRIMARY KEY,
    applied_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
  )`;
}

async function appliedSet(): Promise<Set<string>> {
  const rows = await sql<{ name: string }[]>`SELECT name FROM _migrations`;
  return new Set(rows.map((r) => r.name));
}

async function migrationFiles(dir: string): Promise<string[]> {
  const entries = await readdir(dir);
  return entries.filter((e) => e.endsWith('.sql')).sort();
}

async function main(): Promise<void> {
  const dir = join(import.meta.dir, '..', 'migrations');
  await ensureTable();
  const applied = await appliedSet();
  const files = await migrationFiles(dir);

  for (const file of files) {
    if (applied.has(file)) {
      console.log(`= ${file} (skip)`);
      continue;
    }
    const path = join(dir, file);
    const body = await readFile(path, 'utf8');
    console.log(`> ${file}`);
    await sql.begin(async (tx) => {
      await tx.unsafe(body);
      await tx`INSERT INTO _migrations (name) VALUES (${file})`;
    });
  }

  await sql.end();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
```

- [ ] **Step 5: Install deps**

```bash
bun install
```

- [ ] **Step 6: Commit**

```bash
git add packages/db
git commit -m "feat(db): scaffold @dam/db with client and migration runner"
```

---

## Task 6: `packages/core` skeleton

**Files:**
- Create: `packages/core/package.json`
- Create: `packages/core/tsconfig.json`
- Create: `packages/core/src/index.ts`

- [ ] **Step 1: Write `packages/core/package.json`**

```json
{
  "name": "@dam/core",
  "version": "0.0.0",
  "private": true,
  "type": "module",
  "exports": {
    ".": "./src/index.ts",
    "./slug": "./src/slug.ts",
    "./hateoas": "./src/hateoas.ts",
    "./similarity": "./src/similarity.ts",
    "./http_client": "./src/http_client.ts"
  },
  "scripts": {
    "typecheck": "tsc --noEmit"
  }
}
```

- [ ] **Step 2: Write `packages/core/tsconfig.json`**

```json
{
  "extends": "../../tsconfig.base.json",
  "include": ["src/**/*"]
}
```

- [ ] **Step 3: Write `packages/core/src/index.ts`**

```ts
export * from './slug.ts';
export * from './hateoas.ts';
export * from './similarity.ts';
export * from './http_client.ts';
```

- [ ] **Step 4: Commit**

```bash
git add packages/core
git commit -m "feat(core): scaffold @dam/core package"
```

---

## Task 7: Slug utility (TDD)

**Files:**
- Create: `packages/core/src/slug.ts`
- Test: `packages/core/src/slug.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
import { describe, expect, test } from 'bun:test';
import { toSlug, suffixedSlug } from './slug.ts';

describe('toSlug', () => {
  test('converts ASCII to lowercased dash-separated', () => {
    expect(toSlug('Yamba Dam')).toBe('yamba-dam');
  });

  test('strips punctuation', () => {
    expect(toSlug("O'Hara, Lake!")).toBe('ohara-lake');
  });

  test('romanizes Japanese kana', () => {
    expect(toSlug('やんば', { kanaToRomaji: true })).toBe('yanba');
  });

  test('does not romanize when option disabled', () => {
    const out = toSlug('やんば', { kanaToRomaji: false });
    expect(out).toBe('');
  });

  test('collapses multiple separators', () => {
    expect(toSlug('  Hello   World  ')).toBe('hello-world');
  });
});

describe('suffixedSlug', () => {
  test('returns base when not taken', () => {
    expect(suffixedSlug('yamba-dam', new Set())).toBe('yamba-dam');
  });

  test('appends -2 when base taken', () => {
    expect(suffixedSlug('yamba-dam', new Set(['yamba-dam']))).toBe('yamba-dam-2');
  });

  test('keeps incrementing', () => {
    expect(
      suffixedSlug('yamba-dam', new Set(['yamba-dam', 'yamba-dam-2', 'yamba-dam-3'])),
    ).toBe('yamba-dam-4');
  });
});
```

- [ ] **Step 2: Run the test (expect fail)**

```bash
bun test packages/core/src/slug.test.ts
```

Expected: FAIL — `Cannot find module './slug.ts'`.

- [ ] **Step 3: Implement `slug.ts`**

```ts
const KANA_TO_ROMAJI: Record<string, string> = {
  あ: 'a', い: 'i', う: 'u', え: 'e', お: 'o',
  か: 'ka', き: 'ki', く: 'ku', け: 'ke', こ: 'ko',
  さ: 'sa', し: 'shi', す: 'su', せ: 'se', そ: 'so',
  た: 'ta', ち: 'chi', つ: 'tsu', て: 'te', と: 'to',
  な: 'na', に: 'ni', ぬ: 'nu', ね: 'ne', の: 'no',
  は: 'ha', ひ: 'hi', ふ: 'fu', へ: 'he', ほ: 'ho',
  ま: 'ma', み: 'mi', む: 'mu', め: 'me', も: 'mo',
  や: 'ya', ゆ: 'yu', よ: 'yo',
  ら: 'ra', り: 'ri', る: 'ru', れ: 're', ろ: 'ro',
  わ: 'wa', を: 'wo', ん: 'n',
  が: 'ga', ぎ: 'gi', ぐ: 'gu', げ: 'ge', ご: 'go',
  ざ: 'za', じ: 'ji', ず: 'zu', ぜ: 'ze', ぞ: 'zo',
  だ: 'da', ぢ: 'ji', づ: 'zu', で: 'de', ど: 'do',
  ば: 'ba', び: 'bi', ぶ: 'bu', べ: 'be', ぼ: 'bo',
  ぱ: 'pa', ぴ: 'pi', ぷ: 'pu', ぺ: 'pe', ぽ: 'po',
};

const KATAKANA_OFFSET = 0x60;
function katakanaToHiragana(input: string): string {
  let out = '';
  for (const ch of input) {
    const code = ch.codePointAt(0) ?? 0;
    if (code >= 0x30a1 && code <= 0x30f6) {
      out += String.fromCodePoint(code - KATAKANA_OFFSET);
    } else {
      out += ch;
    }
  }
  return out;
}

function romanizeKana(input: string): string {
  const hira = katakanaToHiragana(input);
  let out = '';
  for (const ch of hira) {
    out += KANA_TO_ROMAJI[ch] ?? '';
  }
  return out;
}

export interface SlugOptions {
  kanaToRomaji?: boolean;
}

export function toSlug(input: string, options: SlugOptions = {}): string {
  const kanaToRomaji = options.kanaToRomaji ?? true;
  let base = input.normalize('NFKD').toLowerCase();
  if (kanaToRomaji) {
    base = romanizeKana(base);
  } else {
    // strip kana entirely
    base = base.replace(/[぀-ゟ゠-ヿ]/g, '');
  }
  const cleaned = base.replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
  return cleaned;
}

export function suffixedSlug(base: string, taken: Set<string>): string {
  if (!taken.has(base)) return base;
  let n = 2;
  while (taken.has(`${base}-${n}`)) n++;
  return `${base}-${n}`;
}
```

- [ ] **Step 4: Run the test (expect pass)**

```bash
bun test packages/core/src/slug.test.ts
```

Expected: PASS — 7/7.

- [ ] **Step 5: Commit**

```bash
git add packages/core/src/slug.ts packages/core/src/slug.test.ts
git commit -m "feat(core): add slug utility with kana romanization"
```

---

## Task 8: Migration 0000 — extensions

**Files:**
- Create: `packages/db/migrations/0000_extensions.sql`

- [ ] **Step 1: Write the migration**

```sql
CREATE EXTENSION IF NOT EXISTS postgis;
CREATE EXTENSION IF NOT EXISTS timescaledb;
CREATE EXTENSION IF NOT EXISTS pgcrypto;
CREATE EXTENSION IF NOT EXISTS pg_trgm;
```

- [ ] **Step 2: Run migrations**

```bash
just migrate
```

Expected: stdout shows `> 0000_extensions.sql`.

- [ ] **Step 3: Verify extensions installed**

```bash
docker compose exec db psql -U dam -d dam -c "\dx"
```

Expected: rows for `postgis`, `timescaledb`, `pgcrypto`, `pg_trgm`.

- [ ] **Step 4: Commit**

```bash
git add packages/db/migrations/0000_extensions.sql
git commit -m "feat(db): migration 0000 — enable extensions"
```

---

## Task 9: Migration 0001 — master tables

**Files:**
- Create: `packages/db/migrations/0001_master.sql`

- [ ] **Step 1: Write the migration**

```sql
-- Watersheds (1st-class & 2nd-class river systems)
CREATE TABLE watersheds (
  id BIGSERIAL PRIMARY KEY,
  code TEXT NOT NULL UNIQUE,                       -- NLNI watershed code
  slug TEXT NOT NULL UNIQUE,
  name TEXT NOT NULL,
  name_kana TEXT,
  kind TEXT NOT NULL CHECK (kind IN ('first', 'second', 'other')),
  boundary GEOGRAPHY(MULTIPOLYGON, 4326) NOT NULL,
  area_km2 DOUBLE PRECISION,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Rivers
CREATE TABLE rivers (
  id BIGSERIAL PRIMARY KEY,
  watershed_id BIGINT NOT NULL REFERENCES watersheds(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  kind TEXT NOT NULL CHECK (kind IN ('main', 'tributary', 'other')),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (watershed_id, name)
);

-- Dams (master)
CREATE TABLE dams (
  id BIGSERIAL PRIMARY KEY,
  slug TEXT NOT NULL UNIQUE,
  name TEXT NOT NULL,
  name_kana TEXT,
  pref_code CHAR(2) NOT NULL,
  river_id BIGINT REFERENCES rivers(id) ON DELETE SET NULL,
  watershed_id BIGINT REFERENCES watersheds(id) ON DELETE SET NULL,
  manager TEXT,
  type TEXT,
  height_m NUMERIC(8,2),
  total_capacity_m3 NUMERIC(18,2),
  effective_capacity_m3 NUMERIC(18,2),
  flood_capacity_m3 NUMERIC(18,2),
  completed_year INT,
  location GEOGRAPHY(POINT, 4326) NOT NULL,
  external_ids JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Match review queue (low-confidence reconciliation)
CREATE TABLE match_review (
  id BIGSERIAL PRIMARY KEY,
  source_id TEXT NOT NULL,                         -- e.g. 'damnet'
  source_external_id TEXT NOT NULL,                -- the source's record id
  candidate_dam_ids BIGINT[] NOT NULL,
  best_dam_id BIGINT REFERENCES dams(id) ON DELETE SET NULL,
  confidence NUMERIC(5,4) NOT NULL,
  payload JSONB NOT NULL,                          -- the source's parsed record
  resolved_dam_id BIGINT REFERENCES dams(id) ON DELETE SET NULL,
  resolved_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (source_id, source_external_id)
);

-- Touch updated_at automatically
CREATE OR REPLACE FUNCTION touch_updated_at()
RETURNS TRIGGER AS $$
BEGIN
  NEW.updated_at = NOW();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER trg_watersheds_updated  BEFORE UPDATE ON watersheds  FOR EACH ROW EXECUTE FUNCTION touch_updated_at();
CREATE TRIGGER trg_rivers_updated      BEFORE UPDATE ON rivers      FOR EACH ROW EXECUTE FUNCTION touch_updated_at();
CREATE TRIGGER trg_dams_updated        BEFORE UPDATE ON dams        FOR EACH ROW EXECUTE FUNCTION touch_updated_at();
```

- [ ] **Step 2: Apply migration**

```bash
just migrate
```

Expected: stdout shows `> 0001_master.sql`.

- [ ] **Step 3: Verify tables**

```bash
docker compose exec db psql -U dam -d dam -c "\dt"
```

Expected: rows for `dams`, `match_review`, `rivers`, `watersheds`, `_migrations`.

- [ ] **Step 4: Commit**

```bash
git add packages/db/migrations/0001_master.sql
git commit -m "feat(db): migration 0001 — master tables"
```

---

## Task 10: Migration 0002 — spatial and trigram indexes

**Files:**
- Create: `packages/db/migrations/0002_indexes.sql`

- [ ] **Step 1: Write the migration**

```sql
-- Watershed boundary lookup (point-in-polygon)
CREATE INDEX watersheds_boundary_gist ON watersheds USING GIST (boundary);

-- Dam spatial lookup (radius searches)
CREATE INDEX dams_location_gist ON dams USING GIST (location);

-- Trigram for name fuzzy match in reconciliation
CREATE INDEX dams_name_trgm    ON dams    USING GIN (name gin_trgm_ops);
CREATE INDEX dams_name_kana_trgm ON dams  USING GIN (name_kana gin_trgm_ops);

-- Common filters
CREATE INDEX dams_pref_code   ON dams (pref_code);
CREATE INDEX dams_watershed   ON dams (watershed_id);
CREATE INDEX dams_manager     ON dams (manager);
```

- [ ] **Step 2: Apply and verify**

```bash
just migrate
docker compose exec db psql -U dam -d dam -c "\di"
```

Expected: indexes listed.

- [ ] **Step 3: Commit**

```bash
git add packages/db/migrations/0002_indexes.sql
git commit -m "feat(db): migration 0002 — spatial and trigram indexes"
```

---

## Task 11: Drizzle schema definitions

**Files:**
- Create: `packages/db/src/schema/watersheds.ts`
- Create: `packages/db/src/schema/rivers.ts`
- Create: `packages/db/src/schema/dams.ts`
- Create: `packages/db/src/schema/match_review.ts`
- Create: `packages/db/src/schema/index.ts`
- Create: `packages/db/src/index.ts`

- [ ] **Step 1: `watersheds.ts`**

```ts
import { pgTable, bigserial, text, doublePrecision, timestamp, customType } from 'drizzle-orm/pg-core';

const geographyMultiPolygon = customType<{ data: string; driverData: string }>({
  dataType: () => 'GEOGRAPHY(MULTIPOLYGON, 4326)',
});

export const watersheds = pgTable('watersheds', {
  id: bigserial('id', { mode: 'bigint' }).primaryKey(),
  code: text('code').notNull().unique(),
  slug: text('slug').notNull().unique(),
  name: text('name').notNull(),
  nameKana: text('name_kana'),
  kind: text('kind', { enum: ['first', 'second', 'other'] }).notNull(),
  boundary: geographyMultiPolygon('boundary').notNull(),
  areaKm2: doublePrecision('area_km2'),
  createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).defaultNow().notNull(),
});

export type Watershed = typeof watersheds.$inferSelect;
export type NewWatershed = typeof watersheds.$inferInsert;
```

- [ ] **Step 2: `rivers.ts`**

```ts
import { bigint, bigserial, pgTable, text, timestamp, unique } from 'drizzle-orm/pg-core';

export const rivers = pgTable(
  'rivers',
  {
    id: bigserial('id', { mode: 'bigint' }).primaryKey(),
    watershedId: bigint('watershed_id', { mode: 'bigint' }).notNull(),
    name: text('name').notNull(),
    kind: text('kind', { enum: ['main', 'tributary', 'other'] }).notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => ({
    uniq: unique('rivers_watershed_name_uniq').on(t.watershedId, t.name),
  }),
);

export type River = typeof rivers.$inferSelect;
export type NewRiver = typeof rivers.$inferInsert;
```

- [ ] **Step 3: `dams.ts`**

```ts
import {
  bigint, bigserial, char, customType, integer, jsonb,
  numeric, pgTable, text, timestamp,
} from 'drizzle-orm/pg-core';

const geographyPoint = customType<{ data: string; driverData: string }>({
  dataType: () => 'GEOGRAPHY(POINT, 4326)',
});

export const dams = pgTable('dams', {
  id: bigserial('id', { mode: 'bigint' }).primaryKey(),
  slug: text('slug').notNull().unique(),
  name: text('name').notNull(),
  nameKana: text('name_kana'),
  prefCode: char('pref_code', { length: 2 }).notNull(),
  riverId: bigint('river_id', { mode: 'bigint' }),
  watershedId: bigint('watershed_id', { mode: 'bigint' }),
  manager: text('manager'),
  type: text('type'),
  heightM: numeric('height_m'),
  totalCapacityM3: numeric('total_capacity_m3'),
  effectiveCapacityM3: numeric('effective_capacity_m3'),
  floodCapacityM3: numeric('flood_capacity_m3'),
  completedYear: integer('completed_year'),
  location: geographyPoint('location').notNull(),
  externalIds: jsonb('external_ids').$type<Record<string, string>>().default({}).notNull(),
  createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).defaultNow().notNull(),
});

export type Dam = typeof dams.$inferSelect;
export type NewDam = typeof dams.$inferInsert;
```

- [ ] **Step 4: `match_review.ts`**

```ts
import {
  bigint, bigserial, jsonb, numeric, pgTable, text, timestamp, unique,
} from 'drizzle-orm/pg-core';

export const matchReview = pgTable(
  'match_review',
  {
    id: bigserial('id', { mode: 'bigint' }).primaryKey(),
    sourceId: text('source_id').notNull(),
    sourceExternalId: text('source_external_id').notNull(),
    candidateDamIds: bigint('candidate_dam_ids', { mode: 'bigint' }).array().notNull(),
    bestDamId: bigint('best_dam_id', { mode: 'bigint' }),
    confidence: numeric('confidence').notNull(),
    payload: jsonb('payload').notNull(),
    resolvedDamId: bigint('resolved_dam_id', { mode: 'bigint' }),
    resolvedAt: timestamp('resolved_at', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => ({
    uniq: unique('match_review_src_uniq').on(t.sourceId, t.sourceExternalId),
  }),
);

export type MatchReview = typeof matchReview.$inferSelect;
```

- [ ] **Step 5: `schema/index.ts` and package `index.ts`**

`packages/db/src/schema/index.ts`:
```ts
export * from './watersheds.ts';
export * from './rivers.ts';
export * from './dams.ts';
export * from './match_review.ts';
```

`packages/db/src/index.ts`:
```ts
export { sql } from './client.ts';
export * as schema from './schema/index.ts';
```

- [ ] **Step 6: Typecheck**

```bash
bun run --filter @dam/db typecheck
```

Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add packages/db/src/schema packages/db/src/index.ts
git commit -m "feat(db): add Drizzle schemas for master tables"
```

---

## Task 12: Integration test harness

**Files:**
- Create: `tests/integration/helpers.ts`
- Create: `packages/db/src/repo/_smoke.test.ts`

- [ ] **Step 1: Helper that resets a fresh test DB**

```ts
// tests/integration/helpers.ts
import postgres from 'postgres';

export async function withTestDb<T>(fn: (sql: postgres.Sql) => Promise<T>): Promise<T> {
  const url = process.env.DATABASE_URL;
  if (!url) throw new Error('DATABASE_URL not set');
  const sql = postgres(url, { max: 4, prepare: false });
  try {
    await sql`BEGIN`;
    try {
      const result = await fn(sql);
      await sql`ROLLBACK`;
      return result;
    } catch (err) {
      await sql`ROLLBACK`;
      throw err;
    }
  } finally {
    await sql.end();
  }
}
```

Note: nested transactions across separate connections do not actually roll
back — for tests that span repo calls using the package's pooled `sql`, use
a per-test schema reset instead. We will use this helper for tests that
operate on a single connection it provides.

- [ ] **Step 2: Smoke test verifying tables exist**

```ts
// packages/db/src/repo/_smoke.test.ts
import { describe, expect, test } from 'bun:test';
import { withTestDb } from '../../../../tests/integration/helpers.ts';

describe('schema smoke', () => {
  test('master tables exist', async () => {
    await withTestDb(async (sql) => {
      const rows = await sql<{ table_name: string }[]>`
        SELECT table_name FROM information_schema.tables
        WHERE table_schema = 'public'
          AND table_name IN ('dams','watersheds','rivers','match_review')
      `;
      expect(rows.length).toBe(4);
    });
  });
});
```

- [ ] **Step 3: Run integration tests**

```bash
just up
just migrate
bun test packages/db
```

Expected: PASS.

- [ ] **Step 4: Commit**

```bash
git add tests/integration/helpers.ts packages/db/src/repo/_smoke.test.ts
git commit -m "test(db): integration smoke for master tables"
```

---

## Task 13: HATEOAS `_links` builder (TDD)

**Files:**
- Create: `packages/core/src/hateoas.ts`
- Test: `packages/core/src/hateoas.test.ts`

- [ ] **Step 1: Test**

```ts
import { describe, expect, test } from 'bun:test';
import { buildLinks, type Link } from './hateoas.ts';

describe('buildLinks', () => {
  test('builds self link', () => {
    const links = buildLinks({ self: { href: '/api/v1/dams/yamba' } });
    expect(links.self).toEqual({ href: '/api/v1/dams/yamba' });
  });

  test('templated link is preserved', () => {
    const links = buildLinks({
      observations: { href: '/api/v1/dams/yamba/observations{?from,to}', templated: true },
    });
    expect((links.observations as Link).templated).toBe(true);
  });

  test('omits null values', () => {
    const links = buildLinks({ self: { href: '/x' }, optional: null });
    expect('optional' in links).toBe(false);
  });
});
```

- [ ] **Step 2: Run (expect fail)**

```bash
bun test packages/core/src/hateoas.test.ts
```

- [ ] **Step 3: Implement**

```ts
// packages/core/src/hateoas.ts
export interface Link {
  href: string;
  templated?: boolean;
  type?: string;
  title?: string;
}

export type LinksInput = Record<string, Link | null | undefined>;
export type Links = Record<string, Link>;

export function buildLinks(input: LinksInput): Links {
  const out: Links = {};
  for (const [rel, link] of Object.entries(input)) {
    if (!link) continue;
    out[rel] = link;
  }
  return out;
}
```

- [ ] **Step 4: Run (expect pass)**

```bash
bun test packages/core/src/hateoas.test.ts
```

- [ ] **Step 5: Commit**

```bash
git add packages/core/src/hateoas.ts packages/core/src/hateoas.test.ts
git commit -m "feat(core): hateoas links builder"
```

---

## Task 14: Name similarity utility (TDD)

**Files:**
- Create: `packages/core/src/similarity.ts`
- Test: `packages/core/src/similarity.test.ts`

- [ ] **Step 1: Test**

```ts
import { describe, expect, test } from 'bun:test';
import { trigramSimilarity, normalizeJaName } from './similarity.ts';

describe('normalizeJaName', () => {
  test('removes common dam suffix', () => {
    expect(normalizeJaName('八ッ場ダム')).toBe('八ッ場');
  });

  test('strips middle dot and parens', () => {
    expect(normalizeJaName('利根（とね）ダム')).toBe('利根');
  });

  test('lowercases and trims latin', () => {
    expect(normalizeJaName(' Yamba Dam ')).toBe('yamba');
  });
});

describe('trigramSimilarity', () => {
  test('identical strings score 1', () => {
    expect(trigramSimilarity('hello', 'hello')).toBeCloseTo(1, 5);
  });

  test('disjoint strings score 0', () => {
    expect(trigramSimilarity('abcdef', 'xyzuvw')).toBeCloseTo(0, 5);
  });

  test('partial overlap is between', () => {
    const s = trigramSimilarity('yamba', 'yamaba');
    expect(s).toBeGreaterThan(0);
    expect(s).toBeLessThan(1);
  });
});
```

- [ ] **Step 2: Run (fail)**
```bash
bun test packages/core/src/similarity.test.ts
```

- [ ] **Step 3: Implement**

```ts
// packages/core/src/similarity.ts
export function normalizeJaName(input: string): string {
  let s = input.normalize('NFKC').trim();
  // strip parenthesized readings
  s = s.replace(/[（(].*?[)）]/g, '');
  // strip "ダム" / "貯水池" suffix
  s = s.replace(/(?:ダム|貯水池)$/u, '');
  return s.trim().toLowerCase();
}

function trigrams(input: string): Set<string> {
  const padded = `  ${input}  `;
  const set = new Set<string>();
  for (let i = 0; i + 3 <= padded.length; i++) {
    set.add(padded.slice(i, i + 3));
  }
  return set;
}

export function trigramSimilarity(a: string, b: string): number {
  if (!a && !b) return 1;
  if (!a || !b) return 0;
  if (a === b) return 1;
  const ta = trigrams(a);
  const tb = trigrams(b);
  let inter = 0;
  for (const t of ta) if (tb.has(t)) inter++;
  const union = ta.size + tb.size - inter;
  return union === 0 ? 0 : inter / union;
}
```

- [ ] **Step 4: Run (pass)**

```bash
bun test packages/core/src/similarity.test.ts
```

- [ ] **Step 5: Commit**

```bash
git add packages/core/src/similarity.ts packages/core/src/similarity.test.ts
git commit -m "feat(core): name similarity utilities"
```

---

## Task 15: HTTP client with rate-limit and ETag (TDD)

**Files:**
- Create: `packages/core/src/http_client.ts`
- Test: `packages/core/src/http_client.test.ts`

- [ ] **Step 1: Test**

```ts
import { describe, expect, test } from 'bun:test';
import { HttpClient } from './http_client.ts';

function mockServer(handler: (req: Request) => Response | Promise<Response>) {
  const server = Bun.serve({ port: 0, fetch: (req) => handler(req) });
  return {
    url: `http://127.0.0.1:${server.port}`,
    stop: () => server.stop(true),
  };
}

describe('HttpClient', () => {
  test('respects min interval between requests', async () => {
    let count = 0;
    const srv = mockServer(() => {
      count++;
      return new Response('ok');
    });
    const c = new HttpClient({ minIntervalMs: 200, userAgent: 'test/1.0' });
    const t0 = Date.now();
    await c.get(srv.url);
    await c.get(srv.url);
    const elapsed = Date.now() - t0;
    srv.stop();
    expect(count).toBe(2);
    expect(elapsed).toBeGreaterThanOrEqual(200);
  });

  test('returns 304 with cached body when ETag matches', async () => {
    const srv = mockServer((req) => {
      if (req.headers.get('if-none-match') === '"abc"') {
        return new Response(null, { status: 304 });
      }
      return new Response('hello', { headers: { etag: '"abc"' } });
    });
    const c = new HttpClient({ minIntervalMs: 0, userAgent: 'test/1.0' });
    const r1 = await c.get(srv.url);
    expect(r1.status).toBe(200);
    expect(r1.bodyText).toBe('hello');
    const r2 = await c.get(srv.url, { ifNoneMatch: r1.etag });
    expect(r2.status).toBe(304);
    srv.stop();
  });

  test('retries on 5xx with backoff', async () => {
    let count = 0;
    const srv = mockServer(() => {
      count++;
      if (count < 3) return new Response('boom', { status: 500 });
      return new Response('ok');
    });
    const c = new HttpClient({
      minIntervalMs: 0,
      userAgent: 'test/1.0',
      maxRetries: 3,
      backoffBaseMs: 10,
    });
    const r = await c.get(srv.url);
    srv.stop();
    expect(count).toBe(3);
    expect(r.status).toBe(200);
  });
});
```

- [ ] **Step 2: Run (fail)**
```bash
bun test packages/core/src/http_client.test.ts
```

- [ ] **Step 3: Implement**

```ts
// packages/core/src/http_client.ts
export interface HttpClientOptions {
  userAgent: string;
  minIntervalMs?: number;
  maxRetries?: number;
  backoffBaseMs?: number;
  timeoutMs?: number;
}

export interface GetOptions {
  ifNoneMatch?: string | undefined;
  headers?: Record<string, string>;
}

export interface HttpResponse {
  status: number;
  bodyText: string;
  bodyBytes: Uint8Array;
  etag?: string | undefined;
  headers: Headers;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export class HttpClient {
  private readonly opts: Required<HttpClientOptions>;
  private lastFetchAt = 0;

  constructor(options: HttpClientOptions) {
    this.opts = {
      minIntervalMs: 0,
      maxRetries: 0,
      backoffBaseMs: 250,
      timeoutMs: 30_000,
      ...options,
    };
  }

  async get(url: string, options: GetOptions = {}): Promise<HttpResponse> {
    await this.throttle();
    const headers: Record<string, string> = {
      'user-agent': this.opts.userAgent,
      ...(options.headers ?? {}),
    };
    if (options.ifNoneMatch) headers['if-none-match'] = options.ifNoneMatch;

    let attempt = 0;
    while (true) {
      try {
        const ctrl = new AbortController();
        const t = setTimeout(() => ctrl.abort(), this.opts.timeoutMs);
        const res = await fetch(url, { headers, signal: ctrl.signal });
        clearTimeout(t);
        if (res.status === 304) {
          return {
            status: 304,
            bodyText: '',
            bodyBytes: new Uint8Array(),
            etag: res.headers.get('etag') ?? undefined,
            headers: res.headers,
          };
        }
        if (res.status >= 500 && attempt < this.opts.maxRetries) {
          attempt++;
          await sleep(this.opts.backoffBaseMs * 2 ** (attempt - 1));
          continue;
        }
        const bytes = new Uint8Array(await res.arrayBuffer());
        return {
          status: res.status,
          bodyBytes: bytes,
          bodyText: new TextDecoder('utf-8').decode(bytes),
          etag: res.headers.get('etag') ?? undefined,
          headers: res.headers,
        };
      } catch (err) {
        if (attempt < this.opts.maxRetries) {
          attempt++;
          await sleep(this.opts.backoffBaseMs * 2 ** (attempt - 1));
          continue;
        }
        throw err;
      }
    }
  }

  private async throttle(): Promise<void> {
    const interval = this.opts.minIntervalMs;
    if (interval <= 0) return;
    const now = Date.now();
    const wait = this.lastFetchAt + interval - now;
    if (wait > 0) await sleep(wait);
    this.lastFetchAt = Date.now();
  }
}
```

- [ ] **Step 4: Run (pass)**
```bash
bun test packages/core/src/http_client.test.ts
```

- [ ] **Step 5: Commit**

```bash
git add packages/core/src/http_client.ts packages/core/src/http_client.test.ts
git commit -m "feat(core): http client with throttle, retry, and etag support"
```

---

## Task 16: Repos for watersheds, dams, match_review

**Files:**
- Create: `packages/db/src/repo/watersheds.ts`
- Create: `packages/db/src/repo/dams.ts`
- Create: `packages/db/src/repo/match_review.ts`
- Test: `packages/db/src/repo/watersheds.test.ts`

- [ ] **Step 1: `watersheds.ts` repo**

```ts
import { sql } from '../client.ts';

export interface UpsertWatershedInput {
  code: string;
  slug: string;
  name: string;
  nameKana?: string | null;
  kind: 'first' | 'second' | 'other';
  boundaryGeoJSON: object;        // FeatureGeometry
  areaKm2?: number | null;
}

export async function upsertWatershed(input: UpsertWatershedInput): Promise<bigint> {
  const rows = await sql<{ id: bigint }[]>`
    INSERT INTO watersheds (code, slug, name, name_kana, kind, boundary, area_km2)
    VALUES (
      ${input.code}, ${input.slug}, ${input.name}, ${input.nameKana ?? null},
      ${input.kind},
      ST_Multi(ST_GeomFromGeoJSON(${JSON.stringify(input.boundaryGeoJSON)}))::geography,
      ${input.areaKm2 ?? null}
    )
    ON CONFLICT (code) DO UPDATE SET
      slug      = EXCLUDED.slug,
      name      = EXCLUDED.name,
      name_kana = EXCLUDED.name_kana,
      kind      = EXCLUDED.kind,
      boundary  = EXCLUDED.boundary,
      area_km2  = EXCLUDED.area_km2
    RETURNING id
  `;
  const row = rows[0];
  if (!row) throw new Error('upsertWatershed returned no row');
  return row.id;
}

export interface WatershedAtPoint {
  id: bigint;
  code: string;
  slug: string;
  name: string;
  kind: 'first' | 'second' | 'other';
}

export async function findWatershedContaining(
  lat: number,
  lng: number,
): Promise<WatershedAtPoint | null> {
  const rows = await sql<WatershedAtPoint[]>`
    SELECT id, code, slug, name, kind
    FROM watersheds
    WHERE ST_Contains(boundary::geometry,
                      ST_SetSRID(ST_MakePoint(${lng}, ${lat}), 4326))
    ORDER BY ST_Area(boundary) ASC
    LIMIT 1
  `;
  return rows[0] ?? null;
}

export interface NearestWatershed extends WatershedAtPoint {
  distanceM: number;
}

export async function findNearestWatershed(
  lat: number,
  lng: number,
): Promise<NearestWatershed | null> {
  const rows = await sql<NearestWatershed[]>`
    SELECT id, code, slug, name, kind,
           ST_Distance(boundary,
                       ST_SetSRID(ST_MakePoint(${lng}, ${lat}), 4326)::geography) AS "distanceM"
    FROM watersheds
    ORDER BY boundary <-> ST_SetSRID(ST_MakePoint(${lng}, ${lat}), 4326)::geography
    LIMIT 1
  `;
  return rows[0] ?? null;
}
```

- [ ] **Step 2: `dams.ts` repo**

```ts
import { sql } from '../client.ts';

export interface UpsertDamInput {
  slug: string;
  name: string;
  nameKana?: string | null;
  prefCode: string;
  watershedId?: bigint | null;
  riverId?: bigint | null;
  manager?: string | null;
  type?: string | null;
  heightM?: number | null;
  totalCapacityM3?: number | null;
  effectiveCapacityM3?: number | null;
  floodCapacityM3?: number | null;
  completedYear?: number | null;
  lat: number;
  lng: number;
  externalIds: Record<string, string>;   // e.g. { ndi: 'W01-12345' }
}

export async function upsertDamByExternalId(
  source: string,
  input: UpsertDamInput,
): Promise<bigint> {
  const rows = await sql<{ id: bigint }[]>`
    INSERT INTO dams (
      slug, name, name_kana, pref_code, watershed_id, river_id, manager, type,
      height_m, total_capacity_m3, effective_capacity_m3, flood_capacity_m3,
      completed_year, location, external_ids
    )
    VALUES (
      ${input.slug}, ${input.name}, ${input.nameKana ?? null}, ${input.prefCode},
      ${input.watershedId ?? null}, ${input.riverId ?? null},
      ${input.manager ?? null}, ${input.type ?? null},
      ${input.heightM ?? null}, ${input.totalCapacityM3 ?? null},
      ${input.effectiveCapacityM3 ?? null}, ${input.floodCapacityM3 ?? null},
      ${input.completedYear ?? null},
      ST_SetSRID(ST_MakePoint(${input.lng}, ${input.lat}), 4326)::geography,
      ${input.externalIds}::jsonb
    )
    ON CONFLICT ((external_ids ->> ${source})) WHERE external_ids ? ${source}
    DO UPDATE SET
      name              = EXCLUDED.name,
      name_kana         = EXCLUDED.name_kana,
      pref_code         = EXCLUDED.pref_code,
      watershed_id      = COALESCE(EXCLUDED.watershed_id, dams.watershed_id),
      manager           = COALESCE(EXCLUDED.manager, dams.manager),
      type              = COALESCE(EXCLUDED.type, dams.type),
      height_m          = COALESCE(EXCLUDED.height_m, dams.height_m),
      total_capacity_m3 = COALESCE(EXCLUDED.total_capacity_m3, dams.total_capacity_m3),
      external_ids      = dams.external_ids || EXCLUDED.external_ids,
      location          = EXCLUDED.location
    RETURNING id
  `;
  const row = rows[0];
  if (!row) throw new Error('upsertDam returned no row');
  return row.id;
}

export async function takenSlugs(prefix: string): Promise<Set<string>> {
  const rows = await sql<{ slug: string }[]>`
    SELECT slug FROM dams WHERE slug LIKE ${prefix + '%'}
  `;
  return new Set(rows.map((r) => r.slug));
}

export interface DamRow {
  id: bigint;
  slug: string;
  name: string;
  prefCode: string;
  manager: string | null;
  watershedId: bigint | null;
  externalIds: Record<string, string>;
}

export async function findDamsForReconciliation(opts: {
  pref?: string;
  centerLat?: number;
  centerLng?: number;
  radiusM?: number;
  limit?: number;
}): Promise<DamRow[]> {
  const limit = opts.limit ?? 50;
  if (opts.centerLat !== undefined && opts.centerLng !== undefined && opts.radiusM) {
    return sql<DamRow[]>`
      SELECT id, slug, name, pref_code AS "prefCode", manager,
             watershed_id AS "watershedId", external_ids AS "externalIds"
      FROM dams
      WHERE ST_DWithin(
              location,
              ST_SetSRID(ST_MakePoint(${opts.centerLng}, ${opts.centerLat}), 4326)::geography,
              ${opts.radiusM})
        AND (${opts.pref ?? null}::text IS NULL OR pref_code = ${opts.pref ?? null})
      LIMIT ${limit}
    `;
  }
  return sql<DamRow[]>`
    SELECT id, slug, name, pref_code AS "prefCode", manager,
           watershed_id AS "watershedId", external_ids AS "externalIds"
    FROM dams
    WHERE (${opts.pref ?? null}::text IS NULL OR pref_code = ${opts.pref ?? null})
    LIMIT ${limit}
  `;
}

export async function appendExternalId(
  damId: bigint,
  source: string,
  externalId: string,
): Promise<void> {
  await sql`
    UPDATE dams
    SET external_ids = external_ids || jsonb_build_object(${source}, ${externalId})
    WHERE id = ${damId}
  `;
}

export async function applyDamnetAttributes(
  damId: bigint,
  attrs: {
    nameKana?: string | null;
    type?: string | null;
    heightM?: number | null;
    totalCapacityM3?: number | null;
    effectiveCapacityM3?: number | null;
    floodCapacityM3?: number | null;
    completedYear?: number | null;
    manager?: string | null;
  },
): Promise<void> {
  await sql`
    UPDATE dams SET
      name_kana             = COALESCE(${attrs.nameKana ?? null}, name_kana),
      type                  = COALESCE(${attrs.type ?? null}, type),
      height_m              = COALESCE(${attrs.heightM ?? null}, height_m),
      total_capacity_m3     = COALESCE(${attrs.totalCapacityM3 ?? null}, total_capacity_m3),
      effective_capacity_m3 = COALESCE(${attrs.effectiveCapacityM3 ?? null}, effective_capacity_m3),
      flood_capacity_m3     = COALESCE(${attrs.floodCapacityM3 ?? null}, flood_capacity_m3),
      completed_year        = COALESCE(${attrs.completedYear ?? null}, completed_year),
      manager               = COALESCE(${attrs.manager ?? null}, manager)
    WHERE id = ${damId}
  `;
}
```

Note: the ON CONFLICT clause above requires a unique partial index. Add it
in the next migration step.

- [ ] **Step 3: Add migration 0003 for the partial unique index**

Create `packages/db/migrations/0003_external_ids_unique.sql`:

```sql
-- Unique index per source value within external_ids
CREATE UNIQUE INDEX dams_ext_ndi_uniq
  ON dams ((external_ids ->> 'ndi')) WHERE external_ids ? 'ndi';
CREATE UNIQUE INDEX dams_ext_damnet_uniq
  ON dams ((external_ids ->> 'damnet')) WHERE external_ids ? 'damnet';
```

Run:
```bash
just migrate
```

- [ ] **Step 4: Adjust `upsertDamByExternalId` to use the source-specific index**

The expression-based ON CONFLICT in PostgreSQL must match an existing
partial unique index. Update `upsertDamByExternalId` in `dams.ts` so that
when `source` is `ndi` it targets `dams_ext_ndi_uniq`, when `damnet` it
targets `dams_ext_damnet_uniq`. Replace the body to:

```ts
export async function upsertDamByExternalId(
  source: 'ndi' | 'damnet',
  input: UpsertDamInput,
): Promise<bigint> {
  // Two near-identical statements differing only in the conflict target.
  if (source === 'ndi') {
    return upsertDamByNdi(input);
  }
  return upsertDamByDamnet(input);
}

async function upsertDamByNdi(input: UpsertDamInput): Promise<bigint> {
  const rows = await sql<{ id: bigint }[]>`
    INSERT INTO dams (
      slug, name, name_kana, pref_code, watershed_id, river_id, manager, type,
      height_m, total_capacity_m3, effective_capacity_m3, flood_capacity_m3,
      completed_year, location, external_ids
    )
    VALUES (
      ${input.slug}, ${input.name}, ${input.nameKana ?? null}, ${input.prefCode},
      ${input.watershedId ?? null}, ${input.riverId ?? null},
      ${input.manager ?? null}, ${input.type ?? null},
      ${input.heightM ?? null}, ${input.totalCapacityM3 ?? null},
      ${input.effectiveCapacityM3 ?? null}, ${input.floodCapacityM3 ?? null},
      ${input.completedYear ?? null},
      ST_SetSRID(ST_MakePoint(${input.lng}, ${input.lat}), 4326)::geography,
      ${input.externalIds}::jsonb
    )
    ON CONFLICT ((external_ids ->> 'ndi')) WHERE external_ids ? 'ndi'
    DO UPDATE SET
      name              = EXCLUDED.name,
      pref_code         = EXCLUDED.pref_code,
      watershed_id      = COALESCE(EXCLUDED.watershed_id, dams.watershed_id),
      external_ids      = dams.external_ids || EXCLUDED.external_ids,
      location          = EXCLUDED.location
    RETURNING id
  `;
  const row = rows[0];
  if (!row) throw new Error('upsertDamByNdi returned no row');
  return row.id;
}

async function upsertDamByDamnet(input: UpsertDamInput): Promise<bigint> {
  const rows = await sql<{ id: bigint }[]>`
    INSERT INTO dams (
      slug, name, name_kana, pref_code, watershed_id, river_id, manager, type,
      height_m, total_capacity_m3, effective_capacity_m3, flood_capacity_m3,
      completed_year, location, external_ids
    )
    VALUES (
      ${input.slug}, ${input.name}, ${input.nameKana ?? null}, ${input.prefCode},
      ${input.watershedId ?? null}, ${input.riverId ?? null},
      ${input.manager ?? null}, ${input.type ?? null},
      ${input.heightM ?? null}, ${input.totalCapacityM3 ?? null},
      ${input.effectiveCapacityM3 ?? null}, ${input.floodCapacityM3 ?? null},
      ${input.completedYear ?? null},
      ST_SetSRID(ST_MakePoint(${input.lng}, ${input.lat}), 4326)::geography,
      ${input.externalIds}::jsonb
    )
    ON CONFLICT ((external_ids ->> 'damnet')) WHERE external_ids ? 'damnet'
    DO UPDATE SET
      name              = EXCLUDED.name,
      external_ids      = dams.external_ids || EXCLUDED.external_ids
    RETURNING id
  `;
  const row = rows[0];
  if (!row) throw new Error('upsertDamByDamnet returned no row');
  return row.id;
}
```

- [ ] **Step 5: `match_review.ts` repo**

```ts
// packages/db/src/repo/match_review.ts
import { sql } from '../client.ts';

export interface NewMatchReview {
  sourceId: string;
  sourceExternalId: string;
  candidateDamIds: bigint[];
  bestDamId: bigint | null;
  confidence: number;
  payload: Record<string, unknown>;
}

export async function enqueueMatchReview(input: NewMatchReview): Promise<void> {
  await sql`
    INSERT INTO match_review (
      source_id, source_external_id, candidate_dam_ids, best_dam_id, confidence, payload
    )
    VALUES (
      ${input.sourceId}, ${input.sourceExternalId},
      ${input.candidateDamIds}::bigint[],
      ${input.bestDamId},
      ${input.confidence}, ${input.payload}::jsonb
    )
    ON CONFLICT (source_id, source_external_id)
    DO UPDATE SET candidate_dam_ids = EXCLUDED.candidate_dam_ids,
                  best_dam_id = EXCLUDED.best_dam_id,
                  confidence  = EXCLUDED.confidence,
                  payload     = EXCLUDED.payload
  `;
}
```

- [ ] **Step 6: Integration test for watersheds repo**

```ts
// packages/db/src/repo/watersheds.test.ts
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { sql } from '../client.ts';
import {
  findNearestWatershed,
  findWatershedContaining,
  upsertWatershed,
} from './watersheds.ts';

const SQUARE_TOKYO = {
  type: 'MultiPolygon',
  coordinates: [
    [
      [
        [139.0, 35.0], [140.0, 35.0], [140.0, 36.0], [139.0, 36.0], [139.0, 35.0],
      ],
    ],
  ],
};

describe('watersheds repo', () => {
  beforeAll(async () => {
    await sql`DELETE FROM watersheds WHERE code IN ('TEST-01','TEST-02')`;
    await upsertWatershed({
      code: 'TEST-01',
      slug: 'test-tokyo',
      name: 'Test Tokyo',
      kind: 'first',
      boundaryGeoJSON: SQUARE_TOKYO,
      areaKm2: 100,
    });
  });

  afterAll(async () => {
    await sql`DELETE FROM watersheds WHERE code IN ('TEST-01','TEST-02')`;
  });

  test('findWatershedContaining returns the polygon', async () => {
    const w = await findWatershedContaining(35.5, 139.5);
    expect(w?.code).toBe('TEST-01');
  });

  test('findWatershedContaining returns null outside polygon', async () => {
    const w = await findWatershedContaining(0, 0);
    expect(w).toBeNull();
  });

  test('findNearestWatershed surfaces nearest polygon', async () => {
    const w = await findNearestWatershed(34.0, 139.5);
    expect(w?.code).toBe('TEST-01');
    expect(w?.distanceM).toBeGreaterThan(0);
  });
});
```

- [ ] **Step 7: Run**
```bash
just up && just migrate
bun test packages/db/src/repo/watersheds.test.ts
```

Expected: PASS.

- [ ] **Step 8: Commit**

```bash
git add packages/db/src/repo packages/db/migrations/0003_external_ids_unique.sql
git commit -m "feat(db): repos for watersheds, dams, match_review and partial indexes"
```

---

## Task 17: NDI adapter package skeleton

**Files:**
- Create: `packages/adapters/ndi/package.json`
- Create: `packages/adapters/ndi/tsconfig.json`
- Create: `packages/adapters/ndi/src/types.ts`

- [ ] **Step 1: `package.json`**

```json
{
  "name": "@dam/adapters-ndi",
  "version": "0.0.0",
  "private": true,
  "type": "module",
  "exports": {
    ".": "./src/index.ts"
  },
  "scripts": {
    "typecheck": "tsc --noEmit",
    "import:watersheds": "bun run src/cli.ts watersheds",
    "import:dams": "bun run src/cli.ts dams"
  },
  "dependencies": {
    "@dam/core": "workspace:*",
    "@dam/db": "workspace:*"
  }
}
```

- [ ] **Step 2: `tsconfig.json`**

```json
{ "extends": "../../../tsconfig.base.json", "include": ["src/**/*"] }
```

- [ ] **Step 3: `types.ts`**

```ts
export interface ParsedWatershed {
  code: string;
  name: string;
  nameKana?: string | null;
  kind: 'first' | 'second' | 'other';
  geometry: GeoJSON.MultiPolygon | GeoJSON.Polygon;
  areaKm2?: number | null;
}

export interface ParsedDam {
  ndiId: string;                  // unique within NLNI
  name: string;
  prefCode: string;
  manager?: string | null;
  type?: string | null;
  heightM?: number | null;
  totalCapacityM3?: number | null;
  effectiveCapacityM3?: number | null;
  floodCapacityM3?: number | null;
  completedYear?: number | null;
  lat: number;
  lng: number;
  watershedCode?: string | null;
}
```

- [ ] **Step 4: Install + typecheck**
```bash
bun install
bun run --filter @dam/adapters-ndi typecheck
```

- [ ] **Step 5: Commit**
```bash
git add packages/adapters/ndi
git commit -m "feat(adapters/ndi): scaffold package"
```

---

## Task 18: NLNI W07 watershed parser (TDD)

**Files:**
- Create: `tests/fixtures/ndi/w07_sample.geojson`
- Create: `packages/adapters/ndi/src/parse_w07.ts`
- Test: `packages/adapters/ndi/src/parse_w07.test.ts`

- [ ] **Step 1: Fixture (minimal NLNI W07-style FeatureCollection)**

```json
{
  "type": "FeatureCollection",
  "features": [
    {
      "type": "Feature",
      "properties": { "W07_001": "01", "W07_002": "利根川水系", "W07_003": "1" },
      "geometry": {
        "type": "MultiPolygon",
        "coordinates": [
          [
            [
              [139.0, 35.0], [140.0, 35.0], [140.0, 36.0], [139.0, 36.0], [139.0, 35.0]
            ]
          ]
        ]
      }
    },
    {
      "type": "Feature",
      "properties": { "W07_001": "02", "W07_002": "荒川水系", "W07_003": "2" },
      "geometry": {
        "type": "Polygon",
        "coordinates": [[
          [138.0, 35.0], [139.0, 35.0], [139.0, 36.0], [138.0, 36.0], [138.0, 35.0]
        ]]
      }
    }
  ]
}
```

- [ ] **Step 2: Test**

```ts
// packages/adapters/ndi/src/parse_w07.test.ts
import { describe, expect, test } from 'bun:test';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { parseW07 } from './parse_w07.ts';

const FIXTURE = join(import.meta.dir, '..', '..', '..', '..', 'tests/fixtures/ndi/w07_sample.geojson');

describe('parseW07', () => {
  test('extracts code, name, kind, geometry', async () => {
    const raw = await readFile(FIXTURE, 'utf8');
    const out = parseW07(raw);
    expect(out.length).toBe(2);
    expect(out[0]).toMatchObject({ code: '01', name: '利根川水系', kind: 'first' });
    expect(out[0]?.geometry.type).toBe('MultiPolygon');
    expect(out[1]).toMatchObject({ code: '02', name: '荒川水系', kind: 'second' });
  });

  test('rejects malformed input', () => {
    expect(() => parseW07('{}')).toThrow();
  });
});
```

- [ ] **Step 3: Run (fail)**
```bash
bun test packages/adapters/ndi/src/parse_w07.test.ts
```

- [ ] **Step 4: Implement**

```ts
// packages/adapters/ndi/src/parse_w07.ts
import type { ParsedWatershed } from './types.ts';

interface W07Properties {
  W07_001?: string;
  W07_002?: string;
  W07_003?: string;          // "1"=first-class, "2"=second-class
}

interface W07Feature {
  type: 'Feature';
  properties: W07Properties;
  geometry: GeoJSON.Polygon | GeoJSON.MultiPolygon;
}

interface W07FeatureCollection {
  type: 'FeatureCollection';
  features: W07Feature[];
}

function isFC(v: unknown): v is W07FeatureCollection {
  return (
    typeof v === 'object' &&
    v !== null &&
    (v as { type?: string }).type === 'FeatureCollection' &&
    Array.isArray((v as { features?: unknown }).features)
  );
}

function kindFromCode(code: string | undefined): ParsedWatershed['kind'] {
  if (code === '1') return 'first';
  if (code === '2') return 'second';
  return 'other';
}

export function parseW07(rawJson: string): ParsedWatershed[] {
  const data: unknown = JSON.parse(rawJson);
  if (!isFC(data)) throw new Error('W07: not a FeatureCollection');
  const out: ParsedWatershed[] = [];
  for (const f of data.features) {
    const code = f.properties.W07_001;
    const name = f.properties.W07_002;
    if (!code || !name) continue;
    out.push({
      code,
      name,
      kind: kindFromCode(f.properties.W07_003),
      geometry: f.geometry,
    });
  }
  return out;
}
```

- [ ] **Step 5: Run (pass)**
```bash
bun test packages/adapters/ndi/src/parse_w07.test.ts
```

- [ ] **Step 6: Commit**
```bash
git add tests/fixtures/ndi/w07_sample.geojson packages/adapters/ndi/src/parse_w07.ts packages/adapters/ndi/src/parse_w07.test.ts
git commit -m "feat(adapters/ndi): parse W07 watershed boundaries"
```

---

## Task 19: NLNI W07 watershed importer (integration TDD)

**Files:**
- Create: `packages/adapters/ndi/src/import_watersheds.ts`
- Test: `packages/adapters/ndi/src/import_watersheds.test.ts`

- [ ] **Step 1: Test**

```ts
import { describe, expect, test, afterAll } from 'bun:test';
import { sql } from '@dam/db/client';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { parseW07 } from './parse_w07.ts';
import { importWatersheds } from './import_watersheds.ts';

const FIXTURE = join(import.meta.dir, '..', '..', '..', '..', 'tests/fixtures/ndi/w07_sample.geojson');

afterAll(async () => {
  await sql`DELETE FROM watersheds WHERE code IN ('01','02')`;
});

describe('importWatersheds', () => {
  test('upserts parsed watersheds and assigns slugs', async () => {
    const raw = await readFile(FIXTURE, 'utf8');
    const parsed = parseW07(raw);
    const result = await importWatersheds(parsed);
    expect(result.upserted).toBe(2);
    const rows = await sql<{ code: string; slug: string }[]>`
      SELECT code, slug FROM watersheds WHERE code IN ('01','02') ORDER BY code
    `;
    expect(rows.map((r) => r.code)).toEqual(['01', '02']);
    expect(rows[0]?.slug).not.toBe('');
  });

  test('idempotent re-import', async () => {
    const raw = await readFile(FIXTURE, 'utf8');
    const parsed = parseW07(raw);
    const r1 = await importWatersheds(parsed);
    const r2 = await importWatersheds(parsed);
    expect(r1.upserted).toBe(2);
    expect(r2.upserted).toBe(2);
  });
});
```

- [ ] **Step 2: Run (fail)**
```bash
bun test packages/adapters/ndi/src/import_watersheds.test.ts
```

- [ ] **Step 3: Implement**

```ts
// packages/adapters/ndi/src/import_watersheds.ts
import { upsertWatershed } from '@dam/db/repo/watersheds';
import { suffixedSlug, toSlug } from '@dam/core/slug';
import { sql } from '@dam/db/client';
import type { ParsedWatershed } from './types.ts';

export interface ImportResult {
  upserted: number;
}

export async function importWatersheds(parsed: ParsedWatershed[]): Promise<ImportResult> {
  const taken = new Set(
    (await sql<{ slug: string }[]>`SELECT slug FROM watersheds`).map((r) => r.slug),
  );

  let count = 0;
  for (const w of parsed) {
    const base = toSlug(w.name) || `watershed-${w.code}`;
    const slug = suffixedSlug(base, taken);
    taken.add(slug);

    const geometry: GeoJSON.MultiPolygon =
      w.geometry.type === 'MultiPolygon'
        ? w.geometry
        : { type: 'MultiPolygon', coordinates: [w.geometry.coordinates] };

    await upsertWatershed({
      code: w.code,
      slug,
      name: w.name,
      nameKana: w.nameKana ?? null,
      kind: w.kind,
      boundaryGeoJSON: geometry,
      areaKm2: w.areaKm2 ?? null,
    });
    count++;
  }
  return { upserted: count };
}
```

- [ ] **Step 4: Run (pass)**
```bash
bun test packages/adapters/ndi/src/import_watersheds.test.ts
```

- [ ] **Step 5: Commit**
```bash
git add packages/adapters/ndi/src/import_watersheds.ts packages/adapters/ndi/src/import_watersheds.test.ts
git commit -m "feat(adapters/ndi): importer for W07 watersheds"
```

---

## Task 20: NLNI W01 dam parser (TDD)

**Files:**
- Create: `tests/fixtures/ndi/w01_sample.geojson`
- Create: `packages/adapters/ndi/src/parse_w01.ts`
- Test: `packages/adapters/ndi/src/parse_w01.test.ts`

- [ ] **Step 1: Fixture**

```json
{
  "type": "FeatureCollection",
  "features": [
    {
      "type": "Feature",
      "properties": {
        "W01_001": "1234567890",
        "W01_002": "八ッ場ダム",
        "W01_003": "10",
        "W01_004": "国土交通省関東地方整備局",
        "W01_005": "重力式コンクリート",
        "W01_006": "116.0",
        "W01_007": "107500000",
        "W01_008": "90000000",
        "W01_009": "65000000",
        "W01_010": "2020",
        "W01_021": "01"
      },
      "geometry": { "type": "Point", "coordinates": [138.69, 36.55] }
    },
    {
      "type": "Feature",
      "properties": {
        "W01_001": "9999999999",
        "W01_002": "テストダム",
        "W01_003": "13",
        "W01_004": "東京都",
        "W01_005": "ロックフィル",
        "W01_006": "60.0",
        "W01_007": "1000000",
        "W01_008": "800000",
        "W01_009": "200000",
        "W01_010": "1990",
        "W01_021": "02"
      },
      "geometry": { "type": "Point", "coordinates": [139.5, 35.7] }
    }
  ]
}
```

- [ ] **Step 2: Test**

```ts
// packages/adapters/ndi/src/parse_w01.test.ts
import { describe, expect, test } from 'bun:test';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { parseW01 } from './parse_w01.ts';

const FIXTURE = join(import.meta.dir, '..', '..', '..', '..', 'tests/fixtures/ndi/w01_sample.geojson');

describe('parseW01', () => {
  test('extracts dam metadata and coordinates', async () => {
    const raw = await readFile(FIXTURE, 'utf8');
    const out = parseW01(raw);
    expect(out.length).toBe(2);
    expect(out[0]).toMatchObject({
      ndiId: '1234567890',
      name: '八ッ場ダム',
      prefCode: '10',
      manager: '国土交通省関東地方整備局',
      type: '重力式コンクリート',
      heightM: 116.0,
      totalCapacityM3: 107500000,
      effectiveCapacityM3: 90000000,
      floodCapacityM3: 65000000,
      completedYear: 2020,
      watershedCode: '01',
      lat: 36.55,
      lng: 138.69,
    });
  });

  test('handles missing optional fields', () => {
    const raw = JSON.stringify({
      type: 'FeatureCollection',
      features: [{
        type: 'Feature',
        properties: { W01_001: 'x', W01_002: 'X', W01_003: '01' },
        geometry: { type: 'Point', coordinates: [140, 36] },
      }],
    });
    const out = parseW01(raw);
    expect(out[0]?.heightM).toBeNull();
  });

  test('skips features without coordinates', () => {
    const raw = JSON.stringify({
      type: 'FeatureCollection',
      features: [{
        type: 'Feature',
        properties: { W01_001: 'x', W01_002: 'X', W01_003: '01' },
        geometry: { type: 'Point', coordinates: [] },
      }],
    });
    expect(parseW01(raw).length).toBe(0);
  });
});
```

- [ ] **Step 3: Run (fail)**
```bash
bun test packages/adapters/ndi/src/parse_w01.test.ts
```

- [ ] **Step 4: Implement**

```ts
// packages/adapters/ndi/src/parse_w01.ts
import type { ParsedDam } from './types.ts';

interface W01Properties {
  W01_001?: string;       // unique id
  W01_002?: string;       // name
  W01_003?: string;       // pref code
  W01_004?: string;       // manager
  W01_005?: string;       // type
  W01_006?: string;       // height m
  W01_007?: string;       // total capacity m3
  W01_008?: string;       // effective capacity
  W01_009?: string;       // flood capacity
  W01_010?: string;       // completed year
  W01_021?: string;       // watershed code
}

interface Feature {
  type: 'Feature';
  properties: W01Properties;
  geometry: { type: 'Point'; coordinates: number[] };
}

interface FC { type: 'FeatureCollection'; features: Feature[] }

function isFC(v: unknown): v is FC {
  return (
    typeof v === 'object' && v !== null &&
    (v as { type?: string }).type === 'FeatureCollection' &&
    Array.isArray((v as { features?: unknown }).features)
  );
}

function num(s: string | undefined): number | null {
  if (s === undefined || s === '') return null;
  const n = Number(s);
  return Number.isFinite(n) ? n : null;
}

function intish(s: string | undefined): number | null {
  const n = num(s);
  return n === null ? null : Math.trunc(n);
}

export function parseW01(rawJson: string): ParsedDam[] {
  const data: unknown = JSON.parse(rawJson);
  if (!isFC(data)) throw new Error('W01: not a FeatureCollection');
  const out: ParsedDam[] = [];
  for (const f of data.features) {
    const id = f.properties.W01_001;
    const name = f.properties.W01_002;
    const pref = f.properties.W01_003;
    if (!id || !name || !pref) continue;
    const coords = f.geometry?.coordinates;
    if (!Array.isArray(coords) || coords.length < 2) continue;
    const lng = coords[0];
    const lat = coords[1];
    if (typeof lng !== 'number' || typeof lat !== 'number') continue;
    out.push({
      ndiId: id,
      name,
      prefCode: pref.padStart(2, '0'),
      manager: f.properties.W01_004 ?? null,
      type: f.properties.W01_005 ?? null,
      heightM: num(f.properties.W01_006),
      totalCapacityM3: num(f.properties.W01_007),
      effectiveCapacityM3: num(f.properties.W01_008),
      floodCapacityM3: num(f.properties.W01_009),
      completedYear: intish(f.properties.W01_010),
      watershedCode: f.properties.W01_021 ?? null,
      lat,
      lng,
    });
  }
  return out;
}
```

- [ ] **Step 5: Run (pass)**
```bash
bun test packages/adapters/ndi/src/parse_w01.test.ts
```

- [ ] **Step 6: Commit**
```bash
git add tests/fixtures/ndi/w01_sample.geojson packages/adapters/ndi/src/parse_w01.ts packages/adapters/ndi/src/parse_w01.test.ts
git commit -m "feat(adapters/ndi): parse W01 dam features"
```

---

## Task 21: NLNI W01 dam importer (integration TDD)

**Files:**
- Create: `packages/adapters/ndi/src/import_dams.ts`
- Test: `packages/adapters/ndi/src/import_dams.test.ts`

- [ ] **Step 1: Test**

```ts
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { sql } from '@dam/db/client';
import { parseW01 } from './parse_w01.ts';
import { parseW07 } from './parse_w07.ts';
import { importDams } from './import_dams.ts';
import { importWatersheds } from './import_watersheds.ts';

const W01 = join(import.meta.dir, '..', '..', '..', '..', 'tests/fixtures/ndi/w01_sample.geojson');
const W07 = join(import.meta.dir, '..', '..', '..', '..', 'tests/fixtures/ndi/w07_sample.geojson');

beforeAll(async () => {
  const raw07 = await readFile(W07, 'utf8');
  await importWatersheds(parseW07(raw07));
});

afterAll(async () => {
  await sql`DELETE FROM dams WHERE external_ids ? 'ndi'`;
  await sql`DELETE FROM watersheds WHERE code IN ('01','02')`;
});

describe('importDams', () => {
  test('inserts dams and links watershed by code', async () => {
    const raw = await readFile(W01, 'utf8');
    const parsed = parseW01(raw);
    const result = await importDams(parsed);
    expect(result.upserted).toBe(2);
    const rows = await sql<{
      slug: string; pref_code: string; watershed_id: bigint | null;
    }[]>`
      SELECT slug, pref_code, watershed_id FROM dams
      WHERE external_ids ->> 'ndi' IN ('1234567890','9999999999')
      ORDER BY slug
    `;
    expect(rows.length).toBe(2);
    expect(rows[0]?.watershed_id).not.toBeNull();
  });

  test('idempotent', async () => {
    const raw = await readFile(W01, 'utf8');
    const parsed = parseW01(raw);
    await importDams(parsed);
    const r2 = await importDams(parsed);
    expect(r2.upserted).toBe(2);
  });
});
```

- [ ] **Step 2: Run (fail)**
```bash
bun test packages/adapters/ndi/src/import_dams.test.ts
```

- [ ] **Step 3: Implement**

```ts
// packages/adapters/ndi/src/import_dams.ts
import { suffixedSlug, toSlug } from '@dam/core/slug';
import { sql } from '@dam/db/client';
import { takenSlugs, upsertDamByExternalId } from '@dam/db/repo/dams';
import type { ParsedDam } from './types.ts';

export interface ImportResult {
  upserted: number;
}

async function watershedIdByCode(code: string): Promise<bigint | null> {
  const rows = await sql<{ id: bigint }[]>`SELECT id FROM watersheds WHERE code = ${code}`;
  return rows[0]?.id ?? null;
}

export async function importDams(parsed: ParsedDam[]): Promise<ImportResult> {
  const taken = await takenSlugs('');
  let count = 0;

  for (const d of parsed) {
    const base = toSlug(d.name) || `dam-${d.ndiId}`;
    const candidate = `${base}-${d.prefCode}`;
    const slug = suffixedSlug(candidate, taken);
    taken.add(slug);

    const watershedId = d.watershedCode ? await watershedIdByCode(d.watershedCode) : null;

    await upsertDamByExternalId('ndi', {
      slug,
      name: d.name,
      prefCode: d.prefCode,
      watershedId,
      manager: d.manager ?? null,
      type: d.type ?? null,
      heightM: d.heightM,
      totalCapacityM3: d.totalCapacityM3,
      effectiveCapacityM3: d.effectiveCapacityM3,
      floodCapacityM3: d.floodCapacityM3,
      completedYear: d.completedYear,
      lat: d.lat,
      lng: d.lng,
      externalIds: { ndi: d.ndiId },
    });
    count++;
  }

  return { upserted: count };
}
```

- [ ] **Step 4: Run (pass)**
```bash
bun test packages/adapters/ndi/src/import_dams.test.ts
```

- [ ] **Step 5: Commit**
```bash
git add packages/adapters/ndi/src/import_dams.ts packages/adapters/ndi/src/import_dams.test.ts
git commit -m "feat(adapters/ndi): importer for W01 dams"
```

---

## Task 22: NDI fetcher and CLI

**Files:**
- Create: `packages/adapters/ndi/src/fetcher.ts`
- Create: `packages/adapters/ndi/src/cli.ts`
- Create: `packages/adapters/ndi/src/index.ts`

- [ ] **Step 1: Fetcher (downloads ZIP from NLNI URL or reads a local file)**

```ts
// packages/adapters/ndi/src/fetcher.ts
import { readFile } from 'node:fs/promises';
import { HttpClient } from '@dam/core/http_client';

export async function loadGeoJson(source: string): Promise<string> {
  if (source.startsWith('http://') || source.startsWith('https://')) {
    const c = new HttpClient({
      userAgent: 'DamDataPlatform/0.1 (+https://example.com/bot; matsubokkuri@gmail.com)',
      minIntervalMs: 1000,
      maxRetries: 3,
      timeoutMs: 60_000,
    });
    const r = await c.get(source);
    if (r.status !== 200) throw new Error(`HTTP ${r.status} from ${source}`);
    return r.bodyText;
  }
  return readFile(source, 'utf8');
}
```

- [ ] **Step 2: CLI**

```ts
// packages/adapters/ndi/src/cli.ts
import { parseArgs } from 'node:util';
import { loadGeoJson } from './fetcher.ts';
import { parseW01 } from './parse_w01.ts';
import { parseW07 } from './parse_w07.ts';
import { importDams } from './import_dams.ts';
import { importWatersheds } from './import_watersheds.ts';

async function main(): Promise<void> {
  const sub = process.argv[2];
  const argv = process.argv.slice(3);
  const { values } = parseArgs({
    args: argv,
    options: { source: { type: 'string' } },
  });
  if (!values.source) {
    console.error('Missing --source <url-or-path>');
    process.exit(2);
  }
  const raw = await loadGeoJson(values.source);

  if (sub === 'watersheds') {
    const parsed = parseW07(raw);
    const r = await importWatersheds(parsed);
    console.log(`watersheds upserted: ${r.upserted}`);
    return;
  }
  if (sub === 'dams') {
    const parsed = parseW01(raw);
    const r = await importDams(parsed);
    console.log(`dams upserted: ${r.upserted}`);
    return;
  }
  console.error(`Unknown subcommand: ${sub}`);
  process.exit(2);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
```

- [ ] **Step 3: `index.ts`**

```ts
export { parseW01 } from './parse_w01.ts';
export { parseW07 } from './parse_w07.ts';
export { importDams } from './import_dams.ts';
export { importWatersheds } from './import_watersheds.ts';
export { loadGeoJson } from './fetcher.ts';
```

- [ ] **Step 4: Smoke run with fixtures**
```bash
just import-ndi-watersheds -- --source tests/fixtures/ndi/w07_sample.geojson
just import-ndi-dams       -- --source tests/fixtures/ndi/w01_sample.geojson
```

Expected:
```
watersheds upserted: 2
dams upserted: 2
```

- [ ] **Step 5: Commit**
```bash
git add packages/adapters/ndi/src/fetcher.ts packages/adapters/ndi/src/cli.ts packages/adapters/ndi/src/index.ts
git commit -m "feat(adapters/ndi): fetcher and import CLI"
```

---

## Task 23: Damnet adapter package skeleton

**Files:**
- Create: `packages/adapters/damnet/package.json`
- Create: `packages/adapters/damnet/tsconfig.json`
- Create: `packages/adapters/damnet/src/types.ts`

- [ ] **Step 1: `package.json`**

```json
{
  "name": "@dam/adapters-damnet",
  "version": "0.0.0",
  "private": true,
  "type": "module",
  "exports": { ".": "./src/index.ts" },
  "scripts": {
    "typecheck": "tsc --noEmit",
    "import": "bun run src/cli.ts"
  },
  "dependencies": {
    "@dam/core": "workspace:*",
    "@dam/db": "workspace:*",
    "@dam/reconciler": "workspace:*",
    "cheerio": "^1.0.0"
  }
}
```

- [ ] **Step 2: `tsconfig.json`**
```json
{ "extends": "../../../tsconfig.base.json", "include": ["src/**/*"] }
```

- [ ] **Step 3: `types.ts`**

```ts
export interface DamnetListItem {
  damnetId: string;
  name: string;
  prefCode: string;
  detailUrl: string;
}

export interface DamnetDetail {
  damnetId: string;
  name: string;
  nameKana?: string | null;
  prefCode: string;
  manager?: string | null;
  type?: string | null;
  heightM?: number | null;
  totalCapacityM3?: number | null;
  effectiveCapacityM3?: number | null;
  floodCapacityM3?: number | null;
  completedYear?: number | null;
  lat?: number | null;
  lng?: number | null;
}
```

- [ ] **Step 4: install + commit**
```bash
bun install
git add packages/adapters/damnet
git commit -m "feat(adapters/damnet): scaffold package"
```

---

## Task 24: Damnet list-page parser (TDD)

**Files:**
- Create: `tests/fixtures/damnet/list.html`
- Create: `packages/adapters/damnet/src/list_scraper.ts`
- Test: `packages/adapters/damnet/src/list_scraper.test.ts`

- [ ] **Step 1: Fixture HTML (representative subset of damnet structure)**

```html
<!doctype html>
<html><body>
<table class="dam-list">
  <tr><th>都道府県</th><th>ダム名</th></tr>
  <tr>
    <td>群馬県</td>
    <td><a href="/cgi-bin/binranA/All.cgi?db4=1234">八ッ場ダム</a></td>
  </tr>
  <tr>
    <td>東京都</td>
    <td><a href="/cgi-bin/binranA/All.cgi?db4=9999">テストダム</a></td>
  </tr>
</table>
</body></html>
```

- [ ] **Step 2: Test**

```ts
import { describe, expect, test } from 'bun:test';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { parseDamnetList } from './list_scraper.ts';

const FIXTURE = join(import.meta.dir, '..', '..', '..', '..', 'tests/fixtures/damnet/list.html');

describe('parseDamnetList', () => {
  test('extracts list items with id, name, pref, detail url', async () => {
    const html = await readFile(FIXTURE, 'utf8');
    const items = parseDamnetList(html, 'http://damnet.or.jp');
    expect(items.length).toBe(2);
    expect(items[0]).toEqual({
      damnetId: '1234',
      name: '八ッ場ダム',
      prefCode: '10',
      detailUrl: 'http://damnet.or.jp/cgi-bin/binranA/All.cgi?db4=1234',
    });
    expect(items[1]?.prefCode).toBe('13');
  });
});
```

- [ ] **Step 3: Run (fail)**
```bash
bun test packages/adapters/damnet/src/list_scraper.test.ts
```

- [ ] **Step 4: Implement**

```ts
// packages/adapters/damnet/src/list_scraper.ts
import * as cheerio from 'cheerio';
import type { DamnetListItem } from './types.ts';

const PREF_NAME_TO_CODE: Record<string, string> = {
  北海道: '01', 青森県: '02', 岩手県: '03', 宮城県: '04', 秋田県: '05',
  山形県: '06', 福島県: '07', 茨城県: '08', 栃木県: '09', 群馬県: '10',
  埼玉県: '11', 千葉県: '12', 東京都: '13', 神奈川県: '14', 新潟県: '15',
  富山県: '16', 石川県: '17', 福井県: '18', 山梨県: '19', 長野県: '20',
  岐阜県: '21', 静岡県: '22', 愛知県: '23', 三重県: '24', 滋賀県: '25',
  京都府: '26', 大阪府: '27', 兵庫県: '28', 奈良県: '29', 和歌山県: '30',
  鳥取県: '31', 島根県: '32', 岡山県: '33', 広島県: '34', 山口県: '35',
  徳島県: '36', 香川県: '37', 愛媛県: '38', 高知県: '39', 福岡県: '40',
  佐賀県: '41', 長崎県: '42', 熊本県: '43', 大分県: '44', 宮崎県: '45',
  鹿児島県: '46', 沖縄県: '47',
};

export function prefNameToCode(name: string): string {
  const code = PREF_NAME_TO_CODE[name];
  if (!code) throw new Error(`Unknown prefecture name: ${name}`);
  return code;
}

export function parseDamnetList(html: string, baseUrl: string): DamnetListItem[] {
  const $ = cheerio.load(html);
  const items: DamnetListItem[] = [];
  $('table.dam-list tr').each((_, row) => {
    const cells = $(row).find('td');
    if (cells.length < 2) return;
    const prefName = $(cells[0]).text().trim();
    const a = $(cells[1]).find('a').first();
    const href = a.attr('href');
    const name = a.text().trim();
    if (!href || !name || !prefName) return;
    const m = href.match(/db4=(\d+)/);
    if (!m) return;
    items.push({
      damnetId: m[1] ?? '',
      name,
      prefCode: prefNameToCode(prefName),
      detailUrl: new URL(href, baseUrl).toString(),
    });
  });
  return items;
}
```

- [ ] **Step 5: Run (pass)**
```bash
bun test packages/adapters/damnet/src/list_scraper.test.ts
```

- [ ] **Step 6: Commit**
```bash
git add tests/fixtures/damnet/list.html packages/adapters/damnet/src
git commit -m "feat(adapters/damnet): list-page parser"
```

---

## Task 25: Damnet detail-page parser (TDD)

**Files:**
- Create: `tests/fixtures/damnet/detail_yamba.html`
- Create: `packages/adapters/damnet/src/detail_parser.ts`
- Test: `packages/adapters/damnet/src/detail_parser.test.ts`

- [ ] **Step 1: Fixture (table-based detail page)**

```html
<!doctype html>
<html><body>
<table class="dam-attr">
  <tr><th>ダム名</th><td>八ッ場ダム</td></tr>
  <tr><th>ふりがな</th><td>やんばだむ</td></tr>
  <tr><th>都道府県</th><td>群馬県</td></tr>
  <tr><th>管理者</th><td>国土交通省関東地方整備局</td></tr>
  <tr><th>型式</th><td>重力式コンクリート</td></tr>
  <tr><th>堤高</th><td>116.0 m</td></tr>
  <tr><th>総貯水容量</th><td>107,500,000 m³</td></tr>
  <tr><th>有効貯水容量</th><td>90,000,000 m³</td></tr>
  <tr><th>洪水調節容量</th><td>65,000,000 m³</td></tr>
  <tr><th>竣工</th><td>2020 年</td></tr>
  <tr><th>位置</th><td>北緯 36.55 度 / 東経 138.69 度</td></tr>
</table>
</body></html>
```

- [ ] **Step 2: Test**

```ts
import { describe, expect, test } from 'bun:test';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { parseDamnetDetail } from './detail_parser.ts';

const FIXTURE = join(import.meta.dir, '..', '..', '..', '..', 'tests/fixtures/damnet/detail_yamba.html');

describe('parseDamnetDetail', () => {
  test('extracts metadata from attribute table', async () => {
    const html = await readFile(FIXTURE, 'utf8');
    const out = parseDamnetDetail(html, '1234');
    expect(out).toMatchObject({
      damnetId: '1234',
      name: '八ッ場ダム',
      nameKana: 'やんばだむ',
      prefCode: '10',
      manager: '国土交通省関東地方整備局',
      type: '重力式コンクリート',
      heightM: 116.0,
      totalCapacityM3: 107500000,
      effectiveCapacityM3: 90000000,
      floodCapacityM3: 65000000,
      completedYear: 2020,
      lat: 36.55,
      lng: 138.69,
    });
  });
});
```

- [ ] **Step 3: Run (fail)**

- [ ] **Step 4: Implement**

```ts
// packages/adapters/damnet/src/detail_parser.ts
import * as cheerio from 'cheerio';
import { prefNameToCode } from './list_scraper.ts';
import type { DamnetDetail } from './types.ts';

function num(text: string | undefined): number | null {
  if (!text) return null;
  const cleaned = text.replace(/[, m³年度]/g, '').trim();
  const n = Number(cleaned);
  return Number.isFinite(n) ? n : null;
}

function intish(text: string | undefined): number | null {
  const n = num(text);
  return n === null ? null : Math.trunc(n);
}

function parseLatLng(text: string | undefined): { lat: number | null; lng: number | null } {
  if (!text) return { lat: null, lng: null };
  const m = text.match(/北緯\s*([\d.]+)\s*度.*東経\s*([\d.]+)\s*度/);
  if (!m) return { lat: null, lng: null };
  return { lat: Number(m[1]), lng: Number(m[2]) };
}

export function parseDamnetDetail(html: string, damnetId: string): DamnetDetail {
  const $ = cheerio.load(html);
  const fields: Record<string, string> = {};
  $('table.dam-attr tr').each((_, row) => {
    const th = $(row).find('th').text().trim();
    const td = $(row).find('td').text().trim();
    if (th) fields[th] = td;
  });

  const prefName = fields['都道府県'];
  if (!prefName) throw new Error(`damnet detail missing pref for ${damnetId}`);
  const name = fields['ダム名'];
  if (!name) throw new Error(`damnet detail missing name for ${damnetId}`);

  const { lat, lng } = parseLatLng(fields['位置']);

  return {
    damnetId,
    name,
    nameKana: fields['ふりがな'] ?? null,
    prefCode: prefNameToCode(prefName),
    manager: fields['管理者'] ?? null,
    type: fields['型式'] ?? null,
    heightM: num(fields['堤高']),
    totalCapacityM3: num(fields['総貯水容量']),
    effectiveCapacityM3: num(fields['有効貯水容量']),
    floodCapacityM3: num(fields['洪水調節容量']),
    completedYear: intish(fields['竣工']),
    lat,
    lng,
  };
}
```

- [ ] **Step 5: Run (pass)**

- [ ] **Step 6: Commit**
```bash
git add tests/fixtures/damnet/detail_yamba.html packages/adapters/damnet/src/detail_parser.ts packages/adapters/damnet/src/detail_parser.test.ts
git commit -m "feat(adapters/damnet): detail-page parser"
```

---

## Task 26: Reconciler package (TDD)

**Files:**
- Create: `packages/reconciler/package.json`
- Create: `packages/reconciler/tsconfig.json`
- Create: `packages/reconciler/src/score.ts`
- Test: `packages/reconciler/src/score.test.ts`
- Create: `packages/reconciler/src/match.ts`
- Test: `packages/reconciler/src/match.test.ts`
- Create: `packages/reconciler/src/index.ts`

- [ ] **Step 1: `package.json` & `tsconfig.json`**

```json
{
  "name": "@dam/reconciler",
  "version": "0.0.0",
  "private": true,
  "type": "module",
  "exports": { ".": "./src/index.ts" },
  "scripts": { "typecheck": "tsc --noEmit", "run": "bun run src/cli.ts" },
  "dependencies": {
    "@dam/core": "workspace:*",
    "@dam/db": "workspace:*"
  }
}
```

```json
{ "extends": "../../tsconfig.base.json", "include": ["src/**/*"] }
```

- [ ] **Step 2: Score test**

```ts
// packages/reconciler/src/score.test.ts
import { describe, expect, test } from 'bun:test';
import { scoreCandidate } from './score.ts';

describe('scoreCandidate', () => {
  test('weights name 0.5, location 0.4, manager 0.1', () => {
    const s = scoreCandidate({
      nameSim: 1,
      distanceM: 0,
      managerMatch: true,
    });
    expect(s).toBeCloseTo(1.0, 5);
  });

  test('zero everywhere is zero', () => {
    expect(scoreCandidate({ nameSim: 0, distanceM: 1_000_000, managerMatch: false })).toBe(0);
  });

  test('partial', () => {
    const s = scoreCandidate({ nameSim: 0.8, distanceM: 250, managerMatch: false });
    // name: 0.8*0.5 = 0.4
    // location: max(0, 1 - 250/500) * 0.4 = 0.5 * 0.4 = 0.2
    // manager: 0
    expect(s).toBeCloseTo(0.6, 5);
  });
});
```

- [ ] **Step 3: Score impl**

```ts
// packages/reconciler/src/score.ts
const MAX_DISTANCE_M = 500;

export interface ScoreInput {
  nameSim: number;       // 0..1
  distanceM: number;     // metres
  managerMatch: boolean;
}

export function scoreCandidate(input: ScoreInput): number {
  const nameTerm = Math.max(0, Math.min(1, input.nameSim)) * 0.5;
  const distNorm = Math.max(0, 1 - input.distanceM / MAX_DISTANCE_M);
  const distTerm = distNorm * 0.4;
  const mgrTerm = input.managerMatch ? 0.1 : 0;
  return Number((nameTerm + distTerm + mgrTerm).toFixed(6));
}
```

- [ ] **Step 4: Run score test (pass)**
```bash
bun test packages/reconciler/src/score.test.ts
```

- [ ] **Step 5: Match impl + integration test**

```ts
// packages/reconciler/src/match.ts
import { findDamsForReconciliation } from '@dam/db/repo/dams';
import { normalizeJaName, trigramSimilarity } from '@dam/core/similarity';
import { scoreCandidate } from './score.ts';

export interface IncomingRecord {
  name: string;
  prefCode: string;
  manager?: string | null;
  lat?: number | null;
  lng?: number | null;
}

export interface MatchResult {
  bestDamId: bigint | null;
  confidence: number;
  candidateDamIds: bigint[];
}

export async function matchDam(record: IncomingRecord): Promise<MatchResult> {
  const candidates = await findDamsForReconciliation({
    pref: record.prefCode,
    centerLat: record.lat ?? undefined,
    centerLng: record.lng ?? undefined,
    radiusM: record.lat != null && record.lng != null ? 5_000 : undefined,
    limit: 50,
  });

  const normIncoming = normalizeJaName(record.name);
  let best: { id: bigint; score: number } | null = null;
  const candidateIds: bigint[] = [];

  for (const c of candidates) {
    const nameSim = trigramSimilarity(normIncoming, normalizeJaName(c.name));
    const distanceM =
      record.lat != null && record.lng != null
        ? haversineM(record.lat, record.lng, /* placeholder: candidate has no lat in row */ record.lat, record.lng)
        : Number.POSITIVE_INFINITY;
    const score = scoreCandidate({
      nameSim,
      distanceM,
      managerMatch: !!record.manager && record.manager === c.manager,
    });
    candidateIds.push(c.id);
    if (!best || score > best.score) best = { id: c.id, score };
  }

  if (!best) return { bestDamId: null, confidence: 0, candidateDamIds: [] };
  return {
    bestDamId: best.score >= 0.6 ? best.id : null,
    confidence: best.score,
    candidateDamIds: candidateIds,
  };
}

function haversineM(lat1: number, lng1: number, lat2: number, lng2: number): number {
  const R = 6_371_008.8;
  const toRad = (d: number) => (d * Math.PI) / 180;
  const dLat = toRad(lat2 - lat1);
  const dLng = toRad(lng2 - lng1);
  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(a));
}
```

Note: `findDamsForReconciliation` does not currently return candidate
coordinates. Update `packages/db/src/repo/dams.ts` so `DamRow` includes
`lat: number; lng: number` and the SELECT returns
`ST_X(location::geometry) AS lng, ST_Y(location::geometry) AS lat`. Then
update the haversine call in `match.ts` to use `c.lat, c.lng` instead of
the placeholder.

- [ ] **Step 6: Update `findDamsForReconciliation` and `DamRow`**

In `packages/db/src/repo/dams.ts`, change:
- `DamRow` to:
  ```ts
  export interface DamRow {
    id: bigint;
    slug: string;
    name: string;
    prefCode: string;
    manager: string | null;
    watershedId: bigint | null;
    externalIds: Record<string, string>;
    lat: number;
    lng: number;
  }
  ```
- both SELECTs in `findDamsForReconciliation` to add
  `, ST_Y(location::geometry) AS lat, ST_X(location::geometry) AS lng`.

Then in `packages/reconciler/src/match.ts`, replace the haversine call with:

```ts
    const distanceM =
      record.lat != null && record.lng != null
        ? haversineM(record.lat, record.lng, c.lat, c.lng)
        : Number.POSITIVE_INFINITY;
```

- [ ] **Step 7: Match test**

```ts
// packages/reconciler/src/match.test.ts
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { sql } from '@dam/db/client';
import { upsertDamByExternalId } from '@dam/db/repo/dams';
import { matchDam } from './match.ts';

beforeAll(async () => {
  await upsertDamByExternalId('ndi', {
    slug: 'yanba-10',
    name: '八ッ場ダム',
    prefCode: '10',
    manager: '国土交通省関東地方整備局',
    lat: 36.55,
    lng: 138.69,
    externalIds: { ndi: 'TEST-RECON-1' },
  });
});

afterAll(async () => {
  await sql`DELETE FROM dams WHERE external_ids ->> 'ndi' = 'TEST-RECON-1'`;
});

describe('matchDam', () => {
  test('matches with high confidence on exact name + close location', async () => {
    const r = await matchDam({
      name: '八ッ場ダム',
      prefCode: '10',
      manager: '国土交通省関東地方整備局',
      lat: 36.5501,
      lng: 138.6901,
    });
    expect(r.bestDamId).not.toBeNull();
    expect(r.confidence).toBeGreaterThan(0.9);
  });

  test('returns null bestDamId when score is below threshold', async () => {
    const r = await matchDam({
      name: '全然違う名前',
      prefCode: '10',
      lat: 0,
      lng: 0,
    });
    expect(r.bestDamId).toBeNull();
  });
});
```

- [ ] **Step 8: `index.ts`**
```ts
export * from './match.ts';
export * from './score.ts';
```

- [ ] **Step 9: Run all reconciler tests**
```bash
bun test packages/reconciler
```

- [ ] **Step 10: Commit**
```bash
git add packages/reconciler packages/db/src/repo/dams.ts
git commit -m "feat(reconciler): score and match candidate dams"
```

---

## Task 27: Damnet importer (integration TDD)

**Files:**
- Create: `packages/adapters/damnet/src/importer.ts`
- Test: `packages/adapters/damnet/src/importer.test.ts`

- [ ] **Step 1: Test**

```ts
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { sql } from '@dam/db/client';
import { upsertDamByExternalId } from '@dam/db/repo/dams';
import { importDamnetDetail } from './importer.ts';

beforeAll(async () => {
  await upsertDamByExternalId('ndi', {
    slug: 'yanba-10',
    name: '八ッ場ダム',
    prefCode: '10',
    manager: '国土交通省関東地方整備局',
    lat: 36.55,
    lng: 138.69,
    externalIds: { ndi: 'TEST-DAMNET-1' },
  });
});

afterAll(async () => {
  await sql`DELETE FROM dams WHERE external_ids ->> 'ndi' = 'TEST-DAMNET-1'`;
  await sql`DELETE FROM match_review WHERE source_id = 'damnet'`;
});

describe('importDamnetDetail', () => {
  test('attaches damnet id and applies attributes when match high', async () => {
    const r = await importDamnetDetail({
      damnetId: '1234',
      name: '八ッ場ダム',
      nameKana: 'やんばだむ',
      prefCode: '10',
      manager: '国土交通省関東地方整備局',
      type: '重力式コンクリート',
      heightM: 116,
      totalCapacityM3: 107500000,
      effectiveCapacityM3: 90000000,
      floodCapacityM3: 65000000,
      completedYear: 2020,
      lat: 36.5501,
      lng: 138.6901,
    });
    expect(r.outcome).toBe('matched');
    const rows = await sql<{ external_ids: Record<string, string>; type: string | null }[]>`
      SELECT external_ids, type FROM dams WHERE external_ids ->> 'ndi' = 'TEST-DAMNET-1'
    `;
    expect(rows[0]?.external_ids.damnet).toBe('1234');
    expect(rows[0]?.type).toBe('重力式コンクリート');
  });

  test('enqueues match_review when no high-confidence candidate', async () => {
    const r = await importDamnetDetail({
      damnetId: '7777',
      name: 'ダミーダム',
      prefCode: '10',
      lat: 36.0,
      lng: 138.0,
    });
    expect(r.outcome).toBe('review_enqueued');
    const rows = await sql<{ source_external_id: string }[]>`
      SELECT source_external_id FROM match_review WHERE source_id = 'damnet'
    `;
    expect(rows.map((x) => x.source_external_id)).toContain('7777');
  });
});
```

- [ ] **Step 2: Implement**

```ts
// packages/adapters/damnet/src/importer.ts
import { matchDam } from '@dam/reconciler';
import { appendExternalId, applyDamnetAttributes } from '@dam/db/repo/dams';
import { enqueueMatchReview } from '@dam/db/repo/match_review';
import type { DamnetDetail } from './types.ts';

export interface ImportOutcome {
  outcome: 'matched' | 'review_enqueued' | 'no_candidate';
  damId: bigint | null;
  confidence: number;
}

export async function importDamnetDetail(detail: DamnetDetail): Promise<ImportOutcome> {
  const result = await matchDam({
    name: detail.name,
    prefCode: detail.prefCode,
    manager: detail.manager ?? null,
    lat: detail.lat ?? null,
    lng: detail.lng ?? null,
  });

  if (result.bestDamId !== null) {
    await appendExternalId(result.bestDamId, 'damnet', detail.damnetId);
    await applyDamnetAttributes(result.bestDamId, {
      nameKana: detail.nameKana ?? null,
      type: detail.type ?? null,
      heightM: detail.heightM ?? null,
      totalCapacityM3: detail.totalCapacityM3 ?? null,
      effectiveCapacityM3: detail.effectiveCapacityM3 ?? null,
      floodCapacityM3: detail.floodCapacityM3 ?? null,
      completedYear: detail.completedYear ?? null,
      manager: detail.manager ?? null,
    });
    return { outcome: 'matched', damId: result.bestDamId, confidence: result.confidence };
  }

  if (result.candidateDamIds.length > 0) {
    await enqueueMatchReview({
      sourceId: 'damnet',
      sourceExternalId: detail.damnetId,
      candidateDamIds: result.candidateDamIds,
      bestDamId: null,
      confidence: result.confidence,
      payload: detail as unknown as Record<string, unknown>,
    });
    return { outcome: 'review_enqueued', damId: null, confidence: result.confidence };
  }

  return { outcome: 'no_candidate', damId: null, confidence: 0 };
}
```

- [ ] **Step 3: Run (pass)**
```bash
bun test packages/adapters/damnet/src/importer.test.ts
```

- [ ] **Step 4: Commit**
```bash
git add packages/adapters/damnet/src/importer.ts packages/adapters/damnet/src/importer.test.ts
git commit -m "feat(adapters/damnet): importer with match-or-enqueue"
```

---

## Task 28: Damnet CLI

**Files:**
- Create: `packages/adapters/damnet/src/cli.ts`
- Create: `packages/adapters/damnet/src/index.ts`

- [ ] **Step 1: `cli.ts` (reads list HTML and detail HTMLs from a directory of fixtures, or scrapes URLs)**

```ts
// packages/adapters/damnet/src/cli.ts
import { readFile } from 'node:fs/promises';
import { parseArgs } from 'node:util';
import { HttpClient } from '@dam/core/http_client';
import { parseDamnetList } from './list_scraper.ts';
import { parseDamnetDetail } from './detail_parser.ts';
import { importDamnetDetail } from './importer.ts';

async function readSource(s: string): Promise<string> {
  if (s.startsWith('http://') || s.startsWith('https://')) {
    const c = new HttpClient({
      userAgent: 'DamDataPlatform/0.1 (+https://example.com/bot; matsubokkuri@gmail.com)',
      minIntervalMs: 2000,
      maxRetries: 3,
    });
    const r = await c.get(s);
    if (r.status !== 200) throw new Error(`HTTP ${r.status} from ${s}`);
    return r.bodyText;
  }
  return readFile(s, 'utf8');
}

async function main(): Promise<void> {
  const { values } = parseArgs({
    options: {
      list:    { type: 'string' },
      detail:  { type: 'string' },          // url or file for a single detail
      base:    { type: 'string', default: 'https://damnet.or.jp' },
      limit:   { type: 'string' },
    },
  });

  if (values.detail) {
    const html = await readSource(values.detail);
    const detail = parseDamnetDetail(html, /* damnetId derived from url */ extractDb4(values.detail) ?? 'unknown');
    const r = await importDamnetDetail(detail);
    console.log(JSON.stringify(r));
    return;
  }

  if (values.list) {
    const html = await readSource(values.list);
    const items = parseDamnetList(html, values.base ?? 'https://damnet.or.jp');
    const limit = values.limit ? Number(values.limit) : items.length;
    let matched = 0, review = 0, none = 0;
    for (const item of items.slice(0, limit)) {
      const detailHtml = await readSource(item.detailUrl);
      const detail = parseDamnetDetail(detailHtml, item.damnetId);
      const r = await importDamnetDetail(detail);
      if (r.outcome === 'matched') matched++;
      else if (r.outcome === 'review_enqueued') review++;
      else none++;
    }
    console.log(`matched=${matched} review=${review} none=${none}`);
    return;
  }

  console.error('Pass --list <url-or-file> or --detail <url-or-file>');
  process.exit(2);
}

function extractDb4(url: string): string | null {
  const m = url.match(/db4=(\d+)/);
  return m ? (m[1] ?? null) : null;
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
```

- [ ] **Step 2: `index.ts`**
```ts
export { parseDamnetList } from './list_scraper.ts';
export { parseDamnetDetail } from './detail_parser.ts';
export { importDamnetDetail } from './importer.ts';
```

- [ ] **Step 3: Smoke run with fixtures**
```bash
just import-damnet -- --list tests/fixtures/damnet/list.html --detail tests/fixtures/damnet/detail_yamba.html
```
This is a happy-path smoke test; for end-to-end, real URLs are exercised by
the cron job in Task 33.

- [ ] **Step 4: Commit**
```bash
git add packages/adapters/damnet/src/cli.ts packages/adapters/damnet/src/index.ts
git commit -m "feat(adapters/damnet): import CLI"
```

---

## Task 29: Next.js app skeleton

**Files:**
- Create: `apps/web/package.json`
- Create: `apps/web/next.config.ts`
- Create: `apps/web/tsconfig.json`
- Create: `apps/web/app/layout.tsx`
- Create: `apps/web/app/page.tsx`

- [ ] **Step 1: `package.json`**

```json
{
  "name": "@dam/web",
  "version": "0.0.0",
  "private": true,
  "scripts": {
    "dev": "next dev -p 3000",
    "build": "next build",
    "start": "next start -p 3000",
    "typecheck": "tsc --noEmit"
  },
  "dependencies": {
    "@dam/core": "workspace:*",
    "@dam/db": "workspace:*",
    "next": "^15.0.0",
    "react": "^19.0.0",
    "react-dom": "^19.0.0",
    "zod": "^3.23.0"
  },
  "devDependencies": {
    "@types/react": "^19.0.0",
    "@types/react-dom": "^19.0.0"
  }
}
```

- [ ] **Step 2: `next.config.ts`**

```ts
import type { NextConfig } from 'next';

const nextConfig: NextConfig = {
  experimental: { typedRoutes: true },
  serverExternalPackages: ['postgres'],
};

export default nextConfig;
```

- [ ] **Step 3: `tsconfig.json`**

```json
{
  "extends": "../../tsconfig.base.json",
  "compilerOptions": {
    "jsx": "preserve",
    "plugins": [{ "name": "next" }],
    "paths": { "@/*": ["./*"] },
    "incremental": true
  },
  "include": ["next-env.d.ts", "**/*.ts", "**/*.tsx", ".next/types/**/*.ts"],
  "exclude": ["node_modules"]
}
```

- [ ] **Step 4: `app/layout.tsx`**

```tsx
import type { ReactNode } from 'react';

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="ja">
      <body>{children}</body>
    </html>
  );
}
```

- [ ] **Step 5: `app/page.tsx`**

```tsx
export default function Home() {
  return (
    <main>
      <h1>Dam Data Platform</h1>
      <p>API: <code>/api/v1</code></p>
    </main>
  );
}
```

- [ ] **Step 6: Install + dev sanity check**

```bash
bun install
bun run --filter @dam/web typecheck
```

Expected: PASS.

- [ ] **Step 7: Commit**
```bash
git add apps/web
git commit -m "feat(web): scaffold Next.js app"
```

---

## Task 30: API helpers and `/api/v1/healthz`

**Files:**
- Create: `apps/web/lib/api/error.ts`
- Create: `apps/web/lib/api/response.ts`
- Create: `apps/web/app/api/v1/healthz/route.ts`

- [ ] **Step 1: `error.ts`**

```ts
// apps/web/lib/api/error.ts
import { NextResponse } from 'next/server';

export class HttpError extends Error {
  readonly status: number;
  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

export function asProblem(err: unknown): NextResponse {
  if (err instanceof HttpError) {
    return NextResponse.json(
      { type: 'about:blank', title: err.message, status: err.status },
      { status: err.status, headers: { 'content-type': 'application/problem+json' } },
    );
  }
  console.error(err);
  return NextResponse.json(
    { type: 'about:blank', title: 'Internal Server Error', status: 500 },
    { status: 500, headers: { 'content-type': 'application/problem+json' } },
  );
}
```

- [ ] **Step 2: `response.ts`**

```ts
// apps/web/lib/api/response.ts
import { NextResponse } from 'next/server';
import { buildLinks, type LinksInput } from '@dam/core/hateoas';

export function hal<T extends object>(body: T, links: LinksInput): NextResponse {
  return NextResponse.json(
    { ...body, _links: buildLinks(links) },
    { headers: { 'content-type': 'application/hal+json' } },
  );
}
```

- [ ] **Step 3: Healthz route + test**

```ts
// apps/web/app/api/v1/healthz/route.ts
import { sql } from '@dam/db/client';
import { hal } from '@/lib/api/response';

export const dynamic = 'force-dynamic';

export async function GET() {
  await sql`SELECT 1`;
  return hal({ status: 'ok' }, { self: { href: '/api/v1/healthz' } });
}
```

- [ ] **Step 4: Smoke test the route**
```bash
just up && just migrate
just dev-web &  # start in background
sleep 3
curl -fsS http://localhost:3000/api/v1/healthz | jq .
kill %1
```

Expected:
```json
{ "status": "ok", "_links": { "self": { "href": "/api/v1/healthz" } } }
```

- [ ] **Step 5: Commit**
```bash
git add apps/web/lib apps/web/app/api/v1/healthz
git commit -m "feat(web): /api/v1/healthz with hal+json"
```

---

## Task 31: `/api/v1/watershed` endpoint (TDD)

**Files:**
- Create: `apps/web/app/api/v1/watershed/route.ts`
- Test: `apps/web/app/api/v1/watershed/route.test.ts`

- [ ] **Step 1: Test (uses Next test harness via direct invocation)**

```ts
// apps/web/app/api/v1/watershed/route.test.ts
import { describe, expect, test, beforeAll, afterAll } from 'bun:test';
import { sql } from '@dam/db/client';
import { upsertWatershed } from '@dam/db/repo/watersheds';
import { GET } from './route.ts';

const SQUARE = {
  type: 'MultiPolygon',
  coordinates: [[
    [[139.0, 35.0], [140.0, 35.0], [140.0, 36.0], [139.0, 36.0], [139.0, 35.0]],
  ]],
};

beforeAll(async () => {
  await upsertWatershed({
    code: 'API-TEST-01',
    slug: 'api-test-tokyo',
    name: 'API Test Tokyo',
    kind: 'first',
    boundaryGeoJSON: SQUARE,
  });
});

afterAll(async () => {
  await sql`DELETE FROM watersheds WHERE code = 'API-TEST-01'`;
});

function makeReq(url: string): Request {
  return new Request(url);
}

describe('GET /api/v1/watershed', () => {
  test('returns 200 with watershed when point is inside', async () => {
    const res = await GET(makeReq('http://localhost/api/v1/watershed?lat=35.5&lng=139.5'));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.watershed.code).toBe('API-TEST-01');
    expect(body._links.self.href).toContain('lat=35.5');
    expect(body._links.watershed.href).toBe('/api/v1/watersheds/api-test-tokyo');
  });

  test('returns 404 with nearest link when point is outside', async () => {
    const res = await GET(makeReq('http://localhost/api/v1/watershed?lat=0&lng=0'));
    expect(res.status).toBe(404);
    const body = await res.json();
    expect(body._links.nearest?.href).toBeDefined();
  });

  test('returns 400 when params missing', async () => {
    const res = await GET(makeReq('http://localhost/api/v1/watershed?lat=0'));
    expect(res.status).toBe(400);
  });
});
```

- [ ] **Step 2: Run (fail)**
```bash
bun test apps/web/app/api/v1/watershed/route.test.ts
```

- [ ] **Step 3: Implement**

```ts
// apps/web/app/api/v1/watershed/route.ts
import { z } from 'zod';
import {
  findNearestWatershed,
  findWatershedContaining,
} from '@dam/db/repo/watersheds';
import { hal } from '@/lib/api/response';
import { asProblem, HttpError } from '@/lib/api/error';

export const dynamic = 'force-dynamic';

const Query = z.object({
  lat: z.coerce.number().gte(-90).lte(90),
  lng: z.coerce.number().gte(-180).lte(180),
});

export async function GET(req: Request): Promise<Response> {
  try {
    const url = new URL(req.url);
    const parsed = Query.safeParse({
      lat: url.searchParams.get('lat'),
      lng: url.searchParams.get('lng'),
    });
    if (!parsed.success) throw new HttpError(400, 'Invalid lat/lng');
    const { lat, lng } = parsed.data;

    const w = await findWatershedContaining(lat, lng);
    const selfHref = `/api/v1/watershed?lat=${lat}&lng=${lng}`;

    if (w) {
      return hal(
        {
          watershed: { code: w.code, slug: w.slug, name: w.name, kind: w.kind },
        },
        {
          self: { href: selfHref },
          watershed: { href: `/api/v1/watersheds/${w.slug}` },
          dams_in_watershed: { href: `/api/v1/watersheds/${w.slug}/dams` },
          web: { href: `/watersheds/${w.slug}` },
        },
      );
    }

    const nearest = await findNearestWatershed(lat, lng);
    return new Response(
      JSON.stringify({
        type: 'about:blank',
        title: 'No watershed contains the given coordinates',
        status: 404,
        _links: {
          self: { href: selfHref },
          nearest: nearest ? { href: `/api/v1/watersheds/${nearest.slug}` } : undefined,
        },
      }),
      { status: 404, headers: { 'content-type': 'application/problem+json' } },
    );
  } catch (err) {
    return asProblem(err);
  }
}
```

- [ ] **Step 4: Run (pass)**
```bash
bun test apps/web/app/api/v1/watershed/route.test.ts
```

- [ ] **Step 5: Commit**
```bash
git add apps/web/app/api/v1/watershed
git commit -m "feat(web): /api/v1/watershed point-in-polygon api"
```

---

## Task 32: `/api/v1/sources` skeleton

**Files:**
- Create: `apps/web/app/api/v1/sources/route.ts`

- [ ] **Step 1: Implement with static config (real `last_fetched_at` will come in Plan 2)**

```ts
import { hal } from '@/lib/api/response';

export const dynamic = 'force-dynamic';

const SOURCES = [
  { id: 'ndi-w01',     description: 'NLNI W01 dam dataset',          schedule: 'monthly', last_fetched_at: null },
  { id: 'ndi-w07',     description: 'NLNI W07 watershed boundaries', schedule: 'monthly', last_fetched_at: null },
  { id: 'damnet',      description: 'Dam Almanac (damnet.or.jp)',    schedule: 'monthly', last_fetched_at: null },
  { id: 'kasenbosai',  description: 'Kasen-Bosai realtime',          schedule: 'hourly',  last_fetched_at: null },
  { id: 'suimon',      description: 'Suimon-Suishitsu DB',           schedule: 'on-demand', last_fetched_at: null },
];

export async function GET() {
  return hal(
    { sources: SOURCES },
    { self: { href: '/api/v1/sources' } },
  );
}
```

- [ ] **Step 2: Smoke**
```bash
just dev-web &
sleep 3
curl -fsS http://localhost:3000/api/v1/sources | jq .sources
kill %1
```

- [ ] **Step 3: Commit**
```bash
git add apps/web/app/api/v1/sources
git commit -m "feat(web): /api/v1/sources skeleton"
```

---

## Task 33: graphile-worker setup and master cron jobs

**Files:**
- Create: `packages/db/migrations/0010_graphile_worker.sql`
- Create: `apps/worker/package.json`
- Create: `apps/worker/tsconfig.json`
- Create: `apps/worker/src/index.ts`
- Create: `apps/worker/src/crontab.ts`
- Create: `apps/worker/src/tasks/master_refresh_ndi.ts`
- Create: `apps/worker/src/tasks/master_refresh_damnet.ts`
- Create: `apps/worker/src/tasks/master_match.ts`

- [ ] **Step 1: Migration enabling graphile-worker schema**

```sql
-- packages/db/migrations/0010_graphile_worker.sql
-- graphile-worker installs its own schema on first run; we just hold the slot
SELECT 1;
```

(graphile-worker will create the schema on `runMigrations()` call.)

- [ ] **Step 2: Worker `package.json`**

```json
{
  "name": "@dam/worker",
  "version": "0.0.0",
  "private": true,
  "type": "module",
  "scripts": {
    "dev":        "bun run src/index.ts",
    "typecheck":  "tsc --noEmit"
  },
  "dependencies": {
    "@dam/db": "workspace:*",
    "@dam/adapters-ndi": "workspace:*",
    "@dam/adapters-damnet": "workspace:*",
    "graphile-worker": "^0.16.0"
  }
}
```

- [ ] **Step 3: `tsconfig.json`**
```json
{ "extends": "../../tsconfig.base.json", "include": ["src/**/*"] }
```

- [ ] **Step 4: `crontab.ts`**

```ts
// apps/worker/src/crontab.ts
// graphile-worker crontab format: https://github.com/graphile/worker
export const CRONTAB = `
# Master refresh: NLNI on the 1st of each month at 03:00
0 3 1 * * master.refresh.ndi
# Damnet: 5th of each month at 03:00 (after NLNI to maximize match coverage)
0 3 5 * * master.refresh.damnet
# Match sweep: nightly at 04:00
0 4 * * * master.match
`;
```

- [ ] **Step 5: Tasks**

```ts
// apps/worker/src/tasks/master_refresh_ndi.ts
import type { Task } from 'graphile-worker';
import { importDams, importWatersheds, loadGeoJson, parseW01, parseW07 } from '@dam/adapters-ndi';

const W07_URL = process.env.NDI_W07_URL;     // configurable via env
const W01_URL = process.env.NDI_W01_URL;

const task: Task = async (_payload, helpers) => {
  if (!W07_URL || !W01_URL) {
    helpers.logger.error('NDI_W07_URL and NDI_W01_URL must be set');
    return;
  }
  const w07 = await loadGeoJson(W07_URL);
  const ws  = await importWatersheds(parseW07(w07));
  helpers.logger.info(`watersheds upserted: ${ws.upserted}`);
  const w01 = await loadGeoJson(W01_URL);
  const dr  = await importDams(parseW01(w01));
  helpers.logger.info(`dams upserted: ${dr.upserted}`);
};

export default task;
```

```ts
// apps/worker/src/tasks/master_refresh_damnet.ts
import type { Task } from 'graphile-worker';
import { HttpClient } from '@dam/core/http_client';
import {
  importDamnetDetail,
  parseDamnetDetail,
  parseDamnetList,
} from '@dam/adapters-damnet';

const LIST_URL = process.env.DAMNET_LIST_URL;
const BASE_URL = process.env.DAMNET_BASE_URL ?? 'https://damnet.or.jp';

const task: Task = async (_payload, helpers) => {
  if (!LIST_URL) {
    helpers.logger.error('DAMNET_LIST_URL not set');
    return;
  }
  const c = new HttpClient({
    userAgent: 'DamDataPlatform/0.1 (+https://example.com/bot; matsubokkuri@gmail.com)',
    minIntervalMs: 2000,
    maxRetries: 3,
  });
  const list = parseDamnetList((await c.get(LIST_URL)).bodyText, BASE_URL);
  helpers.logger.info(`damnet list size: ${list.length}`);

  let matched = 0, review = 0, none = 0;
  for (const item of list) {
    const r = await c.get(item.detailUrl);
    if (r.status !== 200) { helpers.logger.warn(`HTTP ${r.status} ${item.detailUrl}`); continue; }
    const detail = parseDamnetDetail(r.bodyText, item.damnetId);
    const out = await importDamnetDetail(detail);
    if (out.outcome === 'matched') matched++;
    else if (out.outcome === 'review_enqueued') review++;
    else none++;
  }
  helpers.logger.info(`damnet matched=${matched} review=${review} none=${none}`);
};

export default task;
```

```ts
// apps/worker/src/tasks/master_match.ts
import type { Task } from 'graphile-worker';

// Stub: in Plan 2/3 we'll add reconciliation re-runs and review processing.
const task: Task = async (_payload, helpers) => {
  helpers.logger.info('master.match: nothing to do (placeholder)');
};

export default task;
```

- [ ] **Step 6: Worker entry**

```ts
// apps/worker/src/index.ts
import { run } from 'graphile-worker';
import refreshNdi from './tasks/master_refresh_ndi.ts';
import refreshDamnet from './tasks/master_refresh_damnet.ts';
import match from './tasks/master_match.ts';
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
      'master.refresh.ndi': refreshNdi,
      'master.refresh.damnet': refreshDamnet,
      'master.match': match,
    },
  });

  await runner.promise;
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
```

- [ ] **Step 7: Run worker locally**
```bash
just up && just migrate
NDI_W07_URL=tests/fixtures/ndi/w07_sample.geojson \
NDI_W01_URL=tests/fixtures/ndi/w01_sample.geojson \
just dev-worker &
WORKER_PID=$!
sleep 5
# Trigger the job once (without waiting for cron):
docker compose exec db psql -U dam -d dam -c "SELECT graphile_worker.add_job('master.refresh.ndi');"
sleep 5
kill $WORKER_PID
```

Expected log lines: `watersheds upserted: 2` and `dams upserted: 2`.

- [ ] **Step 8: Commit**
```bash
git add apps/worker packages/db/migrations/0010_graphile_worker.sql
git commit -m "feat(worker): graphile-worker with master refresh and crontab"
```

---

## Task 34: GitHub Actions CI

**Files:**
- Create: `.github/workflows/ci.yml`

- [ ] **Step 1: Workflow**

```yaml
name: CI

on:
  push: { branches: [main] }
  pull_request:

jobs:
  test:
    runs-on: ubuntu-latest
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
    env:
      DATABASE_URL: postgres://dam:dam@localhost:5432/dam
    steps:
      - uses: actions/checkout@v4
      - uses: oven-sh/setup-bun@v2
        with: { bun-version: latest }
      - run: bun install --frozen-lockfile
      - run: bun run lint
      - run: bun run typecheck
      - run: bun run --filter @dam/db migrate
      - run: bun test
```

- [ ] **Step 2: Push and verify CI**
Ask the user before pushing; plan commit only.

- [ ] **Step 3: Commit**
```bash
git add .github/workflows/ci.yml
git commit -m "ci: lint, typecheck, migrate, test"
```

---

## Task 35: README and runbook

**Files:**
- Create: `README.md`

- [ ] **Step 1: Write README**

```markdown
# Dam Data Platform

Realtime and historical reservoir-level data for dams across Japan.

## Local development

```sh
just up           # start Postgres + MinIO
just migrate      # run database migrations
just dev-web     # http://localhost:3000
just dev-worker  # graphile-worker
```

## Master imports

```sh
just import-ndi-watersheds -- --source tests/fixtures/ndi/w07_sample.geojson
just import-ndi-dams       -- --source tests/fixtures/ndi/w01_sample.geojson
just import-damnet         -- --list tests/fixtures/damnet/list.html
```

## API

- `GET /api/v1/healthz`
- `GET /api/v1/watershed?lat=&lng=` — point-in-polygon watershed lookup
- `GET /api/v1/sources` — data-source registry

See `docs/superpowers/specs/2026-05-01-dam-data-platform-design.md`.
```

- [ ] **Step 2: Commit**
```bash
git add README.md
git commit -m "docs: README quickstart"
```

---

## Self-Review

(Performed by the planner — record any fixes in this plan before handing off.)

1. **Spec coverage**:
   - §1 Goals: success metrics referenced in Plan 1's coverage of master DB, watershed
     geocoding, README. Drought/prediction explicitly out-of-scope (handled by later plans).
   - §2 Scope: subsystems 1 and 5 covered by tasks 1–32 (master) and 31 (geocoding API).
     Subsystems 2/3/4 explicitly deferred to Plans 2 and 3.
   - §3 Data sources: NLNI W01/W07 (tasks 17–22); Dam Almanac (tasks 23–28); adapter
     abstraction is realized as `@dam/adapters-*` package boundaries.
   - §4 Data model: master tables, raw_snapshots NOT in Plan 1 (deferred — observation
     ingest is Plan 2). Slug, external_ids, match_review covered.
   - §5 Architecture: Coolify deployment is planned only as README-level for now;
     dockerfiles are Plan 4. CI workflow added.
   - §6 URL/SEO: only `/api/v1/*` and a placeholder home page are in Plan 1; full
     SEO/site lives in Plan 3.
   - §7 Public API: only `healthz`, `watershed`, `sources` in Plan 1. API key auth and
     rate-limiting are Plan 3.
   - §8 Data quality: skeleton (`quality_flag` column lands in Plan 2 alongside
     observations).
   - §9 Watershed geocoding: complete (tasks 18, 19, 31).
   - §10 ETL/jobs: master refresh jobs covered (task 33).
   - §11 Deployment: deferred (Plan 4).
   - §12 Tests: unit + integration coverage demonstrated; Playwright E2E deferred to
     Plan 3 when a real frontend exists.
   - §13 Non-functional: not directly addressed in Plan 1 — will be re-checked in
     Plan 3.
   - §14 Risks: legal review and upstream-change monitoring tracked in spec; not
     blocking Plan 1.

2. **Placeholder scan**: Tasks reference real fixtures and exact code; no TBDs.
   The `master_match.ts` task body explicitly says it is a placeholder with a single
   log line — that is intentional and noted as such in Task 33 Step 5.

3. **Type consistency**: `DamRow` was first defined in Task 16 without `lat/lng`;
   Task 26 Step 6 adds them with explicit instructions to update both the row type
   and the SELECT. `upsertDamByExternalId` was redefined in Task 16 Step 4 to be
   source-aware, so all later callers (`importDams`, `importDamnetDetail`) match.
   `ParsedWatershed.geometry` allows both Polygon and MultiPolygon; the importer
   wraps Polygon to MultiPolygon before persisting.

---

## Execution Handoff

Plan complete and saved to `docs/superpowers/plans/2026-05-01-foundation-and-master-db.md`.
Two execution options:

1. **Subagent-Driven (recommended)** — Dispatch a fresh subagent per task with review between tasks; fast iteration on a long plan like this.
2. **Inline Execution** — Execute tasks in this session in batches with checkpoints.

Which approach?
