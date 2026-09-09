# AGENTS.md — orientation for LLM agents working on this repo

> If you are an LLM picking up this codebase mid-stream, **read this file first**, then `docs/llm/PROJECT_OVERVIEW.md` and `docs/llm/CODEMAP.md`. Everything else is reference.

## What this project is

A Japanese dam-data platform. Public web service (Next.js) + REST API + worker
pipeline. Stores master data (~2,749 dams + 644 watersheds) and a TimescaleDB
hypertable of hourly reservoir observations. Goal stated in the design spec:
"become the largest dam data source in Japan."

`docs/superpowers/specs/2026-05-01-dam-data-platform-design.md` is the
canonical product/architecture spec. It precedes any LLM-written doc.

## What you'll typically be asked to do

1. **Add a feature or page.** Read `docs/llm/CODEMAP.md` first, then the
   relevant package's `src/index.ts` to see what's already exported.
2. **Run an importer / seeder.** All importers live in `apps/web/bin/`. They
   read `.env` from the repo root; run them via `cd <repo> && bun run apps/web/bin/<file>.ts ...`.
3. **Fix a bug.** Reproduce with the closest test (`bun test` or
   `bunx playwright test --project chromium -g <name>`). Add a regression test
   before fixing.
4. **Write a plan.** Specs and plans go under `docs/superpowers/{specs,plans}/`
   following the Superpowers conventions (date-prefixed filenames).

## What NOT to do

- **Do not push without explicit human consent.** Local commits are fine.
- **Do not run `DELETE FROM dams ...`** without scoping to a fixture-id list.
  Past test code wiped 2,749 production rows twice in the same week.
- **`synthetic` is retired.** Migration 0042 dropped it from
  `source_priorities`; production has no synthetic rows and no API parameter
  or doc mentions it. `seed_synthetic_observations.ts` still exists for a
  local/fresh bring-up and re-inserts the row if you run it — don't
  reintroduce it into the public surface.
- **Do not invent new URLs / endpoints** in commits or docs. If you reference
  an external upstream, verify it actually exists with `curl -sI`.
- **Do not add features the user did not ask for.** Read `CLAUDE.md` rules.
  Especially: no premature error handling, no extra abstractions.
- **Do not delete `data/` contents.** It's gitignored and contains downloaded
  source datasets (~1 GB). Re-downloading takes hours.

## Operational invariants you must preserve

| Invariant | Why |
|---|---|
| `dams.slug` is unique and stable across reimports | URLs are SEO-indexed; mutation breaks bookmarks |
| `watersheds.code` is the unique key (slug is derived) | W01 vs W07 sources may produce different slugs |
| `observations` PK is `(dam_id, observed_at, source_id)` | Multiple sources for same time are intentional |
| Test cleanups must be **scoped to fixture IDs**, never use a blanket source/external_id filter | Past test wiped prod twice |
| `source_priorities.priority DESC` decides which source the chart shows | Multiple sources can cover one dam; the top-priority one wins |
| Every observation-ingesting task calls `recordUniverse()` | `/coverage` can only say "no provider publishes this dam" once every provider has recorded its published list; a task that skips it leaves its dams stuck in 未調査. Enforced by `apps/worker/src/tasks/universe_instrumentation.test.ts` |
| `External API responses use HAL+JSON with `_links`` | HATEOAS Level 3 is required by `~/.claude/rules/api-design.md` |
| `Page components decode params with `decodeURIComponent(rawSlug)`` | Next 15 leaves URL-encoded kanji in dynamic params (route handlers decode automatically; pages do not) |

## Common commands

