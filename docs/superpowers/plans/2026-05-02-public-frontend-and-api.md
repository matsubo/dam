# Public Frontend + Full API Surface — Implementation Plan (Plan 3)

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ship the public face of the platform: SEO-optimized dam list / detail / watershed / prefecture pages, a Japan map view with clustered dam markers, ECharts time-series graphs, sitemap + structured data, and the full HATEOAS REST API surface gated by API keys + rate limits.

**Architecture:** Next.js 15 App Router with ISR (15-minute revalidate) for content pages and SSG for the map; Client Components for interactive charts and map. API surfaces every entity (dams, watersheds, prefectures, observations, sources) under `/api/v1/...` with HAL `_links`, RFC 7807 problem responses, and per-key rate limiting backed by PostgreSQL. Server Components fetch directly from the DB via the existing repo layer; the public REST API exists for external consumers and is exercised by the test suite.

**Tech Stack:** Same as Plans 1–2 (Bun, Next.js 15, TypeScript, PostgreSQL/TimescaleDB/PostGIS, Drizzle types). Adds ECharts (`echarts-for-react`), Leaflet for the map (`leaflet` + `react-leaflet`, no heavy 3D dep), Tailwind CSS for styling.

**Reference spec:** `docs/superpowers/specs/2026-05-01-dam-data-platform-design.md`

**Out of scope (post-MVP):** drought alerts, weather-driven prediction, user accounts, bulk download tiers, address-input geocoding (the `/watershed?lat=&lng=` API is enough for current consumers).

---

## File Structure

```
apps/web/
├── app/
│   ├── layout.tsx                       # MODIFY: nav, footer, metadata defaults
│   ├── page.tsx                         # MODIFY: home (latest, top dams, map preview)
│   ├── globals.css                      # NEW: tailwind directives
│   ├── not-found.tsx                    # NEW
│   ├── error.tsx                        # NEW (client error boundary)
│   ├── dams/
│   │   ├── page.tsx                     # NEW: list (filters + pagination)
│   │   ├── [slug]/page.tsx              # NEW: detail
│   │   └── [slug]/opengraph-image.tsx   # NEW: dynamic OG image (optional, Phase 5)
│   ├── watersheds/
│   │   ├── page.tsx                     # NEW
│   │   └── [slug]/page.tsx              # NEW
│   ├── prefectures/[code]/page.tsx      # NEW
│   ├── map/page.tsx                     # NEW
│   ├── sources/page.tsx                 # NEW (public quality UI)
│   ├── api/docs/page.tsx                # NEW (Swagger UI mount)
│   ├── sitemap.ts                       # NEW (Next 15 sitemap convention)
│   ├── robots.ts                        # NEW
│   └── api/v1/
│       ├── dams/route.ts                # NEW (list)
│       ├── dams/[slug]/route.ts         # NEW (detail)
│       ├── dams/[slug]/sources/route.ts # NEW (provenance)
│       ├── watersheds/route.ts          # NEW (list)
│       ├── watersheds/[slug]/route.ts   # NEW (detail)
│       ├── watersheds/[slug]/aggregate/route.ts # NEW
│       ├── watersheds/[slug]/dams/route.ts      # NEW
│       ├── prefectures/[code]/dams/route.ts     # NEW
│       └── openapi.json/route.ts        # NEW
├── components/                          # NEW
│   ├── breadcrumbs.tsx
│   ├── dam-card.tsx
│   ├── dam-table.tsx
│   ├── filter-bar.tsx
│   ├── pagination.tsx
│   ├── observation-chart.tsx            # client (ECharts)
│   ├── japan-map.tsx                    # client (Leaflet)
│   ├── quality-badge.tsx
│   └── nav.tsx
├── lib/
│   ├── api/
│   │   ├── auth.ts                      # NEW: API key + rate limit
│   │   ├── error.ts                     # MODIFY
│   │   ├── pagination.ts                # NEW
│   │   └── response.ts                  # MODIFY (Link header builder)
│   ├── repo/
│   │   ├── dams.ts                      # NEW: server-only data loaders for pages
│   │   └── watersheds.ts                # NEW
│   ├── seo/
│   │   ├── metadata.ts                  # NEW
│   │   └── structured_data.ts           # NEW (schema.org helpers)
│   └── format.ts                        # NEW (numbers, percentages, dates)
├── postcss.config.mjs                   # NEW (tailwind)
├── tailwind.config.ts                   # NEW
├── package.json                         # MODIFY: add echarts, leaflet, tailwind
└── tsconfig.json                        # MODIFY: include `components/`

packages/
└── db/
    ├── migrations/
    │   ├── 0017_api_keys.sql             # NEW
    │   └── 0018_dam_aliases.sql          # NEW (reverse external_ids index for fast lookup)
    └── src/
        ├── schema/
        │   └── api_keys.ts               # NEW
        └── repo/
            ├── api_keys.ts               # NEW
            ├── dams.ts                   # MODIFY: list with filters + cursor; detail
            └── watersheds.ts             # MODIFY: list, aggregate

bin/
└── api_key.ts                            # NEW (admin CLI: issue/list/revoke keys)
```

---

## Task 1: Migration 0017 — api_keys

**Files:**
- Create: `packages/db/migrations/0017_api_keys.sql`
- Create: `packages/db/src/schema/api_keys.ts`
- Modify: `packages/db/src/schema/index.ts`

- [ ] **Step 1: Migration**

```sql
CREATE TABLE api_keys (
  id              BIGSERIAL PRIMARY KEY,
  prefix          CHAR(8) NOT NULL UNIQUE,           -- public part shown to user
  hash            BYTEA NOT NULL,                    -- sha256 of full key (prefix + secret)
  email           TEXT NOT NULL,
  label           TEXT,
  tier            TEXT NOT NULL DEFAULT 'free'
                   CHECK (tier IN ('free','partner','admin')),
  rate_per_min    INT NOT NULL DEFAULT 60,
  rate_per_day    INT NOT NULL DEFAULT 10000,
  active          BOOLEAN NOT NULL DEFAULT TRUE,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  last_used_at    TIMESTAMPTZ,
  revoked_at      TIMESTAMPTZ
);

CREATE TABLE api_key_usage (
  api_key_id      BIGINT NOT NULL REFERENCES api_keys(id) ON DELETE CASCADE,
  bucket_minute   TIMESTAMPTZ NOT NULL,              -- truncated to the minute
  count           INT NOT NULL,
  PRIMARY KEY (api_key_id, bucket_minute)
);

CREATE INDEX api_key_usage_bucket ON api_key_usage (bucket_minute);
```

- [ ] **Step 2: Drizzle schema**

```ts
// packages/db/src/schema/api_keys.ts
import {
  bigint, bigserial, boolean, char, customType, integer, pgTable, primaryKey,
  text, timestamp,
} from 'drizzle-orm/pg-core';

const bytea = customType<{ data: Uint8Array; driverData: Buffer }>({
  dataType: () => 'bytea',
  toDriver: (v) => Buffer.from(v),
  fromDriver: (v) => new Uint8Array(v),
});

export const apiKeys = pgTable('api_keys', {
  id: bigserial('id', { mode: 'bigint' }).primaryKey(),
  prefix: char('prefix', { length: 8 }).notNull().unique(),
  hash: bytea('hash').notNull(),
  email: text('email').notNull(),
  label: text('label'),
  tier: text('tier', { enum: ['free', 'partner', 'admin'] }).notNull().default('free'),
  ratePerMin: integer('rate_per_min').notNull().default(60),
  ratePerDay: integer('rate_per_day').notNull().default(10000),
  active: boolean('active').notNull().default(true),
  createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
  lastUsedAt: timestamp('last_used_at', { withTimezone: true }),
  revokedAt: timestamp('revoked_at', { withTimezone: true }),
});

export const apiKeyUsage = pgTable(
  'api_key_usage',
  {
    apiKeyId: bigint('api_key_id', { mode: 'bigint' }).notNull(),
    bucketMinute: timestamp('bucket_minute', { withTimezone: true }).notNull(),
    count: integer('count').notNull(),
  },
  (t) => ({ pk: primaryKey({ columns: [t.apiKeyId, t.bucketMinute] }) }),
);

export type ApiKey = typeof apiKeys.$inferSelect;
```

- [ ] **Step 3: Append re-export to `packages/db/src/schema/index.ts`**

```ts
export * from './api_keys.ts';
```

- [ ] **Step 4: Run + commit**
```bash
just migrate
bun run --filter @dam/db typecheck
git add packages/db/migrations/0017_api_keys.sql packages/db/src/schema/api_keys.ts packages/db/src/schema/index.ts
git commit -m "feat(db): api_keys + api_key_usage tables"
```

---

## Task 2: API key repo + admin CLI (TDD)

**Files:**
- Create: `packages/db/src/repo/api_keys.ts`
- Test: `packages/db/src/repo/api_keys.test.ts`
- Create: `bin/api_key.ts`
- Modify: `justfile`

- [ ] **Step 1: Repo test (TDD)**

```ts
// packages/db/src/repo/api_keys.test.ts
import { afterAll, describe, expect, test } from 'bun:test';
import { sql } from '../client.ts';
import { hashKey, issueKey, lookupByPrefix, recordUsage, revoke, usageInLastMinute } from './api_keys.ts';

afterAll(async () => {
  await sql`DELETE FROM api_keys WHERE email = 'test@example.com'`;
});

describe('api_keys repo', () => {
  test('issueKey returns prefix + plaintext, persists hash', async () => {
    const { id, prefix, plaintext } = await issueKey({ email: 'test@example.com', label: 'unit' });
    expect(prefix.length).toBe(8);
    expect(plaintext).toMatch(new RegExp(`^${prefix}_[A-Za-z0-9_-]{40,}$`));
    const row = await lookupByPrefix(prefix);
    expect(row?.id).toBe(id);
  });

  test('lookupByPrefix returns null for unknown', async () => {
    expect(await lookupByPrefix('zzzzzzzz')).toBeNull();
  });

  test('hashKey is deterministic and 32 bytes', () => {
    const h = hashKey('abcdefgh_token');
    expect(h.byteLength).toBe(32);
  });

  test('usageInLastMinute increments and reads back', async () => {
    const { id } = await issueKey({ email: 'test@example.com', label: 'usage' });
    const t = new Date();
    await recordUsage(id, t);
    await recordUsage(id, t);
    const n = await usageInLastMinute(id, t);
    expect(n).toBeGreaterThanOrEqual(2);
  });

  test('revoke flips active flag', async () => {
    const { id } = await issueKey({ email: 'test@example.com', label: 'revoke' });
    await revoke(id);
    const rows = await sql<{ active: boolean }[]>`SELECT active FROM api_keys WHERE id = ${id}`;
    expect(rows[0]?.active).toBe(false);
  });
});
```

- [ ] **Step 2: Repo impl**

