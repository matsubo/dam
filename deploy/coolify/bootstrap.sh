#!/bin/sh
# Web container boot sequence: migrate → seed-if-empty → start.
# Idempotent — safe to run on every restart.
#
# We deliberately AVOID `set -eu`. A non-fatal failure in the bootstrap
# (e.g. seed file checksum drift, observations seed timeout) shouldn't keep
# the web app from serving — better to start with whatever data we have and
# let the operator re-trigger the seed manually.

echo "[bootstrap] $(date -u +%FT%TZ) starting"

cd /app

if [ -z "${DATABASE_URL:-}" ]; then
  echo "[bootstrap] FATAL: DATABASE_URL is unset"
  exit 1
fi

# psql is installed by the Dockerfile (postgresql-client). Use it for the
# count queries — simpler and no bun -e quoting tricks.
count_or_empty() {
  psql "$DATABASE_URL" -tA -v ON_ERROR_STOP=0 -c "$1" 2>/dev/null | tr -d '[:space:]'
}

echo "[bootstrap] applying pending migrations…"
if ! bun run --filter @dam/db migrate; then
  echo "[bootstrap] migrations failed — continuing so the app at least serves"
fi

dams=$(count_or_empty "SELECT COUNT(*) FROM dams")
echo "[bootstrap] dams.count = '${dams}'"

if [ "${dams}" = "0" ]; then
  if [ -f /seed/master.sql.gz ]; then
    echo "[bootstrap] dams empty → restoring /seed/master.sql.gz"
    if gunzip -c /seed/master.sql.gz | psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -q; then
      dams=$(count_or_empty "SELECT COUNT(*) FROM dams")
      echo "[bootstrap] dams.count after restore = '${dams}'"
    else
      echo "[bootstrap] seed restore failed (non-fatal)"
    fi
  else
    echo "[bootstrap] no seed file at /seed/master.sql.gz — skipping master restore"
  fi
fi

obs=$(count_or_empty "SELECT COUNT(*) FROM observations")
echo "[bootstrap] observations.count = '${obs}'"

if [ "${obs}" = "0" ] && [ -n "${dams}" ] && [ "${dams}" != "0" ]; then
  echo "[bootstrap] observations empty → running synthetic seeder (≈30s)"
  if ! bun run /app/apps/web/bin/seed_synthetic_observations.ts --hourly-days 30 --years 5; then
    echo "[bootstrap] synthetic seeder failed (non-fatal); continuing"
  fi
fi

echo "[bootstrap] starting Next.js"
cd /app/apps/web
exec bun next start -p 3000
