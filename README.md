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
