# Dam Data Platform

Realtime and historical reservoir-level data for dams across Japan.

## Local development

```sh
just up           # start Postgres + MinIO
just migrate      # run database migrations
just dev-web     # http://localhost:3000
just dev-worker  # graphile-worker
```

## Master imports

```sh
just import-ndi-watersheds -- --source tests/fixtures/ndi/w07_sample.geojson
just import-ndi-dams       -- --source tests/fixtures/ndi/w01_sample.geojson
just import-damnet         -- --list tests/fixtures/damnet/list.html
```

## API

- `GET /api/v1/healthz`
- `GET /api/v1/watershed?lat=&lng=` — point-in-polygon watershed lookup
- `GET /api/v1/sources` — data-source registry

See `docs/superpowers/specs/2026-05-01-dam-data-platform-design.md`.

## Running ingest (Plan 2)

```sh
just up                  # postgres + minio
just ensure-bucket       # create the dam-raw bucket if missing
just migrate
just dev-worker          # graphile-worker (registers all tasks)

# Trigger a one-off run from the DB
docker compose exec db psql -U dam -d dam \
  -c "SELECT graphile_worker.add_job('ingest:kasenbosai');"

# Backfill: enqueue the full year × dam matrix once
docker compose exec db psql -U dam -d dam \
  -c "SELECT graphile_worker.add_job('backfill:suimon:enqueue', '{\"fromYear\":2015,\"toYear\":2024}');"
```

The hourly cron triggers `ingest:kasenbosai` at minute :05 of every hour.
Backfill batches run every 5 minutes with `SUIMON_BATCH` targets each.


## Contributing

The platform is built and operated by one person, and observation coverage is
the bottleneck — see https://dam.teraren.com/contribute for what needs doing,
the stack, and the terms. Reports of public data sources we have missed are as
welcome as code. Donations: https://github.com/sponsors/matsubo
