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

# Suimon backfill remains opt-in only. Enqueue ad-hoc jobs via add_job
# rather than running it on a fixed cron, so we don't keep hammering the
# upstream when there's nothing new to import.

# Quality recomputation
30 4 * * * quality:recompute

# Cover-image and elevation refresh — monthly, staggered to avoid hitting the
# upstream APIs all at once.
0 5 1 * * images:refresh:damnet
0 5 2 * * images:refresh:wikipedia
0 5 3 * * master:refresh:elevation
`;
