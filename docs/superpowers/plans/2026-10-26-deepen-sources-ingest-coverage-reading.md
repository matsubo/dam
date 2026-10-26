# Deepen sources, the ingest run, coverage triage and the reading

Decisions from the 2026-10-26 architecture review (candidates 1–4). Terms are defined in
`/GLOSSARY.md`; the two hard-to-reverse choices are `docs/adr/0001` and `docs/adr/0002`.

Two independent tracks, each on its own local branch, landed in this order:

1. **Source declaration** (write side)
2. **Ingest run** (write side, needs 1)
3. **Coverage triage** (read side)
4. **Reading and daily value** (read side, needs 3's definition of a value)

Every branch ends with `bun run typecheck && bun run lint && bun run test` on a scratch DB and
an E2E smoke run. Nothing is pushed without the owner's go-ahead.

## 1. Source declaration — `packages/core`

- One declaration per source: id, task, schedule, priority, description, active/retired,
  historical-only, enumerable, provides observations, trusted rate basis, freshness override,
  and the editorial label, license, upstream URL and cadence text now in
  `apps/web/lib/source-details.ts`.
- Every source id with observations or universe entries is declared: `ndi`, `damnet`,
  retired `niigata-bousai`/`shizuoka-bousai`, historical-only `mudam`/`kagoshima-bodik`, and
  `suimon` (which gets its missing row). `synthetic` is not declared.
- Starting values: where a task's `ensureSourcePriority` and a migration disagree, the task's
  value wins (it is what production holds; e.g. aomori-dam "11 dams", not 0059's "7").
- Derived from the declarations: the worker task list, the crontab text,
  `INGEST_INTERVAL_HOURS`, `FRESHNESS_OVERRIDE_HOURS`, `/sources` details, and the
  `source_priorities` rows.
- Sync: `deploy/bootstrap.sh` runs it right after migrations. Upsert of every declared row;
  rows without a declaration are logged and left alone. Migrations stop writing per-source
  facts (ADR 0001).
- Deleted: the 109 `ensureSourcePriority` copies, the trusted-basis upserts in four tasks,
  `historical_only` writes in two backfills, the hand-typed task list in `bootstrap.sh`, the
  `kasenbosai-v2` naming exception's duplicate.
- One in-process test walks every declaration: registered task, cron line, details present.

## 2. Ingest run — `apps/worker`

- Scope: scheduled `ingest:*` tasks. Backfills (suimon, mudam, kagoshima_bodik, jwa_junpo)
  stay outside. The kasenbosai pair is the one declared exception: `match:kasenbosai` records
  the universe, `ingest:kasenbosai-v2` writes `has_data` only.
- A task hands the run its universe entries. Every entry carries one of three states, required:
  has values / provider-marked empty / unreadable. The run maps them to `hasData`
  true / false / unset and never infers it.
  - A field the provider flags (okayama/tottori flg≠0: 欠測, 調整中) counts as provider-marked;
    an entry whose every field is flagged is provider-marked empty.
  - An entry known in advance whose page failed to fetch is unreadable, never dropped.
- A separate don't-write mark with a reason covers entries recorded but not written
  (kudamatsu `UNIVERSE_ONLY`, shimonoseki `COMBINED`, nagasaki_city/omura allow-lists).
  Rows that are not master dams still get `not_dam_reason` through a migration.
- The run owns: master lookup, the default name ladder (stamp → exact published name → same
  stem → stem + ダム → prefix → contains; the 40 current variants differ only by accident),
  `bindExternalId` for every task, `publishedAt`, the observation upsert, and the
  "nothing could be read" failure, raised after the universe is recorded.
- Universe and observations are written in one transaction, universe first; a failure fails
  the job so graphile-worker retries it (no more swallowed universe errors).
- Before building it: design the run's interface several ways in parallel and pick one.
- Migration: one provider family per commit, okayama and tottori first (both drop
  provider-marked entries from their universe today). Old and new paths coexist until the last
  task moves; then `universe_instrumentation.test.ts` and its EXEMPT map are deleted.
- Tests, replace not layer: each migrated task gets fixture → universe entries tests without a
  DB; the run gets one suite on a scratch DB. Parser-only, `chooseMaster` and
  `globalThis.fetch`-patching tests go as their task moves.
- Interface (Q31–Q36): `ingestTask(sourceId, scan)` in `apps/worker/src/ingest/`; a non-twin
  tie leaves the entry unbound; a failed list fetch fails the job; each family's bindings are
  compared against the stored `resolved_dam_id` before it moves; a `not_dam_reason` key binds
  only by stamp; per-dam partial-failure alarms (kudamatsu, nagasaki_city, omura) are dropped.
- Moved: okayama-bousai, tottori-bousai.

## 3. Coverage triage — `packages/db`

- One SQL definition taking a set of dam ids (none = all); `classifyOneDam` is deleted.
- One definition of a value (any of 貯水量, 貯水率, 流入量, 放流量, 水位, 雨量 non-null),
  used by the triage, `realSourceId` and `listDams`' real-only filter. Visible effect accepted:
  dams whose recent observations carry no value stop reporting `hasRealDataLast30d: true`.
- The source gate (active, provides observations, enumerable, not historical-only) is defined
  once.
- Computed once per request; headline, summary and per-prefecture numbers derive from that
  snapshot. The home page's cross-request cache is unchanged.
- Coverage statuses and their meanings live with the triage; the JSON API, OpenAPI text and
  the dam page's provider chip take them from there.

## 4. Reading and daily value — database (migrations)

- One reading rule (ADR 0002): a fresh trusted source first, then the newest observation that
  carries a value, then source priority, then source id. No age limit; how an old reading is
  presented is the view's job.
- Every view uses it: dam page, 平年比, 全国貯水率, 水系 totals and change, the map.
  `newest_row.ts`'s ordering contract goes.
- "Best source for a window" (the dam chart's source) stays a separate operation with the same
  tie-break.
- Every 貯水率 divides by effective capacity, including 全国 (changes the published national
  figure).
- Daily value (`obs_daily`): the day's newest observation that carries a value, same tie-break,
  no trusted-fresh preference; one full rebuild of the aggregate.
- Implemented as SQL in migrations, taking the time window so chunk exclusion survives.
  Callers move only after `EXPLAIN` on the full local database shows the same chunk exclusion
  and no worse plan for 全国 and 水系.
