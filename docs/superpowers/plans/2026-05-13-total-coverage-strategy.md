# Total Coverage Strategy — every dam, every storage, as fast as possible

## Goal

Render the storage volume of **every dam in Japan** with the **shortest
possible latency** behind real (non-synthetic) observations. Today
(2026-05-13) the site has 37 real dams of 2,749 (1.3 %) at daily-or-coarser
cadence. The plan below is the path to ~90 % coverage at hourly-or-better
cadence, and to handling the residual ~10 % honestly.

The plan is structured in five phases. Each phase is shippable on its own —
you can read the bottom of each phase to see the user-visible delta.

---

## Current state

- 2,749 dams in master (NDI seed).
- **37 dams have real data** (last 30 d):
  - tokyo-waterworks: 15 dams · daily
  - jwa-junpo: 26 dams · 10-day
  - aitoyo: 7 dams · daily (2 net-new vs jwa, 5 overlap with refresh)
- The other 2,712 dams are synthetic-seed only.
- Master DB operator distribution (top buckets):
  - 47 都道府県 collectively own ~1,500 dams
  - 9 power utilities own ~280 dams (関電, 東電, J-Power, 中電, ...)
  - JWA owns ~30 (26 covered)
  - 北海道開発局 (MAFF) 48, 東北農政局 35, 九州農政局 29 → ~150 agricultural dams
  - 392 dams have no `manager` populated (likely small private/agricultural)

The structural shape: **a long tail of operators** that each need their own
adapter. No single source unifies all 2,749 dams in machine-readable form,
or even close. The state-supplied unifier (川の防災情報 / 水文水質 DB) is
policy-blocked for programmatic scraping.

---

## Phase 1 — Triage by operator (no new adapters)

**Outcome:** A scored backlog of upstream sources, prioritized by
(dams covered) × (cadence frequency) × (legal cleanness) ÷ (adapter cost).

**Tasks:**

1. **Per-operator inventory** — for each of the top ~60 `manager` values,
   record (a) does the operator publish a real-time multi-dam page?
   (b) URL, (c) format (HTML/JS-rendered/XML/PDF), (d) license/robots,
   (e) cadence.
2. **Score = covered_dams × cadence_score / adapter_cost** where
   `cadence_score = {hourly: 24, daily: 1, 10-day: 0.1}`.
3. **Output** a spreadsheet / JSON manifest at
   `docs/superpowers/sources-backlog.json` enumerating ~60 candidates.

**Definition of done:** the manifest is checked in. Phase 2 picks from it.

**User-visible delta:** none yet — preparation only.

---

## Phase 2 — High-yield adapters (the next 5-10 sources)

**Outcome:** Coverage jumps from 37 dams → ~600 dams. Most still daily,
but a few hourly slots open up.