```sh
# Bring up local infra (Postgres + MinIO)
just up
just ensure-bucket
just migrate

# Dev server (uses .env)
just dev-web                            # binds 127.0.0.1
# or for LAN access on this machine:
cd apps/web && API_AUTH_BYPASS=1 \
  NEXT_PUBLIC_SITE_URL=http://mini.local:3030 \
  bun next dev -H 0.0.0.0 -p 3030

# Tests
bun run test                            # 85 unit/integration tests
bunx playwright test                    # 26 E2E tests (auto-spawns dev)
E2E_BASE_URL=http://127.0.0.1:3030 bunx playwright test  # against existing dev

# Quality gates
bun run typecheck && bun run lint && bun run test

# API key admin
just api-key-issue email=x@example.com label=foo
just api-key-list
just api-key-revoke id=42

# Live data refresh (one-off, all run from repo root)
bun run apps/web/bin/import_real_ndi_w01.ts             data/nlni/w01.geojson
bun run apps/web/bin/import_watersheds_from_w01.ts      data/nlni/w01.geojson
bun run apps/web/bin/import_real_ndi_w07.ts             data/nlni/w07/dissolved
bin/fetch_w05.sh && bun run apps/web/bin/classify_watershed_kind.ts --out packages/db/migrations/00NN_….sql   # re-classify kind / ndi_code (#21); 0041 is the committed result
bun run apps/web/bin/capture_damnet.ts                  --from 123500 --to 128000
bun run apps/web/bin/match_damnet.ts                    data/damnet/dams.jsonl
bun run apps/web/bin/repair_dam_slugs.ts
bun run apps/web/bin/seed_synthetic_observations.ts     --hourly-days 30 --years 5
```

## Common gotchas (already burned us)

1. **Postgres connection exhaustion under heavy QA**: Next dev's HMR creates
   new module instances each holding their own postgres pool; combined with
   `max: 10` per instance, ~10 reloads can hit `max_connections=100`. If you
   see "sorry, too many clients already" → `docker compose restart db` then
   restart dev. For long QA runs, restart dev between batches.

2. **Build cache rot**: if Next throws `ENOENT: ... .next/server/app/...page.js`
   after a biome auto-format pass mid-compile, just `rm -rf apps/web/.next`
   and restart.

3. **Kanji slugs in page routes**: Next 15 hands `params.slug` to page
   components URL-encoded (e.g. `watershed-%E5%A0%A4%E5%B7%9D`). Route handlers
   under `app/api/...` decode automatically. **Pages must call
   `decodeURIComponent(rawSlug)` themselves** before passing to repo functions.

4. **bigint↔number serialization**: `JSON.stringify` rejects native bigints.
   API responses convert with `dam.id.toString()`. postgres.js parses scalar
   `int8` to `bigint` (configured in `client.ts`); arrays of `int8` come back
   as `string[]` unless explicitly cast.

5. **Capacity units**: m³ is the storage unit, but Japanese reservoir UIs
   conventionally use 万 m³ (×10⁴) or 億 m³ (×10⁸). Use `fmtCapacityMcm()` —
   it auto-scales.

6. **Real source restrictions**: `www.river.go.jp/kawabou/` returns
   `403 — Access Restrictions — This site prohibits data acquisition using tools`
   for any direct API access. ~70 other upstreams now feed the realtime
   pipeline instead (see `/coverage`).

7. **Adding a new ingest task**: it must call `recordUniverse(SOURCE_ID, rows)`
   once per run with the provider's WHOLE published list — the unmatched rows
   are the point, since they are what separates "they publish it, we failed to
   link it" from "nobody publishes it". Push into the array BEFORE the
   `continue` that skips unmatched rows. `ingest_okayama.ts` (fetched list) and
   `ingest_cgr_mlit.ts` (hardcoded array) are the reference implementations.
   A task that genuinely cannot enumerate a list goes in the EXEMPT map in
   `universe_instrumentation.test.ts` with a reason.

8. **Test cleanup scoping**: see `packages/adapters/ndi/src/import_dams.test.ts`
   for the correct pattern (`WHERE external_ids ->> 'ndi' IN ('1234567890','9999999999')`).
   Never use `WHERE external_ids ? 'ndi'`.

## Where to look next

- `docs/llm/PROJECT_OVERVIEW.md` — what each package is for, in two pages.
- `docs/llm/CODEMAP.md` — file index with one-line descriptions.
- `docs/llm/DATA_FLOW.md` — how a dam fact reaches the chart.
- `docs/llm/RUNBOOK.md` — operations: deploy, restart, restore, debug.
- `docs/llm/CONVENTIONS.md` — coding style, commit format, test patterns.
- `docs/superpowers/specs/` — product/architecture (canonical).
- `docs/superpowers/plans/` — implementation plans (numbered by date).
- `~/.claude/CLAUDE.md` and `~/.claude/rules/*.md` — workspace-global rules.
