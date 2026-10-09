#!/usr/bin/env bash
# Runs inside the freshly built image (as uid 26) from
# .github/workflows/postgres-image.yml: starts a throwaway server and checks
# that every extension the production catalog uses loads at exactly the pinned
# version, and that TimescaleDB is the TSL edition (compression works).
set -euo pipefail

: "${TIMESCALEDB_VERSION:?}" "${TOOLKIT_VERSION:?}" "${POSTGIS_VERSION:?}"

for bin in initdb postgres pg_ctl pg_controldata pg_basebackup; do
  command -v "$bin" >/dev/null || { echo "missing on PATH: $bin"; exit 1; }
done
[ "$(id -u)" = 26 ] || { echo "expected uid 26, got $(id -u)"; exit 1; }

export PGDATA=/tmp/pgdata PGHOST=/tmp PGUSER=postgres PGDATABASE=postgres
initdb -U postgres --locale-provider=libc --locale=C.UTF-8 >/dev/null
pg_ctl -w -l /tmp/pg.log -o "-c shared_preload_libraries=timescaledb -c listen_addresses= -c unix_socket_directories=/tmp -c timescaledb.telemetry_level=off" start >/dev/null

q() { psql -XAtq -v ON_ERROR_STOP=1 -c "$1"; }
expect() {
  local got
  got="$(q "$2")"
  if [ "$got" != "$3" ]; then echo "FAIL $1: got '$got', want '$3'"; exit 1; fi
  echo "ok   $1 = $got"
}

q "CREATE EXTENSION timescaledb VERSION '$TIMESCALEDB_VERSION'"
q "CREATE EXTENSION timescaledb_toolkit VERSION '$TOOLKIT_VERSION'"
q "CREATE EXTENSION postgis VERSION '$POSTGIS_VERSION'"
q "CREATE EXTENSION pg_trgm"
q "CREATE EXTENSION pgcrypto"

expect timescaledb "SELECT extversion FROM pg_extension WHERE extname = 'timescaledb'" "$TIMESCALEDB_VERSION"
expect license "SHOW timescaledb.license" timescale
expect toolkit "SELECT extversion FROM pg_extension WHERE extname = 'timescaledb_toolkit'" "$TOOLKIT_VERSION"
expect postgis "SELECT extversion FROM pg_extension WHERE extname = 'postgis'" "$POSTGIS_VERSION"
expect postgis_lib "SELECT postgis_lib_version()" "$POSTGIS_VERSION"
expect collation "SELECT datcollate || '/' || datctype FROM pg_database WHERE datname = 'postgres'" "C.UTF-8/C.UTF-8"

# TSL-only feature: columnstore compression of a hypertable chunk.
q "CREATE TABLE obs (ts timestamptz NOT NULL, dam int NOT NULL, v double precision)"
q "SELECT create_hypertable('obs', 'ts')" >/dev/null
q "INSERT INTO obs SELECT t, 1, random() FROM generate_series(now() - interval '3 days', now(), interval '1 hour') t"
q "ALTER TABLE obs SET (timescaledb.compress, timescaledb.compress_segmentby = 'dam')"
q "SELECT count(compress_chunk(c)) FROM show_chunks('obs') c" >/dev/null
expect compressed_rows "SELECT count(*) FROM obs" 73
expect toolkit_call "SELECT round(average(time_weight('Linear', ts, v)) * 0) FROM obs" 0
expect postgis_call "SELECT ST_AsText(ST_Transform(ST_SetSRID(ST_MakePoint(139.69, 35.69), 4326), 3857)) IS NOT NULL" t
expect trgm_ja "SELECT show_trgm('黒部ダム') <> '{}'" t

pg_ctl -w stop >/dev/null
echo "smoke test passed"