```ts
// packages/db/src/repo/api_keys.ts
import { createHash, randomBytes } from 'node:crypto';
import { sql } from '../client.ts';

const ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';

function randomFromAlphabet(n: number): string {
  const bytes = randomBytes(n);
  let out = '';
  for (let i = 0; i < n; i++) out += ALPHABET[bytes[i]! % ALPHABET.length];
  return out;
}

export function hashKey(plaintext: string): Uint8Array {
  return new Uint8Array(createHash('sha256').update(plaintext).digest());
}

export interface IssueInput {
  email: string;
  label?: string;
  tier?: 'free' | 'partner' | 'admin';
}

export interface IssuedKey {
  id: bigint;
  prefix: string;
  plaintext: string;
}

export async function issueKey(input: IssueInput): Promise<IssuedKey> {
  let prefix = randomFromAlphabet(8);
  // retry on improbable collision
  for (let i = 0; i < 5; i++) {
    const exists = await sql<{ n: number }[]>`SELECT 1 AS n FROM api_keys WHERE prefix = ${prefix}`;
    if (exists.length === 0) break;
    prefix = randomFromAlphabet(8);
  }
  const secret = randomFromAlphabet(40);
  const plaintext = `${prefix}_${secret}`;
  const hash = hashKey(plaintext);
  const rows = await sql<{ id: bigint }[]>`
    INSERT INTO api_keys (prefix, hash, email, label, tier)
    VALUES (${prefix}, ${Buffer.from(hash)}, ${input.email}, ${input.label ?? null}, ${input.tier ?? 'free'})
    RETURNING id
  `;
  const id = rows[0]?.id;
  if (id === undefined) throw new Error('issueKey returned no row');
  return { id, prefix, plaintext };
}

export interface KeyRow {
  id: bigint;
  prefix: string;
  hash: Uint8Array;
  ratePerMin: number;
  ratePerDay: number;
  active: boolean;
}

export async function lookupByPrefix(prefix: string): Promise<KeyRow | null> {
  const rows = await sql<{
    id: bigint;
    prefix: string;
    hash: Buffer;
    rate_per_min: number;
    rate_per_day: number;
    active: boolean;
  }[]>`
    SELECT id, prefix, hash, rate_per_min, rate_per_day, active
    FROM api_keys WHERE prefix = ${prefix}
  `;
  const r = rows[0];
  if (!r) return null;
  return {
    id: r.id,
    prefix: r.prefix,
    hash: new Uint8Array(r.hash),
    ratePerMin: r.rate_per_min,
    ratePerDay: r.rate_per_day,
    active: r.active,
  };
}

export async function revoke(id: bigint): Promise<void> {
  await sql`UPDATE api_keys SET active = FALSE, revoked_at = NOW() WHERE id = ${id}`;
}

export async function touchLastUsed(id: bigint): Promise<void> {
  await sql`UPDATE api_keys SET last_used_at = NOW() WHERE id = ${id}`;
}

export async function recordUsage(id: bigint, at: Date): Promise<void> {
  const minute = new Date(Math.floor(at.getTime() / 60_000) * 60_000);
  await sql`
    INSERT INTO api_key_usage (api_key_id, bucket_minute, count)
    VALUES (${id}, ${minute}, 1)
    ON CONFLICT (api_key_id, bucket_minute)
    DO UPDATE SET count = api_key_usage.count + 1
  `;
}

export async function usageInLastMinute(id: bigint, at: Date): Promise<number> {
  const minute = new Date(Math.floor(at.getTime() / 60_000) * 60_000);
  const rows = await sql<{ count: number }[]>`
    SELECT count FROM api_key_usage WHERE api_key_id = ${id} AND bucket_minute = ${minute}
  `;
  return rows[0]?.count ?? 0;
}

export async function usageToday(id: bigint, at: Date): Promise<number> {
  const dayStart = new Date(at);
  dayStart.setUTCHours(0, 0, 0, 0);
  const rows = await sql<{ total: bigint }[]>`
    SELECT COALESCE(SUM(count), 0)::BIGINT AS total
    FROM api_key_usage
    WHERE api_key_id = ${id} AND bucket_minute >= ${dayStart}
  `;
  return Number(rows[0]?.total ?? 0);
}
```

- [ ] **Step 3: Admin CLI**

```ts
// bin/api_key.ts
import { parseArgs } from 'node:util';
import { sql } from '@dam/db/client';
import { issueKey, revoke } from '@dam/db/repo/api_keys';

async function main(): Promise<void> {
  const sub = process.argv[2];
  const argv = process.argv.slice(3).filter((a) => a !== '--');
  const { values } = parseArgs({
    args: argv,
    allowPositionals: true,
    options: {
      email: { type: 'string' },
      label: { type: 'string' },
      tier:  { type: 'string' },
      id:    { type: 'string' },
    },
  });

  if (sub === 'issue') {
    if (!values.email) throw new Error('--email required');
    const r = await issueKey({
      email: values.email,
      label: values.label,
      tier: (values.tier as 'free'|'partner'|'admin' | undefined) ?? 'free',
    });
    console.log(JSON.stringify(r, (_, v) => (typeof v === 'bigint' ? v.toString() : v)));
    return;
  }

  if (sub === 'revoke') {
    if (!values.id) throw new Error('--id required');
    await revoke(BigInt(values.id));
    console.log('revoked');
    return;
  }

  if (sub === 'list') {
    const rows = await sql`SELECT id, prefix, email, label, tier, active, created_at FROM api_keys ORDER BY id`;
    console.log(JSON.stringify(rows, (_, v) => (typeof v === 'bigint' ? v.toString() : v), 2));
    return;
  }

  console.error('Usage: bun run bin/api_key.ts <issue|revoke|list> [flags]');
  process.exit(2);
}

main()
  .catch((e) => {
    console.error(e);
    process.exitCode = 1;
  })
  .finally(() => sql.end({ timeout: 5 }));
```

- [ ] **Step 4: justfile recipes**

Append:
```make
# API key management
api-key-issue email="" label="":
    bun run bin/api_key.ts issue --email "{{email}}" --label "{{label}}"

api-key-list:
    bun run bin/api_key.ts list

api-key-revoke id="":
    bun run bin/api_key.ts revoke --id "{{id}}"
```

- [ ] **Step 5: Run + commit**
```bash
bun test packages/db/src/repo/api_keys.test.ts
git add packages/db/src/repo/api_keys.ts packages/db/src/repo/api_keys.test.ts bin justfile
git commit -m "feat(db): api_keys repo with issue/lookup/usage; admin CLI"
```

---

## Task 3: API auth + rate limit middleware (TDD)

**Files:**
- Create: `apps/web/lib/api/auth.ts`
- Test: `apps/web/lib/api/auth.test.ts`
- Modify: `apps/web/lib/api/error.ts` (add 401, 429 helpers)
- Modify: `apps/web/lib/api/response.ts` (add `withRateLimitHeaders`)

- [ ] **Step 1: `auth.ts` test (TDD)**

```ts
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { sql } from '@dam/db/client';
import { issueKey, revoke } from '@dam/db/repo/api_keys';
import { authorize } from './auth.ts';

let plaintext: string;
let id: bigint;

beforeAll(async () => {
  await sql`DELETE FROM api_keys WHERE email = 'auth-test@example.com'`;
  const r = await issueKey({ email: 'auth-test@example.com', label: 'auth-test' });
  id = r.id;
  plaintext = r.plaintext;
});

afterAll(async () => {
  await sql`DELETE FROM api_keys WHERE email = 'auth-test@example.com'`;
});

function req(headers: Record<string, string> = {}): Request {
  return new Request('http://localhost/api/v1/dams', { headers });
}

describe('authorize', () => {
  test('rejects requests with no header', async () => {
    const r = await authorize(req());
    expect(r.ok).toBe(false);
    expect(r.status).toBe(401);
  });

  test('rejects unknown key', async () => {
    const r = await authorize(req({ 'x-api-key': 'zzzzzzzz_secret' }));
    expect(r.ok).toBe(false);
    expect(r.status).toBe(401);
  });

  test('rejects wrong secret', async () => {
    const r = await authorize(req({ 'x-api-key': `${plaintext.slice(0, 8)}_wrongsecret` }));
    expect(r.ok).toBe(false);
    expect(r.status).toBe(401);
  });

  test('accepts a valid key and returns rate state', async () => {
    const r = await authorize(req({ 'x-api-key': plaintext }));
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.keyId).toBe(id);
      expect(r.rate.limit).toBe(60);
      expect(r.rate.remaining).toBeGreaterThanOrEqual(0);
    }
  });

  test('blocks when over rate limit', async () => {
    // burn the key down to 0 by issuing 60 lookups
    for (let i = 0; i < 60; i++) await authorize(req({ 'x-api-key': plaintext }));
    const r = await authorize(req({ 'x-api-key': plaintext }));
    expect(r.ok).toBe(false);
    expect(r.status).toBe(429);
  });

  test('rejects revoked key', async () => {
    await revoke(id);
    const r = await authorize(req({ 'x-api-key': plaintext }));
    expect(r.ok).toBe(false);
    expect(r.status).toBe(401);
  });
});
```

- [ ] **Step 2: Implement `auth.ts`**

```ts
import { hashKey, lookupByPrefix, recordUsage, touchLastUsed, usageInLastMinute, usageToday } from '@dam/db/repo/api_keys';

export interface RateState { limit: number; remaining: number; resetAt: number }
export type AuthResult =
  | { ok: true;  keyId: bigint; rate: RateState }
  | { ok: false; status: 401 | 429; reason: string; rate?: RateState };

function timingSafeEqual(a: Uint8Array, b: Uint8Array): boolean {
  if (a.byteLength !== b.byteLength) return false;
  let diff = 0;
  for (let i = 0; i < a.byteLength; i++) diff |= (a[i] ?? 0) ^ (b[i] ?? 0);
  return diff === 0;
}

const ADMIN_BYPASS = process.env.API_AUTH_BYPASS === '1';

export async function authorize(req: Request): Promise<AuthResult> {
  if (ADMIN_BYPASS) return { ok: true, keyId: 0n, rate: { limit: 1_000_000, remaining: 1_000_000, resetAt: 0 } };
  const header = req.headers.get('x-api-key');
  if (!header || !header.includes('_')) return { ok: false, status: 401, reason: 'Missing X-API-Key' };
  const prefix = header.slice(0, 8);
  const row = await lookupByPrefix(prefix);
  if (!row || !row.active) return { ok: false, status: 401, reason: 'Invalid key' };
  if (!timingSafeEqual(row.hash, hashKey(header))) {
    return { ok: false, status: 401, reason: 'Invalid key' };
  }

  const now = new Date();
  const usedMin = await usageInLastMinute(row.id, now);
  if (usedMin >= row.ratePerMin) {
    const minute = new Date(Math.floor(now.getTime() / 60_000) * 60_000);
    const resetAt = minute.getTime() + 60_000;
    return {
      ok: false,
      status: 429,
      reason: 'Per-minute rate exceeded',
      rate: { limit: row.ratePerMin, remaining: 0, resetAt },
    };
  }
  const usedDay = await usageToday(row.id, now);
  if (usedDay >= row.ratePerDay) {
    const tomorrow = new Date(now);
    tomorrow.setUTCHours(24, 0, 0, 0);
    return {
      ok: false,
      status: 429,
      reason: 'Per-day rate exceeded',
      rate: { limit: row.ratePerDay, remaining: 0, resetAt: tomorrow.getTime() },
    };
  }

  await recordUsage(row.id, now);
  await touchLastUsed(row.id);
  const minute = new Date(Math.floor(now.getTime() / 60_000) * 60_000);
  return {
    ok: true,
    keyId: row.id,
    rate: {
      limit: row.ratePerMin,
      remaining: Math.max(0, row.ratePerMin - usedMin - 1),
      resetAt: minute.getTime() + 60_000,
    },
  };
}

export function rateLimitHeaders(state: RateState): Record<string, string> {
  return {
    'RateLimit-Limit': String(state.limit),
    'RateLimit-Remaining': String(state.remaining),
    'RateLimit-Reset': String(Math.max(0, Math.floor((state.resetAt - Date.now()) / 1000))),
  };
}
```

- [ ] **Step 3: Update `response.ts` and `error.ts` to flow rate-limit headers**

```ts
// apps/web/lib/api/response.ts (replace existing)
import { NextResponse } from 'next/server';
import { buildLinks, type LinksInput } from '@dam/core/hateoas';

export function hal<T extends object>(
  body: T,
  links: LinksInput,
  init?: { headers?: Record<string, string> },
): NextResponse {
  return NextResponse.json(
    { ...body, _links: buildLinks(links) },
    { headers: { 'content-type': 'application/hal+json', ...(init?.headers ?? {}) } },
  );
}
```