**Highest-yield candidates** (from operator survey + the public open-data
landscape I've already scouted):

| Operator | Est. dams | Cadence | Notes |
|---|---|---|---|
| 神奈川県企業庁 | 4 | daily | JS-rendered; need to find XHR endpoint |
| 大阪府河川防災 | ~20 | hourly | JS table; same XHR-hunt needed |
| 福岡県 | ~10 | daily | HTML; aitoyo-style adapter |
| 広島県 | ~15 | daily | HTML candidate |
| 北海道 (建設部) | ~30 | daily | HTML candidate |
| 中国地方整備局 アクセス可能ページ | ~10 | hourly | gov, may be policy-mixed |
| **Aggregator (Weathernews)** | **~500** | **hourly** | Redistributes the policy-blocked MLIT data; check ToS for programmatic reuse |
| Wikipedia infoboxes via Wikidata SPARQL | varies | irregular | Statements with `current water level` (P2659) where present |

**Pattern (proven by tokyo-waterworks/jwa-junpo/aitoyo):**

```
apps/worker/src/tasks/ingest_<source>.ts
  - NAME_MAP: source name → master name + prefCodes
  - parseXxxHtml(html) → ParsedRow[] with capacity/volume/rate
  - ensureSourcePriority / ensureExternalIds (idempotent)
  - upsertObservations
crontab: '<minute> <hour> * * * ingest:<source>'
bootstrap.sh kick: add enqueue_<source> line
SOURCE_DETAILS entry in apps/web/lib/source-details.ts
```

Each new adapter is ~3-4 h of work end-to-end. Reaching 600 dams = ~30 h
of focused adapter work + the manifest from Phase 1.

**Definition of done per source:** local end-to-end test passes
(N/N dams matched, observations written, rate is in [0,1]), task wired
into worker, cron registered, bootstrap kick enqueues it, source-priority
chosen relative to peers.

**User-visible delta:** 実測データ stat rises from 37 to ~600 (~22 %),
drought banner becomes meaningful, /sources page lists 8-12 real sources.

---

## Phase 3 — Cadence upgrade (daily → hourly where possible)

**Outcome:** For the dams that already have a real source, harvest more
frequent timestamps so charts show movement intra-day.

**Tasks:**

1. **Reconnaissance** — for every source from Phase 2, identify if a
   higher-cadence endpoint exists (live JSON vs daily HTML).
2. **Polite throttling** — bump cron frequency, but never below the
   operator's published refresh interval. Always send a self-identifying
   `User-Agent` with `+https://dam.teraren.com/legal/terms` so operators
   can rate-limit us individually if needed.
3. **Continuous-aggregate sanity** — Timescale refresh policies must
   keep up with hourly writes. Currently we have `obs_daily` / `obs_monthly`;
   verify they auto-refresh on the new cadence (`SELECT * FROM
   timescaledb_information.continuous_aggregates`).

**Definition of done:** at least 100 dams have 24+ real observations per
day (the hourly threshold).

**User-visible delta:** dam-detail charts show real intra-day movement,
not just the once-per-day step function. Drought callouts react within an
hour to flash floods.

---

## Phase 4 — Coverage push to ~90 %

**Outcome:** Real coverage for the long tail of small/agricultural dams.

**The hard part.** Beyond the ~600 dams of Phase 2, each additional
adapter covers fewer dams. We need to switch tactics:

1. **Bulk official-data inquiry** — formal request to each prefecture
   for a daily CSV export of their dams. Many prefectures will say yes
   to a public-good open-data request. Track responses in
   `docs/superpowers/outreach-log.md`.
2. **MLIT partnership** — the 政策レベル block on kasenbosai exists
   because they want to control redistribution, NOT because the data is
   secret. A formal "academic / disaster-prevention research"
   application via 国土交通省データ標準化推進室 should unblock the
   ~1,000 MLIT dams.
3. **Citizen-science fallback** — for the very last dams that nobody
   publishes, accept user-submitted observations via a moderated
   /api/v1/observations/community POST endpoint, with a clear
   `source_id = 'community/<email-domain>'` tag and a separate UI
   surface so users know the provenance.

**Definition of done:** ≥ 90 % of dams (2,475) have at least one real
observation per week.

**User-visible delta:** the "実測 X 基 / 2,749" stat rises from ~600 to
~2,500. /dams?real=1 becomes the default browse view, not an exception.

---

## Phase 5 — Freshness UI and the residual 10 %

**Outcome:** Users know exactly how fresh each data point is, and
synthetic / no-data dams stop confusing them.

**Tasks:**

1. **Relative timestamps everywhere** — "3 時間前" instead of
   "2026-05-13 09:00 JST". Make staleness immediately visible.
2. **Per-dam "staleness" badge** — green (< 6 h), amber (6-24 h), red
   (> 24 h), grey (no real data).
3. **Drop the synthetic seed entirely for dams with no real upstream.**
   Show "観測値未取得" instead of fake numbers — the user's recent
   complaint ("最新のデータを取れている感じがしない") was exactly the
   synthetic seed leaking through as if it were real.
4. **OG image** — auto-generated social-share card showing the current
   drought-list. Each share looks distinct and timely.
5. **RSS / webhook** — subscribers get notified when a dam crosses
   below 40 % or a watershed's aggregate drops 10 % week-over-week.

**Definition of done:** Every visible timestamp on the site shows
relative age. No fake values are displayed without a 推定値 chip. At
least one dam has been broadcast via webhook to a test consumer.

**User-visible delta:** the perception of staleness disappears.
Users see the system working in real time, even for dams where the
underlying source itself updates only daily.

---

## Cross-cutting workstreams

These run in parallel to the phases:

1. **Worker stability** — fix the cron-wedge issue (kick split already
   shipped). Add Sentry / log alerting so a stuck job pages me within
   30 min, not 12 hours.
2. **Backfill all sources** — every new source should ship a
   `backfill:<source>` task (jwa-junpo has one as the reference
   implementation).
3. **Schema / quality** — quality_flag rules for cross-source agreement
   (when 2 sources disagree on the same dam, mark with `8 ソース不一致`).
4. **Performance budget** — admin/jobs endpoint, /sources page, /watersheds
   page all now hit the 6.7M-row observations table multiple times.
   Add appropriate indexes or pre-aggregate where any query exceeds
   100 ms p95.
5. **Legal compliance** — for each new source, log in `/sources/[id]`
   the upstream's robots.txt stance + license. If a source pushes back,
   stop crawling within 1 business day.

---

## Open questions / risks

- **Policy block on MLIT** — without unblocking ~1,000 dams via 川の防災情報,
  Phase 4 caps at ~60 %. The official-inquiry path is slow (months) and
  uncertain. Aggregator sources (Weathernews) may be a faster bridge but
  the ToS allowance for redistribution is unclear.
- **Operator hostility** — some prefectures block obvious crawlers. We
  need to remain a good citizen (UA, throttling, Retry-After respect).
- **Synthetic seed leaking** — until Phase 5 lands, users will keep
  perceiving stale data for the 2,700 dams that look synthetic-fresh.
  Mitigation: prioritize Phase 5 task 3 (drop synthetic display) before
  Phase 4 finishes.
- **Data licensing for redistribution** — even if we can fetch, can we
  expose the value over our own API? Each source needs its license
  reconciled with our /api/v1 terms.

---

## Next concrete steps (this week)

1. **Today:** Push the aitoyo adapter (commit `304ae5a`) + per-source
   pages (`1ce4dfa`). Brings prod to 37 real dams and gives every
   source a clickable detail page.
2. **+1 day:** Write the per-operator inventory script. Output:
   `docs/superpowers/sources-backlog.json` with ~60 candidates scored.
3. **+3 days:** Pick the top-3 candidates from the manifest. Build
   them following the proven adapter pattern. Aim: +50-150 dams.
4. **+1 week:** Send the MLIT inquiry email. Start the bureaucratic
   clock running in parallel with adapter work.
5. **+2 weeks:** Phase 5 tasks 1-3 (relative timestamps, staleness
   badges, drop synthetic display). User perception fix.

After step 5, re-evaluate: do we keep adding adapters, or push harder on
MLIT? The answer depends on what their reply looks like.
