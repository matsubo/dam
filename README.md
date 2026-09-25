# Dam Data Japan

Source code for **[dam.teraren.com](https://dam.teraren.com)**, a free, non-commercial
site and API that collects reservoir data for dams across Japan in one place.

- **Master data**: about 2,749 dams and 644 river systems, built from 国土数値情報
  (W01 / W05 / W07) and ダム便覧.
- **Observations**: hourly storage volume, storage rate, inflow and outflow, stored
  in a TimescaleDB hypertable. They are collected from about 70 public upstream
  sources: national and prefectural 河川防災 systems, open-data portals and
  operator sites.
- **Coverage transparency**: [/coverage](https://dam.teraren.com/coverage) shows, for
  every dam, whether some provider publishes its data and we have not ingested it
  yet, or whether no provider publishes it at all.

The repository is public so anyone can audit how a number reaches the chart and
help debug the pipeline.

## Reporting a problem

Open an [issue](https://github.com/matsubo/dam/issues). The most useful report
includes the page URL, the value you saw, and the upstream page that disagrees
with it. Reports of public data sources we have missed are as welcome as bug
reports. See [CONTRIBUTING.md](CONTRIBUTING.md). Report security issues through
the Security tab, not in a public issue.

## Architecture

```
upstream sites ──► apps/worker (graphile-worker tasks) ──► PostgreSQL + TimescaleDB ──► apps/web (Next.js)
                        │                                                                  ├─ web pages
                        └─► MinIO (raw payload archive)                                    └─ /api/v1 (HAL+JSON)
```

| Path | Role |
|---|---|
| `apps/web` | Next.js site and the `/api/v1` REST API (HAL+JSON with `_links`) |
| `apps/worker` | graphile-worker: one ingest task per upstream source, plus aggregates and quality recompute |
| `packages/db` | SQL migrations, the postgres.js client and repository functions |
| `packages/adapters/*` | Parsers for the master and history sources (NDI, ダム便覧, 川の防災情報, 水文水質DB) |
| `packages/reconciler` | Matches upstream dam names and coordinates to master records |
| `packages/ingest`, `packages/storage`, `packages/core` | Shared ingest plumbing, raw-payload storage, domain types |

Start with [AGENTS.md](AGENTS.md), then `docs/llm/`: `PROJECT_OVERVIEW`, `CODEMAP`,
`DATA_FLOW`, `RUNBOOK` and `CONVENTIONS`. The product and architecture spec is
`docs/superpowers/specs/2026-05-01-dam-data-platform-design.md`.

## Local development

Requires [Bun](https://bun.sh), Node.js 24+, Docker and [just](https://github.com/casey/just).

```sh
cp .env.example .env
bun install
just up              # Postgres (TimescaleDB) + MinIO
just ensure-bucket   # create the raw-payload bucket
just migrate
just dev-web         # http://localhost:3000
just dev-worker      # graphile-worker with every task registered
```

Load sample master data from the test fixtures:

```sh
just import-ndi-watersheds -- --source tests/fixtures/ndi/w07_sample.geojson
just import-ndi-dams       -- --source tests/fixtures/ndi/w01_sample.geojson
just import-damnet         -- --list tests/fixtures/damnet/list.html
```

### Checks

```sh
just check           # lint + typecheck + unit/integration tests (mirrors CI)
just e2e             # Playwright
```

The integration tests share whatever database `DATABASE_URL` points to and do
not reset it, so run them against a fresh database. `just reset-db` recreates the
local one; it deletes the local Docker volumes.

## API

The API is documented at [/api/docs](https://dam.teraren.com/api/docs), and the
OpenAPI document is at `/api/v1/openapi.json`. Data endpoints need a free API key,
which you can issue at [/account/keys](https://dam.teraren.com/account/keys) after
signing in with Google.

## Data sources and licences

Every upstream source is listed with its terms on
[/sources](https://dam.teraren.com/sources). In particular, dam attributes,
locations, river-system classes and boundaries are derived from 国土数値情報
W01 / W05 / W07 (国土交通省), which are licensed for **non-commercial use only**
under the 旧国土情報利用約款. Data you obtain from this site or its API
inherits that restriction. See the [terms of use](https://dam.teraren.com/legal/terms).

Raw upstream archives are not committed. `data/` is gitignored, and only
derived artefacts such as classifications and the master seed are in the repository.

## License

The source code is available under the [PolyForm Shield License 1.0.0](LICENSE).
This is not an OSI open-source licence. You may read, run, modify and debug the
code for any purpose except providing a product that competes with
dam.teraren.com. The project name, domain and logo are not licensed.

Copyright (c) 2026 Yuki Matsukura. Donations:
[GitHub Sponsors](https://github.com/sponsors/matsubo).