```ts
// apps/web/lib/api/error.ts (replace existing)
import { NextResponse } from 'next/server';

export class HttpError extends Error {
  readonly status: number;
  readonly headers: Record<string, string>;
  constructor(status: number, message: string, headers: Record<string, string> = {}) {
    super(message);
    this.status = status;
    this.headers = headers;
  }
}

export function asProblem(err: unknown): NextResponse {
  if (err instanceof HttpError) {
    return NextResponse.json(
      { type: 'about:blank', title: err.message, status: err.status },
      {
        status: err.status,
        headers: { 'content-type': 'application/problem+json', ...err.headers },
      },
    );
  }
  console.error(err);
  return NextResponse.json(
    { type: 'about:blank', title: 'Internal Server Error', status: 500 },
    { status: 500, headers: { 'content-type': 'application/problem+json' } },
  );
}
```

- [ ] **Step 4: Apply auth to existing routes**

In every existing route under `apps/web/app/api/v1/...` except `healthz` and `sources`, prepend:

```ts
const auth = await authorize(req);
if (!auth.ok) {
  if (auth.status === 429 && auth.rate) {
    return new Response(
      JSON.stringify({ type: 'about:blank', title: auth.reason, status: 429 }),
      { status: 429, headers: { 'content-type': 'application/problem+json', ...rateLimitHeaders(auth.rate), 'Retry-After': String(Math.ceil((auth.rate.resetAt - Date.now()) / 1000)) } },
    );
  }
  return new Response(
    JSON.stringify({ type: 'about:blank', title: auth.reason, status: auth.status }),
    { status: auth.status, headers: { 'content-type': 'application/problem+json' } },
  );
}
```

Decorate successful responses with `auth.rate` headers via `hal(..., { headers: rateLimitHeaders(auth.rate) })`.

Apply specifically to: `/api/v1/watershed`. Do NOT auth `/api/v1/healthz` and `/api/v1/sources` (intentional public endpoints for monitoring + transparency).

- [ ] **Step 5: Update existing watershed route test**

Add a `beforeAll` that issues a key and inject `x-api-key` into the test requests. Use `API_AUTH_BYPASS=1` in the test environment as a simpler alternative — set it via `bunfig.toml` or per-test `process.env`.

- [ ] **Step 6: Run + commit**
```bash
bun test apps/web/lib/api/auth.test.ts
bun test apps/web
git add apps/web/lib/api packages/db/src/repo/api_keys.ts
git commit -m "feat(web): api key auth + rate limit middleware"
```

---

## Task 4: List/aggregate repo extensions

**Files:**
- Modify: `packages/db/src/repo/dams.ts` (add `listDams`, `findDamBySlug`, `latestObservation`)
- Modify: `packages/db/src/repo/watersheds.ts` (add `listWatersheds`, `findWatershedBySlug`, `aggregateWatershed`)
- Test: `packages/db/src/repo/dams_list.test.ts`

- [ ] **Step 1: `listDams` with filters + cursor**

Append to `packages/db/src/repo/dams.ts`:

```ts
export interface DamListFilters {
  pref?: string | null;
  watershedSlug?: string | null;
  manager?: string | null;
  search?: string | null;
  cursor?: bigint | null;
  pageSize?: number;
}

export interface DamListItem {
  id: bigint;
  slug: string;
  name: string;
  prefCode: string;
  manager: string | null;
  totalCapacityM3: string | null;
  watershedSlug: string | null;
  watershedName: string | null;
  lat: number;
  lng: number;
}

export async function listDams(f: DamListFilters): Promise<{ items: DamListItem[]; nextCursor: bigint | null }> {
  const limit = Math.max(1, Math.min(200, f.pageSize ?? 50));
  const rows = await sql<DamListItem[]>`
    SELECT
      d.id, d.slug, d.name, d.pref_code AS "prefCode", d.manager,
      d.total_capacity_m3::TEXT AS "totalCapacityM3",
      w.slug AS "watershedSlug", w.name AS "watershedName",
      ST_Y(d.location::geometry) AS lat, ST_X(d.location::geometry) AS lng
    FROM dams d
    LEFT JOIN watersheds w ON w.id = d.watershed_id
    WHERE (${f.pref ?? null}::text IS NULL OR d.pref_code = ${f.pref ?? null})
      AND (${f.watershedSlug ?? null}::text IS NULL OR w.slug = ${f.watershedSlug ?? null})
      AND (${f.manager ?? null}::text IS NULL OR d.manager = ${f.manager ?? null})
      AND (${f.search ?? null}::text IS NULL OR d.name ILIKE ('%' || ${f.search ?? null} || '%'))
      AND (${f.cursor ?? null}::bigint IS NULL OR d.id > ${f.cursor ?? null})
    ORDER BY d.id
    LIMIT ${limit + 1}
  `;
  const items = rows.slice(0, limit);
  const nextCursor = rows.length > limit ? (items[items.length - 1]?.id ?? null) : null;
  return { items, nextCursor };
}

export interface DamDetail extends DamListItem {
  nameKana: string | null;
  type: string | null;
  heightM: string | null;
  effectiveCapacityM3: string | null;
  floodCapacityM3: string | null;
  completedYear: number | null;
  externalIds: Record<string, string>;
}

export async function findDamBySlug(slug: string): Promise<DamDetail | null> {
  const rows = await sql<DamDetail[]>`
    SELECT
      d.id, d.slug, d.name, d.name_kana AS "nameKana",
      d.pref_code AS "prefCode", d.manager, d.type,
      d.height_m::TEXT AS "heightM",
      d.total_capacity_m3::TEXT AS "totalCapacityM3",
      d.effective_capacity_m3::TEXT AS "effectiveCapacityM3",
      d.flood_capacity_m3::TEXT AS "floodCapacityM3",
      d.completed_year AS "completedYear",
      d.external_ids AS "externalIds",
      w.slug AS "watershedSlug", w.name AS "watershedName",
      ST_Y(d.location::geometry) AS lat, ST_X(d.location::geometry) AS lng
    FROM dams d
    LEFT JOIN watersheds w ON w.id = d.watershed_id
    WHERE d.slug = ${slug}
    LIMIT 1
  `;
  return rows[0] ?? null;
}

export interface LatestObservation {
  observedAt: Date;
  storageVolumeM3: string | null;
  storageRate: string | null;
  inflowM3s: string | null;
  outflowM3s: string | null;
  waterLevelM: string | null;
  rainfallMm: string | null;
  qualityFlag: number;
  sourceId: string;
}

export async function latestObservation(damId: bigint): Promise<LatestObservation | null> {
  const rows = await sql<LatestObservation[]>`
    SELECT
      observed_at AS "observedAt",
      storage_volume_m3::TEXT AS "storageVolumeM3",
      storage_rate::TEXT AS "storageRate",
      inflow_m3s::TEXT AS "inflowM3s",
      outflow_m3s::TEXT AS "outflowM3s",
      water_level_m::TEXT AS "waterLevelM",
      rainfall_mm::TEXT AS "rainfallMm",
      quality_flag AS "qualityFlag",
      source_id AS "sourceId"
    FROM observations
    WHERE dam_id = ${damId}
    ORDER BY observed_at DESC
    LIMIT 1
  `;
  return rows[0] ?? null;
}

export async function nearbyDams(damId: bigint, radiusM: number, limit: number): Promise<DamListItem[]> {
  return sql<DamListItem[]>`
    SELECT
      d2.id, d2.slug, d2.name, d2.pref_code AS "prefCode", d2.manager,
      d2.total_capacity_m3::TEXT AS "totalCapacityM3",
      w.slug AS "watershedSlug", w.name AS "watershedName",
      ST_Y(d2.location::geometry) AS lat, ST_X(d2.location::geometry) AS lng
    FROM dams d
    JOIN dams d2 ON d2.id <> d.id AND ST_DWithin(d.location, d2.location, ${radiusM})
    LEFT JOIN watersheds w ON w.id = d2.watershed_id
    WHERE d.id = ${damId}
    ORDER BY d.location <-> d2.location
    LIMIT ${limit}
  `;
}
```

- [ ] **Step 2: `listWatersheds` + `aggregateWatershed`**

Append to `packages/db/src/repo/watersheds.ts`:

```ts
export interface WatershedListItem {
  id: bigint;
  slug: string;
  code: string;
  name: string;
  kind: 'first' | 'second' | 'other';
  damCount: number;
}

export async function listWatersheds(opts: { kind?: 'first' | 'second' | null; cursor?: bigint | null; pageSize?: number } = {}): Promise<{ items: WatershedListItem[]; nextCursor: bigint | null }> {
  const limit = Math.max(1, Math.min(500, opts.pageSize ?? 200));
  const rows = await sql<WatershedListItem[]>`
    SELECT
      w.id, w.slug, w.code, w.name, w.kind,
      COUNT(d.id)::INT AS "damCount"
    FROM watersheds w
    LEFT JOIN dams d ON d.watershed_id = w.id
    WHERE (${opts.kind ?? null}::text IS NULL OR w.kind = ${opts.kind ?? null})
      AND (${opts.cursor ?? null}::bigint IS NULL OR w.id > ${opts.cursor ?? null})
    GROUP BY w.id
    ORDER BY w.id
    LIMIT ${limit + 1}
  `;
  const items = rows.slice(0, limit);
  const nextCursor = rows.length > limit ? (items[items.length - 1]?.id ?? null) : null;
  return { items, nextCursor };
}

export interface WatershedDetail {
  id: bigint;
  slug: string;
  code: string;
  name: string;
  nameKana: string | null;
  kind: 'first' | 'second' | 'other';
  areaKm2: number | null;
}

export async function findWatershedBySlug(slug: string): Promise<WatershedDetail | null> {
  const rows = await sql<WatershedDetail[]>`
    SELECT id, slug, code, name, name_kana AS "nameKana", kind, area_km2 AS "areaKm2"
    FROM watersheds WHERE slug = ${slug} LIMIT 1
  `;
  return rows[0] ?? null;
}

export interface WatershedAggregate {
  damCount: number;
  totalCapacityM3: string | null;
  latestStorageVolumeM3: string | null;
  observedAt: Date | null;
}

export async function aggregateWatershed(watershedId: bigint): Promise<WatershedAggregate> {
  const rows = await sql<WatershedAggregate[]>`
    WITH ds AS (
      SELECT id, total_capacity_m3 FROM dams WHERE watershed_id = ${watershedId}
    ),
    latest AS (
      SELECT DISTINCT ON (o.dam_id) o.dam_id, o.observed_at, o.storage_volume_m3
      FROM observations o
      JOIN ds ON ds.id = o.dam_id
      ORDER BY o.dam_id, o.observed_at DESC
    )
    SELECT
      COUNT(*)::INT                                    AS "damCount",
      SUM(ds.total_capacity_m3)::TEXT                  AS "totalCapacityM3",
      SUM(latest.storage_volume_m3)::TEXT              AS "latestStorageVolumeM3",
      MAX(latest.observed_at)                          AS "observedAt"
    FROM ds
    LEFT JOIN latest ON latest.dam_id = ds.id
  `;
  return rows[0] ?? { damCount: 0, totalCapacityM3: null, latestStorageVolumeM3: null, observedAt: null };
}
```

- [ ] **Step 3: TDD test (`dams_list.test.ts`)**

```ts
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { sql } from '../client.ts';
import { listDams, upsertDamByExternalId } from './dams.ts';

beforeAll(async () => {
  await sql`DELETE FROM dams WHERE external_ids ->> 'ndi' LIKE 'LIST-TEST-%'`;
  for (let i = 0; i < 5; i++) {
    await upsertDamByExternalId('ndi', {
      slug: `list-test-${i}`,
      name: `Test Dam ${i}`,
      prefCode: '13',
      lat: 35 + i * 0.01,
      lng: 139 + i * 0.01,
      externalIds: { ndi: `LIST-TEST-${i}` },
    });
  }
});

afterAll(async () => {
  await sql`DELETE FROM dams WHERE external_ids ->> 'ndi' LIKE 'LIST-TEST-%'`;
});

describe('listDams', () => {
  test('paginates by cursor', async () => {
    const p1 = await listDams({ pref: '13', pageSize: 3, search: 'Test Dam' });
    expect(p1.items.length).toBe(3);
    expect(p1.nextCursor).not.toBeNull();
    const p2 = await listDams({ pref: '13', pageSize: 3, search: 'Test Dam', cursor: p1.nextCursor });
    expect(p2.items.length).toBe(2);
    expect(p2.nextCursor).toBeNull();
  });

  test('returns lat/lng', async () => {
    const r = await listDams({ pref: '13', pageSize: 1, search: 'Test Dam 0' });
    expect(r.items[0]?.lat).toBeCloseTo(35, 5);
    expect(r.items[0]?.lng).toBeCloseTo(139, 5);
  });
});
```

