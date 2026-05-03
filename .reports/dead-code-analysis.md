# Dead Code Analysis — 2026-05-03

Tools run: `knip`, `depcheck`, `ts-prune` (all via `bunx`).

## Baseline before any changes

- `bun run typecheck` — green (11/11 packages)
- `bun test apps packages` — 84 pass, 0 fail, 134 expect() calls (26 files)

## Raw findings

### knip (initial)

```
Unused files (11)
  apps/web/bin/capture_damnet.ts
  apps/web/bin/import_real_ndi_w01.ts
  apps/web/bin/import_real_ndi_w07.ts
  apps/web/bin/import_watersheds_from_w01.ts
  apps/web/bin/match_damnet.ts
  apps/web/bin/repair_dam_slugs.ts
  apps/web/bin/seed_synthetic_observations.ts
  bin/api_key.ts
  bin/fetch_dam_elevation.ts
  bin/fetch_dam_images_wikipedia.ts
  bin/fetch_dam_images.ts

Unused devDependencies (3)
  @types/geojson  apps/worker/package.json
  @types/geojson  packages/adapters/ndi/package.json
  drizzle-kit     packages/db/package.json

Unused exported types (9)
  Crumb              apps/web/components/breadcrumbs.tsx
  SeriesPoint        apps/web/components/observation-chart.tsx
  RateState          apps/web/lib/api/auth.ts
  AuthResult         apps/web/lib/api/auth.ts
  ImportOutcome      packages/adapters/damnet/src/importer.ts
  KasenbosaiReading  packages/adapters/kasenbosai/src/parser.ts
  ImportResult       packages/adapters/ndi/src/import_dams.ts
  ImportResult       packages/adapters/ndi/src/import_watersheds.ts
  SuimonRow          packages/adapters/suimon/src/parser.ts
```

### depcheck (root)

```
Unused devDependencies
  * @types/bun     (false positive — used by Bun runtime / test types globally)
  * typescript    (false positive — used by every package's `tsc --noEmit`)
Missing dependencies
  * @dam/db: ./bin/api_key.ts   (bin script imports @dam/db without root declaring it)
```

### ts-prune (per-package)

Most ts-prune output is noise:
- Next.js convention exports (`default`, `dynamic`, `revalidate`, `metadata`, `generateMetadata`, `GET`, `alt`, `size`, `contentType`) — these are required by Next.js routing.
- Workspace-package boundaries — exports re-imported via `@dam/*` look "unused" to ts-prune because it has no cross-tsconfig graph.
- Drizzle schema exports referenced via `@dam/db` package exports.
- Adapter `*Adapter` and parser exports consumed by the worker package (not visible to a single tsconfig run).

Useful real signals (corroborate knip):
- `Crumb` only used inside `apps/web/components/breadcrumbs.tsx`
- `ImportOutcome`, `KasenbosaiReading`, `ImportResult` (×2), `SuimonRow` only referenced within their own modules

## Categorisation

### SAFE
- `@types/geojson` in **apps/worker/package.json** — no `GeoJSON` namespace usage in worker source.
- `drizzle-kit` in **packages/db/package.json** — no `drizzle.config.*` exists; migrations use `bun run src/migrate.ts` (raw SQL via `postgres`).
- De-export the 6 module-internal interfaces (Crumb, ImportOutcome, KasenbosaiReading, two ImportResult, SuimonRow) — narrow visibility, no behavioural change.

### CAUTION (flagged, left alone)
- `@types/geojson` in **packages/adapters/ndi/package.json** — knip false positive. Source uses the ambient `GeoJSON.Polygon` / `GeoJSON.MultiPolygon` global namespace (see `parse_w07.ts`, `import_watersheds.ts`, `types.ts`). Removing it would break typecheck.
- `apps/web/components/observation-chart.tsx :: SeriesPoint` and `apps/web/lib/api/auth.ts :: RateState` / `AuthResult` — would qualify as SAFE de-exports, but those files have **uncommitted working-tree changes**. User instruction: do not touch uncommitted files.
- `packages/db/src/repo/_smoke.test.ts` — a real, passing schema-existence integration test using `withTestDb`. Despite the `_smoke` prefix it is not stale; provides coverage that all four master tables exist post-migration. Left alone.
- Most `ts-prune` reports about adapter/package exports — false positives across workspace boundaries.
- ts-prune flags on `lib/format.ts` (`fmtN`, `fmtPct`, `fmtDate`, `fmtCapacityMcm`) — left alone; small, stable utility module that is part of the package's public surface for future pages.

### DANGER (do not touch)
- All `bin/*.ts` and `apps/web/bin/*.ts` — invoked from cron / human operators / docs (RUNBOOK references `seed_synthetic_observations`, `repair_dam_slugs`, `capture_damnet`). Per user instruction: leave bin scripts.
- All `app/` route conventions (`page.tsx`, `route.ts`, `sitemap.ts`, `opengraph-image.tsx`, etc.) flagged by ts-prune — these are Next.js conventions, not unused.
- depcheck "missing dep" warning on root `@dam/db` — root is the Bun-runtime entry; it transparently resolves workspace packages. Leaving as-is.
- `@types/bun`, `typescript` at root — required dev tooling.

## Actions taken

| File | Change | Verified |
|------|--------|----------|
| `apps/worker/package.json` | Remove `@types/geojson` devDep | typecheck + 84 tests pass |
| `packages/db/package.json` | Remove `drizzle-kit` devDep | typecheck + 84 tests pass |
| `apps/web/components/breadcrumbs.tsx` | `export interface Crumb` → `interface Crumb` | typecheck + 84 tests pass |
| `packages/adapters/damnet/src/importer.ts` | de-export `ImportOutcome` | typecheck + 84 tests pass |
| `packages/adapters/kasenbosai/src/parser.ts` | de-export `KasenbosaiReading` | typecheck + 84 tests pass |
| `packages/adapters/ndi/src/import_dams.ts` | de-export `ImportResult` | typecheck + 84 tests pass |
| `packages/adapters/ndi/src/import_watersheds.ts` | de-export `ImportResult` | typecheck + 84 tests pass |
| `packages/adapters/suimon/src/parser.ts` | de-export `SuimonRow` | typecheck + 84 tests pass |
| `bun.lock` | Refreshed by `bun install` after devDep removals | — |

## Post-cleanup verification

- `bun run typecheck` — green (11/11 packages)
- `bun test apps packages` — 84 pass, 0 fail (unchanged from baseline)
- `bunx knip` — only DANGER-class items + already-flagged uncommitted files remain.

## Files staged for user review

```
M  apps/web/components/breadcrumbs.tsx
M  apps/worker/package.json
M  bun.lock
M  packages/adapters/damnet/src/importer.ts
M  packages/adapters/kasenbosai/src/parser.ts
M  packages/adapters/ndi/src/import_dams.ts
M  packages/adapters/ndi/src/import_watersheds.ts
M  packages/adapters/suimon/src/parser.ts
M  packages/db/package.json
```

The user's pre-existing uncommitted changes were not touched.
No commit was created.
