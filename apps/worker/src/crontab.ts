// apps/worker/src/crontab.ts
// graphile-worker crontab format: https://github.com/graphile/worker
// All times below are UTC (graphile-worker doesn't take a timezone). Display
// time in the UI is always JST (Asia/Tokyo) — see lib/format.ts.
//
// Note: graphile-worker's crontab parser only allows [_a-zA-Z][_a-zA-Z0-9:_-]*
// for task identifiers, so we use colons instead of dots.
export const CRONTAB = `
# Master refresh
0 3 1 * * master:refresh:ndi
0 3 5 * * master:refresh:damnet
0 4 * * * master:match

# Observation ingest. Hourly cadence keeps storage charts fresh without
# hammering upstream — the kasenbosai adapter only fetches dams that have an
# external_ids->>'kasenbosai' set, so empty matches are cheap. Once
# beta-stage name-matching populates those IDs, this cron starts producing
# real observations on its own.
0 * * * * ingest:kasenbosai

# 川の防災情報 v2 — 800+ dams via tmlist/dam/{date}/{time}/{obs_fcd}.json.
# Requires match:kasenbosai to have seeded external_ids.kasenbosai first.
# Snap to 10-min cadence at :03 (give the source 3 min headroom past the
# 10-min boundary, then concurrent fetches across 800+ dams take ~3 min
# at concurrency=8).
3 * * * * ingest:kasenbosai-v2

# Tokyo waterworks daily reservoir status — open data, real values for the
# 13 dams supplying Tokyo's drinking water (Tonegawa 9 + Arakawa 4 +
# Tamagawa 2). Page updates daily; check at 03:00 UTC = 12:00 JST and again
# at 09:00 UTC = 18:00 JST so a same-day refresh after the morning publish
# is captured. Idempotent — repeated runs UPSERT on (dam_id, observed_at,
# source_id) where observed_at is snapped to today 00:00 JST.
0 3,9 * * * ingest:tokyo-waterworks

# JWA 旬報 — 21 dams across 7 major water systems (Tonegawa, Arakawa, Kisogawa,
# Toyokawa, Yodogawa, Yoshinogawa, Chikugogawa). Published every 10 days
# (1st/11th/21st of each month JST). Daily polling at 04:00 UTC = 13:00 JST
# is cheap (idempotent UPSERT on the report-date timestamp) and catches a
# new publication within ~24 h regardless of which exact day it lands on.
0 4 * * * ingest:jwa-junpo

# あいとよネット (aitoyo) — 7 dams across 木曽川 / 豊川 / 矢作川 系. Page is
# updated daily at 24:00 JST (木曽川/豊川) or 09:00 JST (矢作川); fetch at
# 02:00 UTC = 11:00 JST so we get fresh data for both branches.
0 2 * * * ingest:aitoyo

# JWA Chikugo (筑後川 7 dams: 松原/下筌/大山/合所/江川/寺内/小石原川). Page
# shows today 0時 JST values, refreshed during business hours. Fetch at
# 01:00 UTC = 10:00 JST.
0 1 * * * ingest:jwa-chikugo

# かながわの水がめ JSON API — hourly cadence for 5 prefectural dams
# (相模/城山/三保/宮ヶ瀬/道志). Page rolls a 30-hour window; cron at
# every hour :05 captures the freshest reading shortly after the
# source's update.
5 * * * * ingest:kanagawa-dam

# 滋賀県土木防災 — 6 prefectural dams, hourly. Page exposes a 23-hour
# window per fetch; cron at every hour :07 catches today's freshest
# value + 22 hours of context for self-healing.
7 * * * * ingest:shiga-bousai

# 鳥取県ダム諸量情報システム — 5 prefectural dams (賀祥/朝鍋/佐治川/
# 東郷/百谷). Page refreshes server-side every 10 min. Cron at :09 every
# hour catches the freshest values.
9 * * * * ingest:tottori-dam

# 青森県砂防ダム情報 — 7 dams. Page is real-time (JST minute-level
# timestamp). Cron at :11 every hour.
11 * * * * ingest:aomori-dam

# 国土交通省 北海道開発局 — 18 直轄 dams (info-dam.hdb.hkd.mlit.go.jp).
# Page table has 10-minute cadence; we fetch hourly at :13 to spread load
# from other prefectural sources.
13 * * * * ingest:hkd-mlit-dam

# 国土交通省 中国地方整備局 — 11 国管理 dams across 5 prefectures
# (岡山/広島/山口/鳥取/島根). Single POST JSON gives all dams' current
# values. Cron at :15 every hour.
15 * * * * ingest:cgr-mlit-dam

# 国土交通省 関東地方整備局 鬼怒川ダム統管 — 4 dams (栃木県:
# 五十里/川俣/川治/湯西川). realDM.html embeds the 4 dams' values
# inline as JS arrays (10-min cadence at source). Cron at :17.
17 * * * * ingest:ktr-kinu-dam

# 国土交通省 北陸地方整備局 — 7 dams across 6 prefectures (福島/山形/
# 新潟/長野/富山/石川). CSV-like tmDam.txt feed has current values for
# all dams in one fetch. Cron at :19.
19 * * * * ingest:hrr-mlit-dam

# 千葉県 県内ダムの貯水状況 — 23 dams (水道用+工業用水). Daily 9 JST
# publish. Fetch at 02:30 UTC = 11:30 JST, giving upstream 2.5h headroom.
30 2 * * * ingest:chiba-suisei

# おかやま防災ポータル — ~15 県管理ダム (JSON feed, 30分更新). A pointer
# fetch yields the freshest snapshot file with every dam's values. Cron at
# :21 every hour, spaced from the other prefectural sources.
21 * * * * ingest:okayama-bousai

# Suimon backfill remains opt-in only. Enqueue ad-hoc jobs via add_job
# rather than running it on a fixed cron, so we don't keep hammering the
# upstream when there's nothing new to import.

# mudam tail backfill — monthly increment. mudam publishes confirmed values
# with a 1-2 year lag, so once or twice a year a new year-block of data
# becomes available. Running over all 9 districts × 1 year is ~90 min and
# imports any newly-published rows idempotently. 05 UTC on day 20 = 14:00
# JST on the 20th, well-spaced from other cron storms.
# Payload is JSON5 inside {} per graphile-worker convention.
0 5 20 * * backfill:mudam {"district":"all","years":1}

# Quality recomputation
30 4 * * * quality:recompute

# Freshness watchdog — every hour, scan source_priorities and flag any source
# whose newest observation is older than the per-source expected window
# (see apps/worker/src/tasks/quality_freshness.ts). Posts a digest to
# DISCORD_FRESHNESS_WEBHOOK if set; else logs warnings only.
35 * * * * quality:freshness-check

# Cover-image and elevation refresh — monthly, staggered to avoid hitting the
# upstream APIs all at once.
0 5 1 * * images:refresh:damnet
0 5 2 * * images:refresh:wikipedia
0 5 3 * * master:refresh:elevation
`;
