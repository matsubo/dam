#!/bin/sh
# Web container boot sequence: migrate → seed-if-empty (or force) → start.
# Idempotent — safe to run on every restart.
#
# Force flags (set in the Coolify env, then UNSET after the deploy succeeds):
#   BOOTSTRAP_FORCE_MASTER=1       — TRUNCATE master tables and re-restore
#                                    /seed/master.sql.gz, even when dams is
#                                    non-empty. Use to push a fresh local
#                                    snapshot to prod.
#   BOOTSTRAP_FORCE_OBSERVATIONS=1 — TRUNCATE observations and re-run the
#                                    synthetic seeder. Implied when
#                                    BOOTSTRAP_FORCE_MASTER=1 (because
#                                    TRUNCATE CASCADE wipes obs anyway).
#   BOOTSTRAP_BACKFILL_JWA=N       — Enqueue a one-shot jwa-junpo backfill
#                                    over the past N months. Set to '1' to
#                                    use the default 12-month window.
#                                    Requires BOOTSTRAP_KICK=1 (the kick
#                                    branch is where the enqueue happens).
#   BOOTSTRAP_KICK_MASTER=1        — When kicking, also enqueue
#                                    master:refresh:ndi + master:refresh:damnet.
#                                    Heavy jobs (30-60 min each) that
#                                    saturate the worker pool — only use
#                                    when explicitly refreshing master
#                                    data. Requires BOOTSTRAP_KICK=1.
#   BOOTSTRAP_PURGE_SYNTHETIC=1    — One-shot: DELETE every row where
#                                    observations.source_id = 'synthetic'
#                                    and deactivate the source_priorities
#                                    entry so it doesn't re-seed. Touches
#                                    ~2.7M compressed Timescale rows, so
#                                    we lift the per-DML decompression
#                                    cap inside the same transaction.
#                                    UNSET after the first successful run.
#   BOOTSTRAP_BACKFILL_MUDAM=N     — Enqueue a one-shot mudam backfill
#                                    over the past N years for ALL 9
#                                    districts. Set to '1' for the
#                                    default 5-year window. Requires
#                                    BOOTSTRAP_KICK=1. UNSET after the
#                                    job is enqueued — the worker takes
#                                    ~100 min for a 5-year × all-9-region
#                                    sweep.
#   BOOTSTRAP_REFRESH_AGGREGATES=1 — One-shot: CALL Timescale's
#                                    refresh_continuous_aggregate for
#                                    obs_daily and obs_monthly over the
#                                    full mudam range (2019-now). Needed
#                                    after a large historical insert
#                                    (like backfill:mudam) before the
#                                    chart UI surfaces the rows. UNSET
#                                    after the first successful run.
#   BOOTSTRAP_MATCH_KASENBOSAI=1   — One-shot: enqueue match:kasenbosai
#                                    to scrape MLIT 川の防災情報 catalogue
#                                    and seed external_ids.kasenbosai for
#                                    ~900 dams. Requires BOOTSTRAP_KICK=1.
#                                    UNSET after a successful run.
#
# We deliberately AVOID `set -eu`. A non-fatal failure in the bootstrap
# (e.g. seed file checksum drift, observations seed timeout) shouldn't keep
# the web app from serving — better to start with whatever data we have and
# let the operator re-trigger the seed manually.

# Capture key bootstrap output to a file Next.js can serve so an operator
# without `docker exec` can read it via HTTPS:
#   curl https://dam.teraren.com/bootstrap.txt
# We can't use `exec > >(tee ...)` (process substitution needs bash and
# this shell is sh/dash); instead, individual operations append to the log.
BOOTSTRAP_LOG=/app/apps/web/public/bootstrap.txt
mkdir -p "$(dirname "${BOOTSTRAP_LOG}")"
: > "${BOOTSTRAP_LOG}" 2>/dev/null || true
log() {
  echo "$@"
  echo "$@" >>"${BOOTSTRAP_LOG}" 2>/dev/null || true
}

log "[bootstrap] $(date -u +%FT%TZ) starting"

cd /app

if [ -z "${DATABASE_URL:-}" ]; then
  log "[bootstrap] FATAL: DATABASE_URL is unset"
  exit 1
fi

# psql is installed by the Dockerfile (postgresql-client). Use it for the
# count queries — simpler and no bun -e quoting tricks.
count_or_empty() {
  psql "$DATABASE_URL" -tA -v ON_ERROR_STOP=0 -c "$1" 2>/dev/null | tr -d '[:space:]'
}