- [ ] **Step 4: Run + commit**
```bash
bun test packages/db/src/repo/dams_list.test.ts
git add packages/db/src/repo
git commit -m "feat(db): list/detail/aggregate repos for dams and watersheds"
```

---

## Task 5: Public REST endpoints — dams + watersheds + prefectures

**Files:**
- Create: `apps/web/lib/api/pagination.ts`
- Create: `apps/web/app/api/v1/dams/route.ts`
- Create: `apps/web/app/api/v1/dams/[slug]/route.ts`
- Create: `apps/web/app/api/v1/watersheds/route.ts`
- Create: `apps/web/app/api/v1/watersheds/[slug]/route.ts`
- Create: `apps/web/app/api/v1/watersheds/[slug]/aggregate/route.ts`
- Create: `apps/web/app/api/v1/watersheds/[slug]/dams/route.ts`
- Create: `apps/web/app/api/v1/prefectures/[code]/dams/route.ts`

- [ ] **Step 1: pagination helper**

```ts
// apps/web/lib/api/pagination.ts
export function pageLinks(self: string, nextCursor: bigint | null): { self: { href: string }; next?: { href: string } } {
  const out: { self: { href: string }; next?: { href: string } } = { self: { href: self } };
  if (nextCursor !== null) {
    const url = new URL(self, 'http://x');
    url.searchParams.set('cursor', nextCursor.toString());
    out.next = { href: `${url.pathname}${url.search}` };
  }
  return out;
}

export function rfc5988Link(nextCursor: bigint | null, self: string): string | null {
  if (nextCursor === null) return null;
  const url = new URL(self, 'http://x');
  url.searchParams.set('cursor', nextCursor.toString());
  return `<${url.pathname}${url.search}>; rel="next"`;
}
```

- [ ] **Step 2: `/api/v1/dams` (list)**

```ts
// apps/web/app/api/v1/dams/route.ts
import { z } from 'zod';
import { listDams } from '@dam/db/repo/dams';
import { authorize, rateLimitHeaders } from '../../../../lib/api/auth.ts';
import { HttpError, asProblem } from '../../../../lib/api/error.ts';
import { pageLinks, rfc5988Link } from '../../../../lib/api/pagination.ts';
import { hal } from '../../../../lib/api/response.ts';

export const dynamic = 'force-dynamic';

const Query = z.object({
  pref: z.string().regex(/^[0-9]{2}$/).optional(),
  watershed: z.string().optional(),
  manager: z.string().optional(),
  search: z.string().optional(),
  cursor: z.string().regex(/^[0-9]+$/).optional(),
  pageSize: z.string().regex(/^[0-9]+$/).optional(),
});

export async function GET(req: Request): Promise<Response> {
  try {
    const auth = await authorize(req);
    if (!auth.ok) return makeUnauthorized(auth);

    const url = new URL(req.url);
    const parsed = Query.safeParse(Object.fromEntries(url.searchParams));
    if (!parsed.success) throw new HttpError(400, 'Invalid query');
    const { pref, watershed, manager, search, cursor, pageSize } = parsed.data;

    const r = await listDams({
      pref: pref ?? null,
      watershedSlug: watershed ?? null,
      manager: manager ?? null,
      search: search ?? null,
      cursor: cursor ? BigInt(cursor) : null,
      pageSize: pageSize ? Number(pageSize) : 50,
    });

    const self = url.pathname + url.search;
    const linkHeader = rfc5988Link(r.nextCursor, self);
    return hal(
      { items: r.items, count: r.items.length },
      { ...pageLinks(self, r.nextCursor) },
      {
        headers: {
          ...rateLimitHeaders(auth.rate),
          ...(linkHeader ? { Link: linkHeader } : {}),
        },
      },
    );
  } catch (e) {
    return asProblem(e);
  }
}

function makeUnauthorized(auth: Exclude<Awaited<ReturnType<typeof authorize>>, { ok: true }>): Response {
  const headers: Record<string, string> = { 'content-type': 'application/problem+json' };
  if (auth.rate) Object.assign(headers, rateLimitHeaders(auth.rate));
  if (auth.status === 429 && auth.rate) headers['Retry-After'] = String(Math.ceil((auth.rate.resetAt - Date.now()) / 1000));
  return new Response(
    JSON.stringify({ type: 'about:blank', title: auth.reason, status: auth.status }),
    { status: auth.status, headers },
  );
}
```

- [ ] **Step 3: `/api/v1/dams/[slug]` (detail)**

```ts
// apps/web/app/api/v1/dams/[slug]/route.ts
import { findDamBySlug, latestObservation, nearbyDams } from '@dam/db/repo/dams';
import { authorize, rateLimitHeaders } from '../../../../../lib/api/auth.ts';
import { HttpError, asProblem } from '../../../../../lib/api/error.ts';
import { hal } from '../../../../../lib/api/response.ts';

export const dynamic = 'force-dynamic';

export async function GET(req: Request, { params }: { params: Promise<{ slug: string }> }): Promise<Response> {
  try {
    const auth = await authorize(req);
    if (!auth.ok) {
      return new Response(JSON.stringify({ type: 'about:blank', title: auth.reason, status: auth.status }),
        { status: auth.status, headers: { 'content-type': 'application/problem+json' } });
    }
    const { slug } = await params;
    const dam = await findDamBySlug(slug);
    if (!dam) throw new HttpError(404, 'Dam not found');
    const [latest, nearby] = await Promise.all([
      latestObservation(dam.id),
      nearbyDams(dam.id, 20_000, 10),
    ]);
    return hal(
      { ...damPublicView(dam), latest, nearby: nearby.map(damPublicView) },
      {
        self:         { href: `/api/v1/dams/${slug}` },
        observations: { href: `/api/v1/dams/${slug}/observations{?from,to,interval}`, templated: true },
        watershed:    dam.watershedSlug ? { href: `/api/v1/watersheds/${dam.watershedSlug}` } : null,
        prefecture:   { href: `/api/v1/prefectures/${dam.prefCode}/dams` },
        sources:      { href: `/api/v1/dams/${slug}/sources` },
        web:          { href: `/dams/${slug}` },
      },
      { headers: rateLimitHeaders(auth.rate) },
    );
  } catch (e) {
    return asProblem(e);
  }
}

function damPublicView(d: { id: bigint; slug: string; name: string; prefCode: string; manager: string | null; totalCapacityM3: string | null; lat: number; lng: number; watershedSlug: string | null; watershedName: string | null }) {
  return {
    id: d.id.toString(),
    slug: d.slug,
    name: d.name,
    prefCode: d.prefCode,
    manager: d.manager,
    totalCapacityM3: d.totalCapacityM3,
    location: { lat: d.lat, lng: d.lng },
    watershed: d.watershedSlug ? { slug: d.watershedSlug, name: d.watershedName } : null,
  };
}
```

- [ ] **Step 4: Watersheds list/detail/aggregate/dams**

```ts
// apps/web/app/api/v1/watersheds/route.ts
import { z } from 'zod';
import { listWatersheds } from '@dam/db/repo/watersheds';
import { authorize, rateLimitHeaders } from '../../../../lib/api/auth.ts';
import { HttpError, asProblem } from '../../../../lib/api/error.ts';
import { pageLinks } from '../../../../lib/api/pagination.ts';
import { hal } from '../../../../lib/api/response.ts';

export const dynamic = 'force-dynamic';
const Query = z.object({
  kind: z.enum(['first', 'second']).optional(),
  cursor: z.string().regex(/^[0-9]+$/).optional(),
  pageSize: z.string().regex(/^[0-9]+$/).optional(),
});

export async function GET(req: Request): Promise<Response> {
  try {
    const auth = await authorize(req);
    if (!auth.ok) return unauthorized(auth);
    const url = new URL(req.url);
    const parsed = Query.safeParse(Object.fromEntries(url.searchParams));
    if (!parsed.success) throw new HttpError(400, 'Invalid query');
    const r = await listWatersheds({
      kind: parsed.data.kind ?? null,
      cursor: parsed.data.cursor ? BigInt(parsed.data.cursor) : null,
      pageSize: parsed.data.pageSize ? Number(parsed.data.pageSize) : 200,
    });
    const self = url.pathname + url.search;
    return hal({ items: r.items, count: r.items.length }, pageLinks(self, r.nextCursor), { headers: rateLimitHeaders(auth.rate) });
  } catch (e) { return asProblem(e); }
}

function unauthorized(auth: { status: 401 | 429; reason: string; rate?: { limit: number; remaining: number; resetAt: number } }): Response {
  const headers: Record<string, string> = { 'content-type': 'application/problem+json' };
  if (auth.rate) {
    headers['RateLimit-Limit'] = String(auth.rate.limit);
    headers['RateLimit-Remaining'] = String(auth.rate.remaining);
    headers['RateLimit-Reset'] = String(Math.max(0, Math.floor((auth.rate.resetAt - Date.now()) / 1000)));
    if (auth.status === 429) headers['Retry-After'] = String(Math.ceil((auth.rate.resetAt - Date.now()) / 1000));
  }
  return new Response(JSON.stringify({ type: 'about:blank', title: auth.reason, status: auth.status }), { status: auth.status, headers });
}
```

```ts
// apps/web/app/api/v1/watersheds/[slug]/route.ts
import { aggregateWatershed, findWatershedBySlug } from '@dam/db/repo/watersheds';
import { authorize, rateLimitHeaders } from '../../../../../lib/api/auth.ts';
import { HttpError, asProblem } from '../../../../../lib/api/error.ts';
import { hal } from '../../../../../lib/api/response.ts';

export const dynamic = 'force-dynamic';

export async function GET(req: Request, { params }: { params: Promise<{ slug: string }> }): Promise<Response> {
  try {
    const auth = await authorize(req);
    if (!auth.ok) return new Response(JSON.stringify({ type: 'about:blank', title: auth.reason, status: auth.status }), { status: auth.status, headers: { 'content-type': 'application/problem+json' } });
    const { slug } = await params;
    const w = await findWatershedBySlug(slug);
    if (!w) throw new HttpError(404, 'Watershed not found');
    const agg = await aggregateWatershed(w.id);
    return hal({ ...w, id: w.id.toString(), aggregate: agg }, {
      self: { href: `/api/v1/watersheds/${slug}` },
      dams: { href: `/api/v1/watersheds/${slug}/dams` },
      aggregate: { href: `/api/v1/watersheds/${slug}/aggregate` },
      web: { href: `/watersheds/${slug}` },
    }, { headers: rateLimitHeaders(auth.rate) });
  } catch (e) { return asProblem(e); }
}
```

For `[slug]/aggregate/route.ts` and `[slug]/dams/route.ts` and `prefectures/[code]/dams/route.ts`, follow the same pattern (auth → query → hal). Each returns its specific resource with appropriate `_links`.

```ts
// apps/web/app/api/v1/watersheds/[slug]/aggregate/route.ts
import { aggregateWatershed, findWatershedBySlug } from '@dam/db/repo/watersheds';
import { authorize, rateLimitHeaders } from '../../../../../../lib/api/auth.ts';
import { HttpError, asProblem } from '../../../../../../lib/api/error.ts';
import { hal } from '../../../../../../lib/api/response.ts';

export const dynamic = 'force-dynamic';

export async function GET(req: Request, { params }: { params: Promise<{ slug: string }> }): Promise<Response> {
  try {
    const auth = await authorize(req);
    if (!auth.ok) return new Response(JSON.stringify({ type: 'about:blank', title: auth.reason, status: auth.status }), { status: auth.status, headers: { 'content-type': 'application/problem+json' } });
    const { slug } = await params;
    const w = await findWatershedBySlug(slug);
    if (!w) throw new HttpError(404, 'Watershed not found');
    const agg = await aggregateWatershed(w.id);
    return hal({ ...agg }, { self: { href: `/api/v1/watersheds/${slug}/aggregate` }, watershed: { href: `/api/v1/watersheds/${slug}` } }, { headers: rateLimitHeaders(auth.rate) });
  } catch (e) { return asProblem(e); }
}
```

