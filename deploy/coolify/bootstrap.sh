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

force_obs="${BOOTSTRAP_FORCE_OBSERVATIONS:-}"
if [ "${force_obs}" = "1" ] && [ "${obs}" != "0" ]; then
  log "[bootstrap] BOOTSTRAP_FORCE_OBSERVATIONS=1 — truncating observations"
  psql "$DATABASE_URL" -v ON_ERROR_STOP=0 -q -c "TRUNCATE TABLE observations RESTART IDENTITY CASCADE;" >/dev/null
  obs="0"
fi

if [ "${obs}" = "0" ] && [ -n "${dams}" ] && [ "${dams}" != "0" ]; then
  log "[bootstrap] observations empty → running synthetic seeder (≈30s)"
  if ! bun run /app/apps/web/bin/seed_synthetic_observations.ts --hourly-days 30 --years 5; then
    log "[bootstrap] synthetic seeder failed (non-fatal); continuing"
  fi
fi

log "[bootstrap] starting Next.js"
cd /app/apps/web
exec bun next start -p 3000