log "[bootstrap] applying pending migrations…"
if ! bun run --filter @dam/db migrate; then
  log "[bootstrap] migrations failed — continuing so the app at least serves"
fi

dams=$(count_or_empty "SELECT COUNT(*) FROM dams")
log "[bootstrap] dams.count = '${dams}'"

force_master="${BOOTSTRAP_FORCE_MASTER:-}"
need_master_restore=0
if [ "${dams}" = "0" ]; then
  need_master_restore=1
elif [ "${force_master}" = "1" ]; then
  log "[bootstrap] BOOTSTRAP_FORCE_MASTER=1 set — will overwrite master data"
  need_master_restore=1
fi

if [ "${need_master_restore}" = "1" ]; then
  if [ -f /seed/master.sql.gz ]; then
    # Always TRUNCATE before restore. Reasoning:
    #   - dams=0 path: a prior restore may have failed mid-way, leaving
    #     watersheds/rivers partially populated. Restoring on top of those
    #     rows trips unique-key violations.
    #   - force_master=1 path: the operator explicitly asked for a clean
    #     overwrite.
    # CASCADE wipes observations / raw_snapshots / match_review too. When
    # dams=0 those rows reference non-existent dam IDs anyway (orphans).
    # The synth seeder below (or live ingest) repopulates observations.
    log "[bootstrap] truncating master + dependent tables (CASCADE) before restore"
    psql "$DATABASE_URL" -v ON_ERROR_STOP=0 -q -c "
      TRUNCATE TABLE
        source_priorities, dams, rivers, watersheds
      RESTART IDENTITY CASCADE;
    " >/dev/null
    log "[bootstrap] restoring /seed/master.sql.gz"
    restore_log=$(gunzip -c /seed/master.sql.gz | psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -X -q 2>&1)
    restore_status=$?
    if [ ${restore_status} -eq 0 ]; then
      dams=$(count_or_empty "SELECT COUNT(*) FROM dams")
      log "[bootstrap] dams.count after restore = '${dams}'"
    else
      log "[bootstrap] seed restore FAILED (status=${restore_status}, non-fatal):"
      echo "${restore_log}" | head -30 | while IFS= read -r line; do
        log "  ${line}"
      done
    fi
  else
    log "[bootstrap] no seed file at /seed/master.sql.gz — skipping master restore"
  fi
fi

# Always run the master upsert when the file is present — it's idempotent
# and converges prod's master rows to the bundled snapshot without touching
# observations. No env flag required so a normal redeploy is enough to
# refresh master metadata after a Damnet re-crawl. Add stdout+stderr capture
# so the operator can inspect what changed in `coolify application_logs`.
if [ -f /seed/master_upsert.sql.gz ]; then
  log "[bootstrap] applying /seed/master_upsert.sql.gz (idempotent UPSERT, observations preserved)"
  upsert_log=$(gunzip -c /seed/master_upsert.sql.gz | psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -X -q 2>&1)
  upsert_status=$?
  if [ ${upsert_status} -eq 0 ]; then
    dams=$(count_or_empty "SELECT COUNT(*) FROM dams")
    log "[bootstrap] dams.count after upsert = '${dams}'"
  else
    log "[bootstrap] master upsert FAILED (status=${upsert_status}, non-fatal):"
    # Tee the first 30 error lines into the bootstrap log so we can inspect
    # what postgres rejected without docker exec.
    echo "${upsert_log}" | head -30 | while IFS= read -r line; do
      log "  ${line}"
    done
  fi
fi

obs=$(count_or_empty "SELECT COUNT(*) FROM observations")
log "[bootstrap] observations.count = '${obs}'"