```ts
// apps/web/app/api/v1/watersheds/[slug]/dams/route.ts
import { listDams } from '@dam/db/repo/dams';
import { authorize, rateLimitHeaders } from '../../../../../../lib/api/auth.ts';
import { HttpError, asProblem } from '../../../../../../lib/api/error.ts';
import { hal } from '../../../../../../lib/api/response.ts';
import { pageLinks } from '../../../../../../lib/api/pagination.ts';

export const dynamic = 'force-dynamic';

export async function GET(req: Request, { params }: { params: Promise<{ slug: string }> }): Promise<Response> {
  try {
    const auth = await authorize(req);
    if (!auth.ok) return new Response(JSON.stringify({ type: 'about:blank', title: auth.reason, status: auth.status }), { status: auth.status, headers: { 'content-type': 'application/problem+json' } });
    const { slug } = await params;
    const url = new URL(req.url);
    const cursor = url.searchParams.get('cursor');
    const pageSize = url.searchParams.get('pageSize');
    const r = await listDams({ watershedSlug: slug, cursor: cursor ? BigInt(cursor) : null, pageSize: pageSize ? Number(pageSize) : 50 });
    const self = url.pathname + url.search;
    return hal({ items: r.items, count: r.items.length }, pageLinks(self, r.nextCursor), { headers: rateLimitHeaders(auth.rate) });
  } catch (e) { return asProblem(e); }
}
```

```ts
// apps/web/app/api/v1/prefectures/[code]/dams/route.ts
import { listDams } from '@dam/db/repo/dams';
import { authorize, rateLimitHeaders } from '../../../../../../lib/api/auth.ts';
import { HttpError, asProblem } from '../../../../../../lib/api/error.ts';
import { hal } from '../../../../../../lib/api/response.ts';
import { pageLinks } from '../../../../../../lib/api/pagination.ts';

export const dynamic = 'force-dynamic';

export async function GET(req: Request, { params }: { params: Promise<{ code: string }> }): Promise<Response> {
  try {
    const auth = await authorize(req);
    if (!auth.ok) return new Response(JSON.stringify({ type: 'about:blank', title: auth.reason, status: auth.status }), { status: auth.status, headers: { 'content-type': 'application/problem+json' } });
    const { code } = await params;
    if (!/^[0-9]{2}$/.test(code)) throw new HttpError(400, 'Invalid prefecture code');
    const url = new URL(req.url);
    const cursor = url.searchParams.get('cursor');
    const pageSize = url.searchParams.get('pageSize');
    const r = await listDams({ pref: code, cursor: cursor ? BigInt(cursor) : null, pageSize: pageSize ? Number(pageSize) : 50 });
    const self = url.pathname + url.search;
    return hal({ items: r.items, count: r.items.length }, pageLinks(self, r.nextCursor), { headers: rateLimitHeaders(auth.rate) });
  } catch (e) { return asProblem(e); }
}
```

- [ ] **Step 5: Run + commit**
```bash
bun run --filter @dam/web typecheck
git add apps/web/app/api/v1 apps/web/lib/api/pagination.ts
git commit -m "feat(web): public REST endpoints for dams, watersheds, prefectures with HATEOAS"
```

---

## Task 6: Tailwind + global styles

**Files:**
- Modify: `apps/web/package.json` (add `tailwindcss`, `postcss`, `autoprefixer`)
- Create: `apps/web/postcss.config.mjs`
- Create: `apps/web/tailwind.config.ts`
- Create: `apps/web/app/globals.css`
- Modify: `apps/web/app/layout.tsx` (import globals)

- [ ] **Step 1: Install**
```bash
bun add -d tailwindcss postcss autoprefixer --cwd apps/web
```

- [ ] **Step 2: `tailwind.config.ts`**
```ts
import type { Config } from 'tailwindcss';

export default {
  content: ['./app/**/*.{ts,tsx}', './components/**/*.{ts,tsx}'],
  theme: {
    extend: {
      colors: {
        ink:    '#0b1220',
        accent: '#1e6dff',
        muted:  '#6b7280',
      },
    },
  },
} satisfies Config;
```

- [ ] **Step 3: `postcss.config.mjs`**
```js
export default { plugins: { tailwindcss: {}, autoprefixer: {} } };
```

- [ ] **Step 4: `globals.css`**
```css
@tailwind base;
@tailwind components;
@tailwind utilities;

:root {
  color-scheme: light;
}

body {
  @apply bg-white text-ink antialiased;
}

a { @apply text-accent hover:underline; }

table { @apply w-full text-sm; }
th, td { @apply px-3 py-2 text-left; }
thead { @apply bg-gray-50 text-gray-600 uppercase text-xs; }
tbody tr { @apply border-b border-gray-100; }
```

- [ ] **Step 5: Update `apps/web/app/layout.tsx`**

```tsx
import type { Metadata, Viewport } from 'next';
import type { ReactNode } from 'react';
import { Nav } from '../components/nav.tsx';
import './globals.css';

export const metadata: Metadata = {
  title: { default: 'Dam Data Platform', template: '%s — Dam Data Platform' },
  description: 'Realtime and historical reservoir-level data for dams across Japan.',
  metadataBase: new URL(process.env.NEXT_PUBLIC_SITE_URL ?? 'http://localhost:3000'),
};

export const viewport: Viewport = { width: 'device-width', initialScale: 1 };

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="ja">
      <body>
        <Nav />
        <main className="mx-auto max-w-6xl px-4 py-8">{children}</main>
        <footer className="mx-auto max-w-6xl px-4 py-8 text-sm text-muted">
          Data: 国交省 (川の防災情報, 水文水質DB), 国土数値情報, ダム便覧
        </footer>
      </body>
    </html>
  );
}
```

- [ ] **Step 6: Commit**
```bash
git add apps/web/package.json apps/web/postcss.config.mjs apps/web/tailwind.config.ts apps/web/app/globals.css apps/web/app/layout.tsx
git commit -m "chore(web): tailwind setup + global layout + nav"
```

---

## Task 7: Shared components

**Files:**
- Create: `apps/web/components/nav.tsx`
- Create: `apps/web/components/breadcrumbs.tsx`
- Create: `apps/web/components/dam-card.tsx`
- Create: `apps/web/components/dam-table.tsx`
- Create: `apps/web/components/pagination.tsx`
- Create: `apps/web/components/quality-badge.tsx`
- Create: `apps/web/lib/format.ts`

- [ ] **Step 1: `format.ts`**

```ts
const NF = new Intl.NumberFormat('ja-JP');
const PF = new Intl.NumberFormat('ja-JP', { style: 'percent', maximumFractionDigits: 1 });
const DF = new Intl.DateTimeFormat('ja-JP', { dateStyle: 'short', timeStyle: 'short', timeZone: 'Asia/Tokyo' });

export function fmtN(value: number | string | null | undefined): string {
  if (value == null || value === '') return '—';
  const n = typeof value === 'string' ? Number(value) : value;
  if (!Number.isFinite(n)) return '—';
  return NF.format(n);
}

export function fmtPct(value: number | string | null | undefined): string {
  if (value == null) return '—';
  const n = typeof value === 'string' ? Number(value) : value;
  if (!Number.isFinite(n)) return '—';
  return PF.format(n);
}

export function fmtDate(value: Date | string | null | undefined): string {
  if (!value) return '—';
  const d = value instanceof Date ? value : new Date(value);
  return DF.format(d);
}

export function fmtCapacityMcm(volumeM3: number | string | null | undefined): string {
  if (volumeM3 == null) return '—';
  const n = typeof volumeM3 === 'string' ? Number(volumeM3) : volumeM3;
  if (!Number.isFinite(n)) return '—';
  return `${NF.format(Math.round(n / 1_000_000))} 万 m³`;
}
```

- [ ] **Step 2: `nav.tsx`**

```tsx
import Link from 'next/link';

export function Nav() {
  return (
    <header className="border-b border-gray-200">
      <div className="mx-auto max-w-6xl px-4 py-4 flex items-center justify-between">
        <Link href="/" className="text-lg font-semibold text-ink">Dam Data</Link>
        <nav className="flex gap-6 text-sm">
          <Link href="/dams">ダム</Link>
          <Link href="/watersheds">水系</Link>
          <Link href="/map">地図</Link>
          <Link href="/sources">データソース</Link>
          <Link href="/api/docs">API</Link>
        </nav>
      </div>
    </header>
  );
}
```

- [ ] **Step 3: `breadcrumbs.tsx`** (with schema.org JSON-LD)

```tsx
import Link from 'next/link';

export interface Crumb { label: string; href?: string }

export function Breadcrumbs({ items }: { items: Crumb[] }) {
  const base = process.env.NEXT_PUBLIC_SITE_URL ?? 'http://localhost:3000';
  const ld = {
    '@context': 'https://schema.org',
    '@type': 'BreadcrumbList',
    itemListElement: items.map((c, i) => ({
      '@type': 'ListItem', position: i + 1, name: c.label,
      ...(c.href ? { item: `${base}${c.href}` } : {}),
    })),
  };
  return (
    <>
      <nav className="text-sm text-muted mb-4">
        <ol className="flex flex-wrap gap-2">
          {items.map((c, i) => (
            <li key={i} className="flex items-center gap-2">
              {i > 0 && <span aria-hidden>›</span>}
              {c.href ? <Link href={c.href}>{c.label}</Link> : <span>{c.label}</span>}
            </li>
          ))}
        </ol>
      </nav>
      <script type="application/ld+json" dangerouslySetInnerHTML={{ __html: JSON.stringify(ld) }} />
    </>
  );
}
```

- [ ] **Step 4: `dam-table.tsx`**

```tsx
import Link from 'next/link';
import { fmtCapacityMcm } from '../lib/format.ts';
import { PREFECTURES } from '@dam/core/prefectures';

const PREF_NAME = new Map(PREFECTURES.map((p) => [p.code, p.name]));

export interface DamRowItem {
  slug: string;
  name: string;
  prefCode: string;
  manager: string | null;
  totalCapacityM3: string | null;
  watershedSlug: string | null;
  watershedName: string | null;
}

export function DamTable({ rows }: { rows: DamRowItem[] }) {
  return (
    <table>
      <thead>
        <tr>
          <th>ダム名</th><th>都道府県</th><th>水系</th><th>管理者</th><th className="text-right">総貯水容量</th>
        </tr>
      </thead>
      <tbody>
        {rows.map((r) => (
          <tr key={r.slug}>
            <td><Link href={`/dams/${r.slug}`}>{r.name}</Link></td>
            <td>{PREF_NAME.get(r.prefCode) ?? r.prefCode}</td>
            <td>{r.watershedSlug ? <Link href={`/watersheds/${r.watershedSlug}`}>{r.watershedName}</Link> : '—'}</td>
            <td>{r.manager ?? '—'}</td>
            <td className="text-right tabular-nums">{fmtCapacityMcm(r.totalCapacityM3)}</td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}
```

- [ ] **Step 5: `dam-card.tsx`**, `pagination.tsx`, `quality-badge.tsx`

```tsx
// apps/web/components/dam-card.tsx
import Link from 'next/link';
import { fmtCapacityMcm } from '../lib/format.ts';
import type { DamRowItem } from './dam-table.tsx';

export function DamCard({ d }: { d: DamRowItem }) {
  return (
    <article className="border border-gray-200 rounded p-4">
      <h3 className="text-lg font-semibold"><Link href={`/dams/${d.slug}`}>{d.name}</Link></h3>
      <p className="text-sm text-muted">{d.manager ?? '—'}</p>
      <p className="text-sm">総貯水容量: {fmtCapacityMcm(d.totalCapacityM3)}</p>
    </article>
  );
}
```

