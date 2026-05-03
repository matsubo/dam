#!/bin/sh
# Web container boot sequence: migrate → seed-if-empty → start.
# Idempotent — safe to run on every restart.
set -eu

cd /app

echo "[bootstrap] applying pending migrations…"
bun run --filter @dam/db migrate

# Parse DATABASE_URL once so psql + bun can both reach the DB.
# Format: postgres://user:pass@host:port/dbname
PG_URL="${DATABASE_URL:?DATABASE_URL must be set}"

dam_count() {
  bun -e "import { sql } from '/app/packages/db/src/client.ts';
const r = await sql\`SELECT COUNT(*)::INT AS c FROM dams\`;
console.log(r[0].c);
await sql.end();"
}

obs_count() {
  bun -e "import { sql } from '/app/packages/db/src/client.ts';
const r = await sql\`SELECT COUNT(*)::INT AS c FROM observations\`;
console.log(r[0].c);
await sql.end();"
}

dams=$(dam_count)
echo "[bootstrap] dams.count = ${dams}"

if [ "${dams}" = "0" ]; then
  if [ -f /seed/master.sql.gz ]; then
    echo "[bootstrap] dams empty → restoring /seed/master.sql.gz"
    gunzip -c /seed/master.sql.gz | psql "${PG_URL}" -v ON_ERROR_STOP=1 -q
    dams=$(dam_count)
    echo "[bootstrap] dams.count after restore = ${dams}"
  else
    echo "[bootstrap] no seed file at /seed/master.sql.gz — skipping master restore"
  fi
fi

obs=$(obs_count)
echo "[bootstrap] observations.count = ${obs}"

if [ "${obs}" = "0" ] && [ "${dams}" != "0" ]; then
  echo "[bootstrap] observations empty → running synthetic seeder (this takes ~30s)"
  bun run /app/apps/web/bin/seed_synthetic_observations.ts --hourly-days 30 --years 5 || \
    echo "[bootstrap] synthetic seeder failed (non-fatal); continuing"
fi

echo "[bootstrap] starting Next.js"
cd /app/apps/web
exec bun next start -p 3000