# One-shot synthetic purge. The synthetic seed was visually indistinguishable
# from a stuck crawler ("最新観測値: 2026-05-05" on every uncovered dam),
# so when we have a real-source story across multiple dams we drop the seed
# entirely. SET LOCAL lifts the per-DML decompression cap for this one
# transaction; chunks are recompressed by Timescale's policy on schedule.
if [ "${BOOTSTRAP_REFRESH_AGGREGATES:-}" = "1" ]; then
  log "[bootstrap] BOOTSTRAP_REFRESH_AGGREGATES=1 — refreshing obs_daily & obs_monthly continuous aggregates"
  # Each CALL must run OUTSIDE a transaction (Timescale's refresh procedure
  # opens its own). Passing two CALL statements to a single `psql -c` wraps
  # them in an implicit BEGIN/COMMIT and the first one fails. Run each via
  # its own `psql -c` invocation so each gets its own session.
  refresh_one() {
    label="$1"
    sql="$2"
    out=$(psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -X -q -c "${sql}" 2>&1)
    rc=$?
    if [ ${rc} -eq 0 ]; then
      log "[bootstrap] refresh.${label} OK"
    else
      log "[bootstrap] refresh.${label} FAILED (rc=${rc}, non-fatal):"
      echo "${out}" | head -20 | while IFS= read -r line; do
        log "  ${line}"
      done
    fi
  }
  refresh_one "obs_daily"   "CALL refresh_continuous_aggregate('obs_daily',   '2019-01-01', NULL);"
  refresh_one "obs_monthly" "CALL refresh_continuous_aggregate('obs_monthly', '2019-01-01', NULL);"
fi