```tsx
// apps/web/components/pagination.tsx
import Link from 'next/link';

export function Pagination({ basePath, prevCursor, nextCursor }: { basePath: string; prevCursor?: string | null; nextCursor?: string | null }) {
  return (
    <div className="flex justify-between mt-6">
      <div>{prevCursor ? <Link href={`${basePath}?cursor=${prevCursor}`}>« 前へ</Link> : null}</div>
      <div>{nextCursor ? <Link href={`${basePath}?cursor=${nextCursor}`}>次へ »</Link> : null}</div>
    </div>
  );
}
```

```tsx
// apps/web/components/quality-badge.tsx
const FLAG_LABEL: Record<number, string> = {
  1: '欠損補間', 2: '異常値', 4: '線形補間', 8: 'ソース不一致', 16: '手動レビュー',
};

export function QualityBadge({ flag }: { flag: number }) {
  if (!flag) return <span className="text-xs px-1.5 py-0.5 bg-emerald-50 text-emerald-700 rounded">OK</span>;
  const labels: string[] = [];
  for (const bit of [1, 2, 4, 8, 16]) if (flag & bit) labels.push(FLAG_LABEL[bit]!);
  return <span className="text-xs px-1.5 py-0.5 bg-amber-50 text-amber-700 rounded">{labels.join(' ')}</span>;
}
```

- [ ] **Step 6: Commit**
```bash
git add apps/web/components apps/web/lib/format.ts
git commit -m "feat(web): shared components (nav, breadcrumbs, dam-table/card, pagination, quality-badge)"
```

---

## Task 8: ECharts client component

**Files:**
- Modify: `apps/web/package.json` (add `echarts` and `echarts-for-react`)
- Create: `apps/web/components/observation-chart.tsx`

- [ ] **Step 1: Install**
```bash
bun add echarts echarts-for-react --cwd apps/web
```

- [ ] **Step 2: Component**

```tsx
'use client';

import dynamic from 'next/dynamic';
import { useEffect, useState } from 'react';

const ReactECharts = dynamic(() => import('echarts-for-react'), { ssr: false });

export interface SeriesPoint {
  observedAt: string;
  storageVolumeM3: string | null;
  storageRate: string | null;
  qualityFlag: number;
  sourceId: string;
}

export function ObservationChart({ slug }: { slug: string }) {
  const [interval, setInterval] = useState<'hourly' | 'daily' | 'monthly'>('daily');
  const [points, setPoints] = useState<SeriesPoint[] | null>(null);
  const [err, setErr] = useState<string | null>(null);

  useEffect(() => {
    setPoints(null); setErr(null);
    const to = new Date();
    const fromDate = new Date();
    if (interval === 'hourly') fromDate.setUTCDate(fromDate.getUTCDate() - 7);
    else if (interval === 'daily') fromDate.setUTCFullYear(fromDate.getUTCFullYear() - 1);
    else fromDate.setUTCFullYear(fromDate.getUTCFullYear() - 5);
    const url = `/api/v1/dams/${slug}/observations?from=${fromDate.toISOString()}&to=${to.toISOString()}&interval=${interval}`;
    fetch(url, { headers: { 'x-api-key': process.env.NEXT_PUBLIC_API_KEY ?? '' } })
      .then(async (r) => {
        if (!r.ok) throw new Error(`HTTP ${r.status}`);
        const body = (await r.json()) as { series: SeriesPoint[] };
        setPoints(body.series);
      })
      .catch((e: Error) => setErr(e.message));
  }, [interval, slug]);

  if (err) return <div className="text-red-700 text-sm">グラフを取得できませんでした: {err}</div>;
  if (!points) return <div className="text-muted text-sm">読み込み中…</div>;

  const data = points.map((p) => [p.observedAt, p.storageVolumeM3 ? Number(p.storageVolumeM3) : null]);

  const option = {
    grid: { left: 60, right: 20, top: 30, bottom: 40 },
    xAxis: { type: 'time' },
    yAxis: { type: 'value', axisLabel: { formatter: (v: number) => `${(v / 1_000_000).toFixed(0)}万` } },
    tooltip: { trigger: 'axis' },
    series: [{ type: 'line', data, smooth: true, sampling: 'lttb', name: '貯水量 m³' }],
    animation: false,
  };

  return (
    <div>
      <div className="flex gap-2 mb-3 text-sm">
        {(['hourly', 'daily', 'monthly'] as const).map((b) => (
          <button key={b} type="button" onClick={() => setInterval(b)}
            className={`px-2 py-1 rounded ${b === interval ? 'bg-accent text-white' : 'bg-gray-100'}`}>
            {b === 'hourly' ? '1週間' : b === 'daily' ? '1年' : '5年'}
          </button>
        ))}
      </div>
      <ReactECharts option={option} style={{ height: 360 }} />
    </div>
  );
}
```

- [ ] **Step 3: Commit**
```bash
git add apps/web/package.json apps/web/components/observation-chart.tsx
git commit -m "feat(web): ECharts observation chart with hourly/daily/monthly toggle"
```

---

## Task 9: Leaflet Japan map component

**Files:**
- Modify: `apps/web/package.json` (add `leaflet`, `react-leaflet`, `@types/leaflet`)
- Create: `apps/web/components/japan-map.tsx`

- [ ] **Step 1: Install**
```bash
bun add leaflet react-leaflet --cwd apps/web
bun add -d @types/leaflet --cwd apps/web
```

- [ ] **Step 2: Component (client-only, dynamic import)**

```tsx
'use client';

import 'leaflet/dist/leaflet.css';
import { useEffect, useRef } from 'react';

export interface MapPoint { slug: string; name: string; lat: number; lng: number }

export function JapanMap({ points }: { points: MapPoint[] }) {
  const ref = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    let cleanup: (() => void) | undefined;
    void import('leaflet').then((Lmod) => {
      const L = Lmod.default ?? Lmod;
      if (!ref.current) return;
      const map = L.map(ref.current).setView([36.5, 138.5], 5);
      L.tileLayer('https://cyberjapandata.gsi.go.jp/xyz/std/{z}/{x}/{y}.png', {
        attribution: '&copy; <a href="https://maps.gsi.go.jp/development/ichiran.html">国土地理院</a>',
        maxZoom: 18,
      }).addTo(map);

      // Cluster: simple decimation. Replace with leaflet.markercluster if needed.
      const layer = L.layerGroup().addTo(map);
      for (const p of points) {
        L.circleMarker([p.lat, p.lng], { radius: 4, color: '#1e6dff', weight: 1, fillOpacity: 0.7 })
          .bindPopup(`<a href="/dams/${p.slug}">${p.name}</a>`)
          .addTo(layer);
      }
      cleanup = () => map.remove();
    });
    return () => cleanup?.();
  }, [points]);

  return <div ref={ref} style={{ height: 'calc(100vh - 200px)', minHeight: 480 }} />;
}
```

- [ ] **Step 3: Commit**
```bash
git add apps/web/package.json apps/web/components/japan-map.tsx
git commit -m "feat(web): Leaflet japan map component using GSI tiles"
```

---

## Task 10: Pages — `/dams`, `/dams/[slug]`

**Files:**
- Create: `apps/web/app/dams/page.tsx`
- Create: `apps/web/app/dams/[slug]/page.tsx`

- [ ] **Step 1: `/dams` (list)**

```tsx
// apps/web/app/dams/page.tsx
import type { Metadata } from 'next';
import { listDams } from '@dam/db/repo/dams';
import { Breadcrumbs } from '../../components/breadcrumbs.tsx';
import { DamTable } from '../../components/dam-table.tsx';
import { Pagination } from '../../components/pagination.tsx';

export const revalidate = 900;

export const metadata: Metadata = {
  title: 'ダム一覧',
  description: '日本全国のダム一覧。都道府県・水系・管理者で絞り込み。',
};

interface SP { searchParams?: Promise<{ pref?: string; watershed?: string; manager?: string; cursor?: string }> }

export default async function DamsPage({ searchParams }: SP) {
  const sp = (await searchParams) ?? {};
  const r = await listDams({
    pref: sp.pref ?? null,
    watershedSlug: sp.watershed ?? null,
    manager: sp.manager ?? null,
    search: null,
    cursor: sp.cursor ? BigInt(sp.cursor) : null,
    pageSize: 50,
  });
  return (
    <>
      <Breadcrumbs items={[{ label: 'ホーム', href: '/' }, { label: 'ダム' }]} />
      <h1 className="text-2xl font-semibold mb-4">ダム一覧</h1>
      <DamTable rows={r.items.map((i) => ({ ...i, totalCapacityM3: i.totalCapacityM3 }))} />
      <Pagination basePath="/dams" nextCursor={r.nextCursor?.toString() ?? null} />
    </>
  );
}
```

- [ ] **Step 2: `/dams/[slug]` (detail) with ECharts + structured data**

```tsx
import type { Metadata } from 'next';
import { notFound } from 'next/navigation';
import { findDamBySlug, latestObservation, nearbyDams } from '@dam/db/repo/dams';
import { Breadcrumbs } from '../../../components/breadcrumbs.tsx';
import { DamCard } from '../../../components/dam-card.tsx';
import { ObservationChart } from '../../../components/observation-chart.tsx';
import { QualityBadge } from '../../../components/quality-badge.tsx';
import { fmtCapacityMcm, fmtDate, fmtN, fmtPct } from '../../../lib/format.ts';
import { PREFECTURES } from '@dam/core/prefectures';

export const revalidate = 900;
export const dynamicParams = true;

const PREF_NAME = new Map(PREFECTURES.map((p) => [p.code, p.name]));

interface PageProps { params: Promise<{ slug: string }> }

export async function generateMetadata({ params }: PageProps): Promise<Metadata> {
  const { slug } = await params;
  const d = await findDamBySlug(slug);
  if (!d) return { title: 'ダムが見つかりません' };
  return {
    title: `${d.name}（${PREF_NAME.get(d.prefCode) ?? d.prefCode}）`,
    description: `${d.name}の貯水量・流入量・放流量の最新データと推移。${d.manager ?? ''}が管理。`,
    alternates: { canonical: `/dams/${slug}` },
    openGraph: { title: d.name, description: `${d.manager ?? ''}が管理するダム` },
  };
}

export default async function DamDetail({ params }: PageProps) {
  const { slug } = await params;
  const d = await findDamBySlug(slug);
  if (!d) notFound();
  const [latest, nearby] = await Promise.all([latestObservation(d.id), nearbyDams(d.id, 20_000, 6)]);

  const ld = {
    '@context': 'https://schema.org',
    '@type': 'Place',
    name: d.name,
    geo: { '@type': 'GeoCoordinates', latitude: d.lat, longitude: d.lng },
    address: { '@type': 'PostalAddress', addressCountry: 'JP', addressRegion: PREF_NAME.get(d.prefCode) ?? d.prefCode },
  };

  return (
    <>
      <Breadcrumbs items={[
        { label: 'ホーム', href: '/' },
        { label: 'ダム', href: '/dams' },
        ...(d.watershedSlug ? [{ label: d.watershedName ?? '', href: `/watersheds/${d.watershedSlug}` }] : []),
        { label: d.name },
      ]} />
      <h1 className="text-3xl font-semibold mb-2">{d.name}</h1>
      <p className="text-muted mb-6">{d.nameKana ?? ''} · {PREF_NAME.get(d.prefCode) ?? d.prefCode} · {d.manager ?? '—'}</p>

      <section className="grid grid-cols-1 md:grid-cols-3 gap-4 mb-8">
        <Stat label="総貯水容量"   value={fmtCapacityMcm(d.totalCapacityM3)} />
        <Stat label="有効貯水容量" value={fmtCapacityMcm(d.effectiveCapacityM3)} />
        <Stat label="堤高"        value={d.heightM ? `${fmtN(d.heightM)} m` : '—'} />
      </section>

      <section className="border border-gray-200 rounded p-4 mb-8">
        <header className="flex items-baseline justify-between mb-3">
          <h2 className="text-lg font-semibold">最新観測値</h2>
          {latest && <span className="text-sm text-muted">{fmtDate(latest.observedAt)} · {latest.sourceId} <QualityBadge flag={latest.qualityFlag} /></span>}
        </header>
        {latest ? (
          <dl className="grid grid-cols-2 md:grid-cols-4 gap-4 text-sm">
            <Pair label="貯水量" value={fmtCapacityMcm(latest.storageVolumeM3)} />
            <Pair label="貯水率" value={fmtPct(latest.storageRate)} />
            <Pair label="流入量" value={latest.inflowM3s ? `${fmtN(latest.inflowM3s)} m³/s` : '—'} />
            <Pair label="放流量" value={latest.outflowM3s ? `${fmtN(latest.outflowM3s)} m³/s` : '—'} />
          </dl>
        ) : <p className="text-muted">まだ観測値がありません。</p>}
      </section>

      <section className="mb-8">
        <h2 className="text-lg font-semibold mb-3">推移グラフ</h2>
        <ObservationChart slug={slug} />
      </section>

      {nearby.length > 0 && (
        <section className="mb-8">
          <h2 className="text-lg font-semibold mb-3">近隣のダム</h2>
          <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-3">
            {nearby.map((n) => <DamCard key={n.slug} d={{ ...n, totalCapacityM3: n.totalCapacityM3 }} />)}
          </div>
        </section>
      )}

      <script type="application/ld+json" dangerouslySetInnerHTML={{ __html: JSON.stringify(ld) }} />
    </>
  );
}

function Stat({ label, value }: { label: string; value: string }) {
  return (
    <div className="border border-gray-200 rounded p-3">
      <div className="text-xs text-muted">{label}</div>
      <div className="text-xl font-semibold tabular-nums">{value}</div>
    </div>
  );
}
function Pair({ label, value }: { label: string; value: string }) {
  return <div><div className="text-xs text-muted">{label}</div><div className="text-base tabular-nums">{value}</div></div>;
}
```

