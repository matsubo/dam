# Conventions

What the codebase consistently does. When in doubt, match the existing
pattern instead of inventing a new one.

## Coding

- **Strict TypeScript everywhere**. `tsconfig.base.json` enables
  `noUncheckedIndexedAccess`, `exactOptionalPropertyTypes`,
  `noImplicitOverride`, `verbatimModuleSyntax`. New code must pass
  `bun run typecheck` without `// @ts-expect-error` (rare; prefer
  conditional `if (x !== undefined)` patterns).
- **No `any`, no non-null assertions**. Biome enforces both as errors.
  Prefer narrowing by control-flow or explicit type guards.
- **Immutable patterns**. New objects, never mutation. Spread or
  `structuredClone`. The CLAUDE.md rule is non-negotiable.
- **Small focused files**. Target 200–400 lines, hard cap at 800. Repo
  files are organised by responsibility, not by technical layer (see
  `packages/db/src/repo/dams.ts` vs spreading queries across many files).
- **No comments unless WHY is non-obvious**. Don't restate code.
- **Imports use `.ts` extension**. `tsconfig.base.json` has
  `allowImportingTsExtensions: true`. Bun and Next both accept this.

## File-naming

- snake_case for `bin/` scripts and `worker/tasks/*` (matches Postgres /
  cron naming we already use)
- kebab-case for components and pages (`dam-table.tsx`, `not-found.tsx`)
- `package.json` `name` is `@dam/<slug>` (e.g. `@dam/db`, `@dam/adapters-ndi`)

## Database

- **Migrations are append-only**. Never edit a migration that's already
  shipped. New work goes in the next numbered file.
- **Numbered SQL only** (`packages/db/migrations/NNNN_*.sql`). Do not use
  Drizzle Kit for migration generation — we hand-write SQL so PostGIS /
  TimescaleDB DDL is explicit.
- **Drizzle schemas mirror SQL** in `packages/db/src/schema/*.ts`. They
  exist for type inference, not for query building. Most queries use
  postgres.js tagged templates directly.
- **Repos go in `packages/db/src/repo/<resource>.ts`**. One file per
  resource. Functions are `findX`, `listX`, `upsertX`, `complete`, etc.
- **Test cleanups must scope by exact ID list**, never by source/external_id.
  Past test wiped 2,749 production rows twice.

## API design

- **HATEOAS Level 3 mandatory**. Every successful response includes
  `_links.self`; every entity has links to related resources. Use
  `apps/web/lib/api/response.ts:hal()` so this stays consistent.
- **Errors are RFC 7807 `application/problem+json`**. Use `HttpError` +
  `asProblem()` from `apps/web/lib/api/error.ts`.
- **API key required** on every endpoint except `/healthz` and `/sources`.
  Set `API_AUTH_BYPASS=1` to disable for local dev / E2E.
- **bigint serialization**: convert `dam.id.toString()` before
  `JSON.stringify`. Native bigints throw.
- **Cursor pagination**, never offset. `cursor=<last_id>` on next links.

## Page conventions (Next.js 15 App Router)

- **ISR with `export const revalidate = 900`** for content pages, longer
  for taxonomy pages. SSG only when zero per-request DB work.
- **Decode dynamic params**: `decodeURIComponent(rawSlug)`. Next 15 leaves
  URL-encoded kanji in page-component params (route handlers decode
  automatically — this is a Next quirk that affects pages only).
- **Server components by default**. Mark `'use client'` only for ECharts,
  Leaflet, error boundaries, and interactive form components.
- **Metadata via `generateMetadata`** with `alternates.canonical` set.
- **Structured data via `<script type="application/ld+json">`** with
  `dangerouslySetInnerHTML` and a `biome-ignore` comment. The Breadcrumbs
  component already does this for `BreadcrumbList`.

## UI / formatting

- **Use `@/lib/format.ts`** for all numbers/dates. Don't inline
  `toLocaleString` calls.
- **`fmtCapacityMcm()` for storage volume**. Auto-scales between m³, 万 m³,
  and 億 m³. Hand-rolled unit formatters drift; the helper is canonical.
- **Tailwind only**. No CSS modules, no styled-components, no inline
  styles beyond `style={{ height: '...' }}` for chart sizing.
- **Use `<Link>` from `next/link`** for internal navigation. External
  links use `<a>` with `target="_blank" rel="noopener"`.
- **Tables use a single shared style** from `globals.css`. Don't override
  per page.

## Tests

- **Unit tests** colocated next to source (`X.ts` → `X.test.ts`).
- **Integration tests use real DB**. The test transaction helper in
  `tests/integration/helpers.ts` is for when you need rollback isolation
  on a single connection. Most repo tests just use `beforeAll` to seed
  with a unique fixture ID and `afterAll` to scope-delete.
- **E2E tests are Playwright**. Specs go in `tests/e2e/<topic>.spec.ts`.
  The QA-walk spec at `tests/e2e/qa-walk.spec.ts` does full-page screenshots
  for visual review.
- **Skip flake-prone assertions**. The previous "find nearest watershed
  with distance > 0" test broke as soon as real data loaded — we now use
  a bbox where TEST-01 is the unambiguous closest.

## Git

- **Conventional commit prefixes**: `feat:`, `fix:`, `refactor:`,
  `docs:`, `test:`, `chore:`, `ci:`, `ops:`.
- **Never `--amend`** unless the commit hasn't been pushed and the only
  change is a hook-driven format fix. Prefer a follow-up commit.
- **Never push without explicit human consent**. Local commits are fine.
- **Never `--no-verify`**. If a hook fails, fix the underlying issue.
- **Subject ≤ 70 chars**, body has the why. PR descriptions follow the
  same rule.

## Plans + specs (Superpowers)

- **Spec → Plan → Implementation**, in that order. Specs live under
  `docs/superpowers/specs/YYYY-MM-DD-<topic>-design.md`. Plans under
  `docs/superpowers/plans/YYYY-MM-DD-<topic>.md`.
- **Plans are bite-sized**. Each task is a section with `## Task N: ...`
  and steps that take 2–5 minutes. Every step shows full code, not
  pseudo-code.
- **Self-review before handoff**. Each plan ends with a self-review
  section that walks the spec coverage, scans for placeholders,
  type-consistency-checks across tasks.

## Ingest pipeline

- **Adapter contract**: `packages/core/src/source_adapter.ts:SourceAdapter`.
  Implementations live under `packages/adapters/<name>/src/adapter.ts`.
- **Snapshots are first-class**: every fetch results in a row in
  `raw_snapshots` with the body persisted to MinIO. Never parse without
  saving the bytes.
- **Quality bits propagate**: `quality_flag` is a bitfield, not an enum.
  Multiple bits can be set on the same row. The nightly recompute task
  fans out per-bit.
- **Source priorities are runtime config**, not code. Adjust by UPDATEing
  `source_priorities` rather than committing constants.

## Naming things

- **Watershed = 水系**. Use this everywhere; never "river basin" / "valley"
  / "drainage area" interchangeably (W07 has all three).
- **Storage volume = 貯水量** (m³). Storage rate = 貯水率 (0..1, not %).
- **Slug** is the URL-safe identifier. May contain kanji (we url-encode
  on output, decode on input).
- **External ID** is the upstream's identifier. Stored as
  `external_ids JSONB` keyed by source. Never the primary `id`.