if [ "${BOOTSTRAP_PURGE_SYNTHETIC:-}" = "1" ]; then
  log "[bootstrap] BOOTSTRAP_PURGE_SYNTHETIC=1 — deleting all synthetic observations"
  before=$(count_or_empty "SELECT COUNT(*) FROM observations WHERE source_id = 'synthetic'")
  log "  synthetic rows to purge: ${before}"
  purge_log=$(psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -X -q -c "
    BEGIN;
    SET LOCAL timescaledb.max_tuples_decompressed_per_dml_transaction = 0;
    DELETE FROM observations WHERE source_id = 'synthetic';
    UPDATE source_priorities SET active = false WHERE source_id = 'synthetic';
    COMMIT;
  " 2>&1)
  purge_status=$?
  if [ ${purge_status} -eq 0 ]; then
    after=$(count_or_empty "SELECT COUNT(*) FROM observations")
    log "[bootstrap] purge OK — observations.count now ${after} (was synthetic=${before})"
    obs="${after}"
  else
    log "[bootstrap] purge FAILED (status=${purge_status}, non-fatal):"
    echo "${purge_log}" | head -30 | while IFS= read -r line; do
      log "  ${line}"
    done
  fi
fi

# One-shot kick: clean up orphan observations (rows referencing dam_id that
# no longer exists after a master TRUNCATE) and clear failed graphile-worker
# jobs that block the queue. Then enqueue master refreshes + the kasenbosai
# observations crawl so prod gets fresh data without waiting for the daily
# cron. Triggered by BOOTSTRAP_KICK=1 (UNSET this env after the boot
# succeeds).
kick="${BOOTSTRAP_KICK:-}"
if [ "${kick}" = "1" ]; then
  log "[bootstrap] BOOTSTRAP_KICK=1 — cleaning + enqueuing crawl jobs"

  # Per-step so a failure in one (e.g. _private_jobs schema variant) doesn't
  # block the others.
  run_kick_step() {
    label="$1"
    sql="$2"
    out=$(psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -X -q -c "${sql}" 2>&1)
    rc=$?
    if [ ${rc} -eq 0 ]; then
      log "[bootstrap] kick.${label} OK"
    else
      log "[bootstrap] kick.${label} FAILED (rc=${rc}):"
      echo "${out}" | head -10 | while IFS= read -r line; do
        log "  ${line}"
      done
    fi
  }

  # 1. Orphan observation cleanup — rows referencing dam_id that no longer
  # exists after master TRUNCATE. Their compressed Timescale chunks trip
  # 'tuple decompression limit exceeded' in quality:recompute.
  #
  # SET LOCAL within the same -c session removes the 100k per-DML
  # decompression cap, since we genuinely want to scan every chunk to
  # find orphans. The cleanup ran for the first time on 2026-05-11
  # against ~4.8M orphan rows and now stays small from one deploy to
  # the next; the SET-LOCAL keeps re-runs safe regardless of size.
  run_kick_step "orphan_obs" \
    "BEGIN; SET LOCAL timescaledb.max_tuples_decompressed_per_dml_transaction = 0; DELETE FROM observations WHERE dam_id NOT IN (SELECT id FROM dams); COMMIT;"

  # 2. Clear stuck graphile-worker jobs (>= 3 attempts).
  run_kick_step "drop_stuck_jobs" \
    "DELETE FROM graphile_worker._private_jobs WHERE attempts >= 3;"

  # 3. Enqueue the cheap live-ingest jobs so prod gets fresh observation
  # data without waiting for the next cron tick. These are small (one HTTP
  # fetch each) and finish in seconds.
  run_kick_step "enqueue_ingest"  "SELECT graphile_worker.add_job('ingest:kasenbosai',     '{}'::json);"
  run_kick_step "enqueue_tokyo"   "SELECT graphile_worker.add_job('ingest:tokyo-waterworks','{}'::json);"
  run_kick_step "enqueue_jwa"     "SELECT graphile_worker.add_job('ingest:jwa-junpo','{}'::json);"
  run_kick_step "enqueue_aitoyo"  "SELECT graphile_worker.add_job('ingest:aitoyo','{}'::json);"
  run_kick_step "enqueue_jwachikugo" "SELECT graphile_worker.add_job('ingest:jwa-chikugo','{}'::json);"
  run_kick_step "enqueue_kanagawa" "SELECT graphile_worker.add_job('ingest:kanagawa-dam','{}'::json);"
  run_kick_step "enqueue_shiga"    "SELECT graphile_worker.add_job('ingest:shiga-bousai','{}'::json);"
  run_kick_step "enqueue_tottori"  "SELECT graphile_worker.add_job('ingest:tottori-dam','{}'::json);"
  run_kick_step "enqueue_aomori"   "SELECT graphile_worker.add_job('ingest:aomori-dam','{}'::json);"
  run_kick_step "enqueue_hkd_mlit" "SELECT graphile_worker.add_job('ingest:hkd-mlit-dam','{}'::json);"
  run_kick_step "enqueue_cgr_mlit" "SELECT graphile_worker.add_job('ingest:cgr-mlit-dam','{}'::json);"
  run_kick_step "enqueue_ktr_kinu" "SELECT graphile_worker.add_job('ingest:ktr-kinu-dam','{}'::json);"
  run_kick_step "enqueue_hrr_mlit" "SELECT graphile_worker.add_job('ingest:hrr-mlit-dam','{}'::json);"
  run_kick_step "enqueue_kasenbosai_v2" "SELECT graphile_worker.add_job('ingest:kasenbosai-v2','{}'::json);"
  run_kick_step "enqueue_chiba"        "SELECT graphile_worker.add_job('ingest:chiba-suisei','{}'::json);"
  run_kick_step "enqueue_okayama"      "SELECT graphile_worker.add_job('ingest:okayama-bousai','{}'::json);"
  run_kick_step "enqueue_niigata"      "SELECT graphile_worker.add_job('ingest:niigata-bousai','{}'::json);"
  run_kick_step "enqueue_hyogo"        "SELECT graphile_worker.add_job('ingest:hyogo-bodik','{}'::json);"
  run_kick_step "enqueue_tochigi"      "SELECT graphile_worker.add_job('ingest:tochigi-bodik','{}'::json);"
  run_kick_step "enqueue_hiroshima"    "SELECT graphile_worker.add_job('ingest:hiroshima-bousai','{}'::json);"
  run_kick_step "enqueue_osaka"        "SELECT graphile_worker.add_job('ingest:osaka-bousai','{}'::json);"
  run_kick_step "enqueue_tottori_bousai" "SELECT graphile_worker.add_job('ingest:tottori-bousai','{}'::json);"
  run_kick_step "enqueue_fukuoka_bodik"  "SELECT graphile_worker.add_job('ingest:fukuoka-bodik','{}'::json);"
  run_kick_step "enqueue_shimane_bousai" "SELECT graphile_worker.add_job('ingest:shimane-bousai','{}'::json);"
  run_kick_step "enqueue_jwa_toneara"    "SELECT graphile_worker.add_job('ingest:jwa-toneara','{}'::json);"
  run_kick_step "enqueue_jwa_chubu"      "SELECT graphile_worker.add_job('ingest:jwa-chubu','{}'::json);"

  # 一回限り: 川の防災情報 (kasenbosai) ダムカタログを scrape して
  # 全国 ~900 ダムの obs_fcd を master.external_ids.kasenbosai に投入。
  # 既存値があれば idempotent (差分のみ書き換え)。
  if [ "${BOOTSTRAP_MATCH_KASENBOSAI:-}" = "1" ]; then
    log "[bootstrap] BOOTSTRAP_MATCH_KASENBOSAI=1 — enqueue match:kasenbosai job"
    run_kick_step "enqueue_match_kb" "SELECT graphile_worker.add_job('match:kasenbosai','{}'::json);"
  fi

  # 3b. Heavy master refreshes (NDI re-import, Damnet re-scrape) are now
  # gated behind their own env. They take 30-60 min each, saturate the
  # worker's concurrency=4 thread pool, and starve the cron scheduler — we
  # saw the 2026-05-10 deploy wedge all daily crons for >12 hours because
  # the kick fired them. They have their own monthly cron schedule, so a
  # routine deploy doesn't need to re-trigger them.
  if [ -n "${BOOTSTRAP_KICK_MASTER:-}" ]; then
    log "[bootstrap] BOOTSTRAP_KICK_MASTER=${BOOTSTRAP_KICK_MASTER} — enqueue heavy master refreshes"
    run_kick_step "enqueue_ndi"    "SELECT graphile_worker.add_job('master:refresh:ndi',    '{}'::json);"
    run_kick_step "enqueue_damnet" "SELECT graphile_worker.add_job('master:refresh:damnet', '{}'::json);"
  fi

  # 4. Optional one-time historical backfill of JWA junpo. Walks the 旬報
  # archive for the past N months (default 12 → ~36 page fetches × 26 dams
  # → 700+ rows). Gated by a SEPARATE env so a normal BOOTSTRAP_KICK=1
  # restart doesn't re-fetch the archive every time. UNSET
  # BOOTSTRAP_BACKFILL_JWA after the boot succeeds.
  if [ -n "${BOOTSTRAP_BACKFILL_JWA:-}" ]; then
    months="${BOOTSTRAP_BACKFILL_JWA}"
    # Treat '1' as a shorthand for the default 12-month window.
    if [ "${months}" = "1" ]; then
      months=12
    fi
    log "[bootstrap] BOOTSTRAP_BACKFILL_JWA=${BOOTSTRAP_BACKFILL_JWA} — enqueue jwa-junpo backfill (months=${months})"
    run_kick_step "enqueue_jwa_backfill" \
      "SELECT graphile_worker.add_job('backfill:jwa-junpo', json_build_object('months', ${months}));"
  fi

  if [ -n "${BOOTSTRAP_BACKFILL_MUDAM:-}" ]; then
    years="${BOOTSTRAP_BACKFILL_MUDAM}"
    # Treat '1' as a shorthand for the default 5-year window.
    if [ "${years}" = "1" ]; then
      years=5
    fi
    log "[bootstrap] BOOTSTRAP_BACKFILL_MUDAM=${BOOTSTRAP_BACKFILL_MUDAM} — enqueue mudam backfill (years=${years}, all districts)"
    run_kick_step "enqueue_mudam_backfill" \
      "SELECT graphile_worker.add_job('backfill:mudam', json_build_object('district', 'all', 'years', ${years}));"
  fi

  obs=$(count_or_empty "SELECT COUNT(*) FROM observations")
  log "[bootstrap] observations.count after kick = '${obs}'"
fi

force_obs="${BOOTSTRAP_FORCE_OBSERVATIONS:-}"
if [ "${force_obs}" = "1" ] && [ "${obs}" != "0" ]; then
  log "[bootstrap] BOOTSTRAP_FORCE_OBSERVATIONS=1 — truncating observations"
  psql "$DATABASE_URL" -v ON_ERROR_STOP=0 -q -c "TRUNCATE TABLE observations RESTART IDENTITY CASCADE;" >/dev/null
  obs="0"
fi

# Synthetic seeder: only runs when both observations is empty AND the
# operator explicitly opts in. We dropped the auto-seed-when-empty
# behaviour because the seed values are visually indistinguishable from
# a stuck crawler in the UI and we now have multiple real sources.
# To re-enable for a one-off (e.g. fresh prod bring-up), set
# BOOTSTRAP_SEED_SYNTHETIC=1 alongside an empty observations table.
if [ "${BOOTSTRAP_SEED_SYNTHETIC:-}" = "1" ] && [ "${obs}" = "0" ] && [ -n "${dams}" ] && [ "${dams}" != "0" ]; then
  log "[bootstrap] BOOTSTRAP_SEED_SYNTHETIC=1 + observations empty → running synthetic seeder (≈30s)"
  if ! bun run /app/apps/web/bin/seed_synthetic_observations.ts --hourly-days 30 --years 5; then
    log "[bootstrap] synthetic seeder failed (non-fatal); continuing"
  fi
fi

log "[bootstrap] starting Next.js"
cd /app/apps/web
exec bun next start -p 3000