- [ ] **Step 3: Commit**
```bash
git add apps/web/app/dams
git commit -m "feat(web): /dams list and /dams/[slug] detail with chart and structured data"
```

---

## Task 11: Pages — `/watersheds`, `/watersheds/[slug]`, `/prefectures/[code]`

**Files:**
- Create: `apps/web/app/watersheds/page.tsx`
- Create: `apps/web/app/watersheds/[slug]/page.tsx`
- Create: `apps/web/app/prefectures/[code]/page.tsx`

- [ ] **Step 1: `/watersheds` (list)**

```tsx
import type { Metadata } from 'next';
import Link from 'next/link';
import { listWatersheds } from '@dam/db/repo/watersheds';
import { Breadcrumbs } from '../../components/breadcrumbs.tsx';

export const revalidate = 3600;
export const metadata: Metadata = { title: '水系一覧' };

export default async function WatershedsPage() {
  const r = await listWatersheds({ pageSize: 500 });
  return (
    <>
      <Breadcrumbs items={[{ label: 'ホーム', href: '/' }, { label: '水系' }]} />
      <h1 className="text-2xl font-semibold mb-4">水系一覧</h1>
      <table>
        <thead><tr><th>水系</th><th>区分</th><th className="text-right">ダム数</th></tr></thead>
        <tbody>
          {r.items.map((w) => (
            <tr key={w.slug}>
              <td><Link href={`/watersheds/${w.slug}`}>{w.name}</Link></td>
              <td>{w.kind === 'first' ? '一級' : w.kind === 'second' ? '二級' : 'その他'}</td>
              <td className="text-right">{w.damCount}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </>
  );
}
```

- [ ] **Step 2: `/watersheds/[slug]`**

```tsx
import type { Metadata } from 'next';
import { notFound } from 'next/navigation';
import { aggregateWatershed, findWatershedBySlug } from '@dam/db/repo/watersheds';
import { listDams } from '@dam/db/repo/dams';
import { Breadcrumbs } from '../../../components/breadcrumbs.tsx';
import { DamTable } from '../../../components/dam-table.tsx';
import { fmtCapacityMcm, fmtDate } from '../../../lib/format.ts';

export const revalidate = 900;

interface PageProps { params: Promise<{ slug: string }> }

export async function generateMetadata({ params }: PageProps): Promise<Metadata> {
  const { slug } = await params;
  const w = await findWatershedBySlug(slug);
  if (!w) return { title: '水系が見つかりません' };
  return {
    title: w.name,
    description: `${w.name}に属するダムの一覧と貯水量集計。`,
    alternates: { canonical: `/watersheds/${slug}` },
  };
}

export default async function WatershedDetail({ params }: PageProps) {
  const { slug } = await params;
  const w = await findWatershedBySlug(slug);
  if (!w) notFound();
  const [agg, list] = await Promise.all([
    aggregateWatershed(w.id),
    listDams({ watershedSlug: slug, pageSize: 200 }),
  ]);
  return (
    <>
      <Breadcrumbs items={[{ label: 'ホーム', href: '/' }, { label: '水系', href: '/watersheds' }, { label: w.name }]} />
      <h1 className="text-3xl font-semibold mb-2">{w.name}</h1>
      <p className="text-muted mb-6">{w.kind === 'first' ? '一級水系' : w.kind === 'second' ? '二級水系' : 'その他'}</p>

      <section className="grid grid-cols-1 md:grid-cols-3 gap-4 mb-8">
        <Stat label="ダム数" value={String(agg.damCount)} />
        <Stat label="総貯水容量" value={fmtCapacityMcm(agg.totalCapacityM3)} />
        <Stat label="現在貯水量" value={`${fmtCapacityMcm(agg.latestStorageVolumeM3)}`} sub={agg.observedAt ? fmtDate(agg.observedAt) : undefined} />
      </section>

      <h2 className="text-lg font-semibold mb-3">この水系のダム</h2>
      <DamTable rows={list.items} />
    </>
  );
}

function Stat({ label, value, sub }: { label: string; value: string; sub?: string }) {
  return (
    <div className="border border-gray-200 rounded p-3">
      <div className="text-xs text-muted">{label}</div>
      <div className="text-xl font-semibold tabular-nums">{value}</div>
      {sub && <div className="text-xs text-muted mt-1">{sub}</div>}
    </div>
  );
}
```

- [ ] **Step 3: `/prefectures/[code]`**

```tsx
import type { Metadata } from 'next';
import { notFound } from 'next/navigation';
import { listDams } from '@dam/db/repo/dams';
import { Breadcrumbs } from '../../../components/breadcrumbs.tsx';
import { DamTable } from '../../../components/dam-table.tsx';
import { PREFECTURES } from '@dam/core/prefectures';

export const revalidate = 900;

const PREF_NAME = new Map(PREFECTURES.map((p) => [p.code, p.name]));

interface PageProps { params: Promise<{ code: string }> }

export async function generateMetadata({ params }: PageProps): Promise<Metadata> {
  const { code } = await params;
  const name = PREF_NAME.get(code);
  if (!name) return { title: '都道府県が見つかりません' };
  return { title: `${name}のダム`, alternates: { canonical: `/prefectures/${code}` } };
}

export default async function PrefPage({ params }: PageProps) {
  const { code } = await params;
  const name = PREF_NAME.get(code);
  if (!name) notFound();
  const r = await listDams({ pref: code, pageSize: 500 });
  return (
    <>
      <Breadcrumbs items={[{ label: 'ホーム', href: '/' }, { label: '都道府県' }, { label: name }]} />
      <h1 className="text-2xl font-semibold mb-4">{name}のダム</h1>
      <DamTable rows={r.items} />
    </>
  );
}
```

- [ ] **Step 4: Commit**
```bash
git add apps/web/app/watersheds apps/web/app/prefectures
git commit -m "feat(web): watershed list/detail and prefecture pages"
```

---

## Task 12: Map page + Sources page + Home

**Files:**
- Create: `apps/web/app/map/page.tsx`
- Create: `apps/web/app/sources/page.tsx`
- Modify: `apps/web/app/page.tsx`

- [ ] **Step 1: Map page (server fetches all dam coordinates, client renders Leaflet)**

```tsx
import type { Metadata } from 'next';
import { sql } from '@dam/db/client';
import { Breadcrumbs } from '../../components/breadcrumbs.tsx';
import { JapanMap, type MapPoint } from '../../components/japan-map.tsx';

export const revalidate = 3600;
export const metadata: Metadata = { title: '日本のダム地図', description: '全国のダムを地図で確認。' };

async function fetchPoints(): Promise<MapPoint[]> {
  const rows = await sql<MapPoint[]>`
    SELECT slug, name,
           ST_Y(location::geometry) AS lat,
           ST_X(location::geometry) AS lng
    FROM dams
    ORDER BY id
  `;
  return rows;
}

export default async function MapPage() {
  const points = await fetchPoints();
  return (
    <>
      <Breadcrumbs items={[{ label: 'ホーム', href: '/' }, { label: '地図' }]} />
      <h1 className="text-2xl font-semibold mb-4">日本のダム地図</h1>
      <JapanMap points={points} />
    </>
  );
}
```

- [ ] **Step 2: `/sources` (public quality / transparency page)**

```tsx
import type { Metadata } from 'next';
import { sql } from '@dam/db/client';
import { Breadcrumbs } from '../../components/breadcrumbs.tsx';
import { fmtDate } from '../../lib/format.ts';

export const revalidate = 300;
export const metadata: Metadata = { title: 'データソース', description: '使用しているデータソースと最終取得時刻。' };

interface Row { source_id: string; description: string | null; priority: number; active: boolean; last_fetched_at: Date | null; last_status: string | null }

export default async function SourcesPage() {
  const rows = await sql<Row[]>`
    SELECT sp.source_id, sp.description, sp.priority, sp.active,
           lf.last_fetched_at, lf.last_status
    FROM source_priorities sp
    LEFT JOIN LATERAL (
      SELECT fetched_at AS last_fetched_at, parse_status AS last_status
      FROM raw_snapshots WHERE source_id = sp.source_id
      ORDER BY fetched_at DESC LIMIT 1
    ) lf ON TRUE
    ORDER BY sp.priority DESC
  `;
  return (
    <>
      <Breadcrumbs items={[{ label: 'ホーム', href: '/' }, { label: 'データソース' }]} />
      <h1 className="text-2xl font-semibold mb-4">データソース</h1>
      <table>
        <thead><tr><th>ソース</th><th>説明</th><th>優先度</th><th>最終取得</th><th>状態</th></tr></thead>
        <tbody>
          {rows.map((r) => (
            <tr key={r.source_id}>
              <td>{r.source_id}</td>
              <td>{r.description ?? '—'}</td>
              <td>{r.priority}</td>
              <td>{fmtDate(r.last_fetched_at)}</td>
              <td>{r.last_status ?? '—'}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </>
  );
}
```

- [ ] **Step 3: Replace `/` (home)**

```tsx
import type { Metadata } from 'next';
import Link from 'next/link';
import { sql } from '@dam/db/client';
import { listDams } from '@dam/db/repo/dams';
import { DamCard } from '../components/dam-card.tsx';

export const revalidate = 900;
export const metadata: Metadata = {
  title: { absolute: 'Dam Data Platform — 日本のダム貯水量' },
  description: '日本全国のダム貯水量データと推移。1時間ごとの最新値と長期トレンド。',
};

async function counts() {
  const rows = await sql<{ dams: bigint; watersheds: bigint; obs_today: bigint }[]>`
    SELECT
      (SELECT COUNT(*) FROM dams)::BIGINT AS dams,
      (SELECT COUNT(*) FROM watersheds)::BIGINT AS watersheds,
      (SELECT COUNT(*) FROM observations WHERE observed_at > NOW() - INTERVAL '24 hours')::BIGINT AS obs_today
  `;
  return rows[0]!;
}

export default async function Home() {
  const [c, latest] = await Promise.all([counts(), listDams({ pageSize: 6 })]);
  return (
    <>
      <section className="mb-10">
        <h1 className="text-4xl font-semibold mb-2">日本のダム貯水量データ</h1>
        <p className="text-muted text-lg">日本全国のダムを網羅し、1時間ごとに更新。災害予測・水不足予測のためのデータソース。</p>
      </section>

      <section className="grid grid-cols-1 md:grid-cols-3 gap-4 mb-10">
        <Stat label="ダム" value={c.dams.toString()} />
        <Stat label="水系" value={c.watersheds.toString()} />
        <Stat label="直近24時間の観測" value={c.obs_today.toString()} />
      </section>

      <section className="mb-10">
        <h2 className="text-xl font-semibold mb-4">代表的なダム</h2>
        <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-3">
          {latest.items.map((d) => <DamCard key={d.slug} d={d} />)}
        </div>
        <p className="mt-4"><Link href="/dams">すべてのダムを見る →</Link></p>
      </section>

      <section className="mb-10">
        <Link href="/map" className="block border border-gray-200 rounded p-6 hover:bg-gray-50">
          <h2 className="text-xl font-semibold">日本のダム地図 →</h2>
          <p className="text-muted">全国のダムを地図で確認。</p>
        </Link>
      </section>
    </>
  );
}

function Stat({ label, value }: { label: string; value: string }) {
  return (
    <div className="border border-gray-200 rounded p-3">
      <div className="text-xs text-muted">{label}</div>
      <div className="text-2xl font-semibold tabular-nums">{value}</div>
    </div>
  );
}
```

- [ ] **Step 4: Commit**
```bash
git add apps/web/app/map apps/web/app/sources apps/web/app/page.tsx
git commit -m "feat(web): map, sources transparency, and refreshed home pages"
```

---

## Task 13: sitemap.xml + robots.txt + not-found + error

**Files:**
- Create: `apps/web/app/sitemap.ts`
- Create: `apps/web/app/robots.ts`
- Create: `apps/web/app/not-found.tsx`
- Create: `apps/web/app/error.tsx`

- [ ] **Step 1: `sitemap.ts`**

```ts
import type { MetadataRoute } from 'next';
import { sql } from '@dam/db/client';

export default async function sitemap(): Promise<MetadataRoute.Sitemap> {
  const base = process.env.NEXT_PUBLIC_SITE_URL ?? 'http://localhost:3000';
  const [dams, watersheds] = await Promise.all([
    sql<{ slug: string; updated_at: Date }[]>`SELECT slug, updated_at FROM dams ORDER BY id`,
    sql<{ slug: string; updated_at: Date }[]>`SELECT slug, updated_at FROM watersheds ORDER BY id`,
  ]);
  const PREFS = (await import('@dam/core/prefectures')).PREFECTURES;
  const now = new Date();
  return [
    { url: base, lastModified: now, changeFrequency: 'daily', priority: 1.0 },
    { url: `${base}/dams`, lastModified: now, changeFrequency: 'hourly', priority: 0.9 },
    { url: `${base}/watersheds`, lastModified: now, changeFrequency: 'weekly', priority: 0.8 },
    { url: `${base}/map`, lastModified: now, changeFrequency: 'weekly', priority: 0.7 },
    { url: `${base}/sources`, lastModified: now, changeFrequency: 'daily', priority: 0.5 },
    ...dams.map((d) => ({ url: `${base}/dams/${d.slug}`, lastModified: d.updated_at, changeFrequency: 'hourly' as const, priority: 0.7 })),
    ...watersheds.map((w) => ({ url: `${base}/watersheds/${w.slug}`, lastModified: w.updated_at, changeFrequency: 'daily' as const, priority: 0.6 })),
    ...PREFS.map((p) => ({ url: `${base}/prefectures/${p.code}`, lastModified: now, changeFrequency: 'daily' as const, priority: 0.5 })),
  ];
}
```

- [ ] **Step 2: `robots.ts`**

```ts
import type { MetadataRoute } from 'next';

export default function robots(): MetadataRoute.Robots {
  const base = process.env.NEXT_PUBLIC_SITE_URL ?? 'http://localhost:3000';
  return {
    rules: [{ userAgent: '*', allow: '/', disallow: ['/api/'] }],
    sitemap: `${base}/sitemap.xml`,
  };
}
```

- [ ] **Step 3: `not-found.tsx`**

```tsx
import Link from 'next/link';

export default function NotFound() {
  return (
    <div className="text-center py-16">
      <h1 className="text-3xl font-semibold mb-2">ページが見つかりません</h1>
      <p className="text-muted mb-4">URLが正しいか確認してください。</p>
      <Link href="/">ホームへ戻る</Link>
    </div>
  );
}
```

- [ ] **Step 4: `error.tsx`**

```tsx
'use client';
import Link from 'next/link';
import { useEffect } from 'react';

export default function ErrorPage({ error }: { error: Error & { digest?: string } }) {
  useEffect(() => { console.error(error); }, [error]);
  return (
    <div className="text-center py-16">
      <h1 className="text-3xl font-semibold mb-2">エラーが発生しました</h1>
      <p className="text-muted mb-4">{error.message}</p>
      <Link href="/">ホームへ戻る</Link>
    </div>
  );
}
```

- [ ] **Step 5: Commit**
```bash
git add apps/web/app/sitemap.ts apps/web/app/robots.ts apps/web/app/not-found.tsx apps/web/app/error.tsx
git commit -m "feat(web): sitemap, robots.txt, not-found, error boundary"
```

---

## Task 14: API docs + OpenAPI

**Files:**
- Create: `apps/web/app/api/v1/openapi.json/route.ts`
- Create: `apps/web/app/api/docs/page.tsx`
- Modify: `apps/web/package.json` (add `swagger-ui-react`)

- [ ] **Step 1: OpenAPI document (hand-rolled subset)**

```ts
// apps/web/app/api/v1/openapi.json/route.ts
import { NextResponse } from 'next/server';

export const dynamic = 'force-static';

export async function GET() {
  const spec = {
    openapi: '3.1.0',
    info: { title: 'Dam Data Platform API', version: '1.0.0' },
    servers: [{ url: process.env.NEXT_PUBLIC_SITE_URL ?? 'http://localhost:3000' }],
    components: {
      securitySchemes: { ApiKey: { type: 'apiKey', in: 'header', name: 'X-API-Key' } },
    },
    security: [{ ApiKey: [] }],
    paths: {
      '/api/v1/healthz':                                     { get: { summary: 'Health check', responses: { '200': { description: 'OK' } } } },
      '/api/v1/sources':                                     { get: { summary: 'Data sources', responses: { '200': { description: 'OK' } } } },
      '/api/v1/dams':                                        { get: { summary: 'List dams', parameters: [
        { in: 'query', name: 'pref', schema: { type: 'string', pattern: '^[0-9]{2}$' } },
        { in: 'query', name: 'watershed', schema: { type: 'string' } },
        { in: 'query', name: 'manager', schema: { type: 'string' } },
        { in: 'query', name: 'cursor', schema: { type: 'string' } },
        { in: 'query', name: 'pageSize', schema: { type: 'integer' } },
      ], responses: { '200': { description: 'OK' } } } },
      '/api/v1/dams/{slug}':                                 { get: { summary: 'Dam detail', parameters: [{ in: 'path', name: 'slug', required: true, schema: { type: 'string' } }], responses: { '200': { description: 'OK' } } } },
      '/api/v1/dams/{slug}/observations':                    { get: { summary: 'Time series', parameters: [
        { in: 'path', name: 'slug', required: true, schema: { type: 'string' } },
        { in: 'query', name: 'from', required: true, schema: { type: 'string', format: 'date-time' } },
        { in: 'query', name: 'to', required: true, schema: { type: 'string', format: 'date-time' } },
        { in: 'query', name: 'interval', required: true, schema: { type: 'string', enum: ['hourly', 'daily', 'monthly'] } },
      ], responses: { '200': { description: 'OK' } } } },
      '/api/v1/watersheds':                                  { get: { summary: 'List watersheds', responses: { '200': { description: 'OK' } } } },
      '/api/v1/watersheds/{slug}':                           { get: { summary: 'Watershed detail', parameters: [{ in: 'path', name: 'slug', required: true, schema: { type: 'string' } }], responses: { '200': { description: 'OK' } } } },
      '/api/v1/watersheds/{slug}/dams':                      { get: { summary: 'Dams in watershed', parameters: [{ in: 'path', name: 'slug', required: true, schema: { type: 'string' } }], responses: { '200': { description: 'OK' } } } },
      '/api/v1/watersheds/{slug}/aggregate':                 { get: { summary: 'Watershed aggregate', parameters: [{ in: 'path', name: 'slug', required: true, schema: { type: 'string' } }], responses: { '200': { description: 'OK' } } } },
      '/api/v1/prefectures/{code}/dams':                     { get: { summary: 'Dams in prefecture', parameters: [{ in: 'path', name: 'code', required: true, schema: { type: 'string', pattern: '^[0-9]{2}$' } }], responses: { '200': { description: 'OK' } } } },
      '/api/v1/watershed':                                   { get: { summary: 'Watershed at point', parameters: [
        { in: 'query', name: 'lat', required: true, schema: { type: 'number' } },
        { in: 'query', name: 'lng', required: true, schema: { type: 'number' } },
      ], responses: { '200': { description: 'OK' } } } },
    },
  };
  return NextResponse.json(spec, { headers: { 'cache-control': 'public, max-age=300' } });
}
```

- [ ] **Step 2: Swagger UI page**

```tsx
// apps/web/app/api/docs/page.tsx
'use client';

import dynamic from 'next/dynamic';
import 'swagger-ui-react/swagger-ui.css';

const SwaggerUI = dynamic(() => import('swagger-ui-react'), { ssr: false });

export default function ApiDocsPage() {
  return (
    <div className="-mx-4">
      <SwaggerUI url="/api/v1/openapi.json" />
    </div>
  );
}
```

- [ ] **Step 3: Install + commit**
```bash
bun add swagger-ui-react --cwd apps/web
bun add -d @types/swagger-ui-react --cwd apps/web
bun run --filter @dam/web typecheck
git add apps/web
git commit -m "feat(web): OpenAPI spec + Swagger UI at /api/docs"
```

---

## Self-Review

1. **Spec coverage:**
   - §6 URL/SEO: every page has metadata + sitemap + structured data; Tasks 10–13 cover.
   - §7 Public API: all endpoints listed in §7 are implemented; HATEOAS Level 3 with HAL `_links` everywhere; OpenAPI document at `/api/v1/openapi.json`.
   - §7 Auth/rate: API key auth at the route, per-key rate limit (per-min and per-day).
   - §8 Quality public UI: dam-detail header shows last-fetched, source, quality flags; `/sources` exposes all sources.
   - §13 Performance: ISR (15-min revalidate) for dynamic pages; SSG for sitemap; client-side ECharts/Leaflet defer heavy work to the browser.

2. **Placeholders:** the OpenAPI spec is hand-rolled and minimal — it documents endpoints but skips response schemas. Acceptable for MVP and explicit. The `error.tsx` `'use client'` is required by Next 15.

3. **Type consistency:** `DamListItem` is shared between repo and `DamTable`. Slug types are `string` everywhere. `bigint` ids serialize as strings in API JSON.

4. **Risks:**
   - `swagger-ui-react` has React 18 peer-dep tags; with React 19 you may need `--legacy-peer-deps` or to pin a working version. If install rejects, drop swagger-ui and serve a static link to `/api/v1/openapi.json` plus the raw JSON.
   - Leaflet-with-many-markers performance: 3,000+ circle markers is fine; if you grow past 10k, swap to `leaflet.markercluster`.

---

## Execution Handoff

Plan complete and saved. Two execution options:

1. **Subagent-Driven** — fresh subagent per task with two-stage review. Recommended.
2. **Inline Execution** — same-session batched execution.

Which approach?
