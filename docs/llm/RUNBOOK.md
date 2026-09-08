# Runbook — operator + LLM-agent procedures

## First-time bring-up (local)

```sh
cp .env.example .env
just up                    # docker compose: db (5433) + minio (9000)
just ensure-bucket         # creates dam-raw bucket
just migrate               # applies 0000–0020 migrations

# (optional) populate master data
mkdir -p data/nlni
curl -o data/nlni/W01.zip https://nlftp.mlit.go.jp/ksj/gml/data/W01/W01-14/W01-14_GML.zip
unzip -d data/nlni/W01 data/nlni/W01.zip
ogr2ogr -f GeoJSON data/nlni/w01.geojson data/nlni/W01/W01-14-g_Dam.shp
bun run apps/web/bin/import_real_ndi_w01.ts data/nlni/w01.geojson
bun run apps/web/bin/import_watersheds_from_w01.ts data/nlni/w01.geojson
bun run apps/web/bin/import_real_ndi_w01.ts data/nlni/w01.geojson  # re-link

# (optional) 一級/二級 classification: W05 + 水系域コード → migration, then apply
bin/fetch_w05.sh                                    # 47 zips (~340 MB) → data/nlni/w05/
bun run apps/web/bin/classify_watershed_kind.ts     # writes packages/db/migrations/0041_….sql
bun run packages/db/src/migrate.ts
bun run apps/web/bin/generate_master_upsert.ts      # the seed rewrites kind on deploy — keep in sync

# (optional) synthetic observations so charts render
bun run apps/web/bin/seed_synthetic_observations.ts --hourly-days 30 --years 5

# (optional) damnet attribute backfill
bun run apps/web/bin/capture_damnet.ts --from 123500 --to 128000
bun run apps/web/bin/match_damnet.ts data/damnet/dams.jsonl

# Start dev server (LAN-accessible from this machine)
cd apps/web && API_AUTH_BYPASS=1 \
  NEXT_PUBLIC_SITE_URL=http://mini.local:3030 \
  bun next dev -H 0.0.0.0 -p 3030
```

## Day-to-day commands

```sh
just up                     # start db + minio
just down                   # stop both
just migrate                # apply pending migrations
just reset-db               # wipe + recreate (drops volume!)
just dev-web                # next dev (default)
just dev-worker             # graphile-worker
just check                  # lint + typecheck + test
bunx playwright test        # 26 E2E tests (auto-spawns dev server on 3031)
just e2e                    # alias
```

## API key management

```sh
just api-key-issue email=foo@example.com label="research access"
# → prints {id, prefix, plaintext}; share plaintext once, never store

just api-key-list
just api-key-revoke id=42
```

The `X-API-Key` header is required for every endpoint except `/healthz`
and `/sources`. Set `API_AUTH_BYPASS=1` to disable auth for local dev / E2E.

## Failure scenarios

### Dev server returns 500 with `ENOENT: ... .next/server/app/...page.js`

Stale build cache (usually after biome auto-format mid-compile).

```sh
kill $(cat /tmp/devsrv.pid 2>/dev/null) 2>/dev/null
rm -rf apps/web/.next
just dev-web
```

### "sorry, too many clients already"

Postgres connection limit (default 100) hit. Usually caused by long-running
QA passes against the dev server (HMR creates new module instances each
holding their own pool).

```sh
docker compose exec db psql -U dam -d dam \
  -c "SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE state='idle' AND pid <> pg_backend_pid();"
# or if that fails too:
docker compose restart db
# then restart the dev server
```

### Bun + Next: "ERR_PNPM_WORKSPACE_PKG_NOT_FOUND" on dev start

Next 15 tries to use pnpm to auto-install missing types. Pre-install:

```sh
bun add -d @types/node --cwd apps/web
```

### Production data wiped by integration test

If `dams` row count drops to zero unexpectedly, the most likely cause is an
old version of `import_dams.test.ts` running its overly-broad cleanup
(`DELETE FROM dams WHERE external_ids ? 'ndi'`). The current code is
scoped to fixture IDs only — verify with:

```sh
grep "DELETE FROM dams" packages/adapters/ndi/src/import_dams.test.ts
# should show: WHERE external_ids ->> 'ndi' IN ('1234567890','9999999999')
```

Recover by re-running the master importer:

```sh
bun run apps/web/bin/import_real_ndi_w01.ts data/nlni/w01.geojson
bun run apps/web/bin/match_damnet.ts data/damnet/dams.jsonl
```

### Watershed page returns 404 for kanji slug

Page handler isn't decoding the URL-encoded slug. Confirm:

```sh
grep -A1 "decodeURIComponent" apps/web/app/watersheds/\[slug\]/page.tsx
grep -A1 "decodeURIComponent" apps/web/app/dams/\[slug\]/page.tsx
```

Both should call `decodeURIComponent(rawSlug)` on `params.slug`. Route
handlers under `app/api/...` decode automatically — this is a Next 15 quirk
that affects page components only.

### Chart shows zero plot points

The route filters by `preferredSource()` (highest-priority source from
`source_priorities`). If the priorities don't match the data:

```sql
SELECT source_id, priority FROM source_priorities ORDER BY priority DESC;
SELECT source_id, COUNT(*) FROM observations GROUP BY source_id;
```

Either bump the source that has data, or have the synth seeder run again
(it pins synthetic to 200).

### MinIO image not pullable

`docker compose pull minio` may fail if the pinned tag was rotated. Pick a
recent tag from https://hub.docker.com/r/minio/minio/tags and update
`docker-compose.yml`. Bucket survives the restart.

### Real upstream blocks the scraper

`www.river.go.jp/kawabou/` returns 403 with explicit message
"Access Restrictions — This site prohibits data acquisition using tools."
Until you negotiate access (contact form on the site), keep using the
synthetic seeder. Document any access agreement in `docs/superpowers/plans/`.

## Backup / restore (production, Coolify)

Configured in `deploy/backup/pgbackrest.conf`. Default schedule:
- full backup weekly (Sun 02:00 UTC)
- diff hourly
- retention: 4 fulls + 14 diffs
- destination: external S3 with AES-256-CBC at rest

Restore PITR:

```sh
# Stop the worker first; web can stay running but will return errors
coolify worker stop dam
pgbackrest restore --stanza=main --type=time --target="2026-05-02 03:00:00+09"
coolify worker start dam
```

Verify with:

```sql
SELECT MAX(observed_at) FROM observations;
SELECT COUNT(*) FROM dams;
```

## Deploy

Coolify pulls from main, runs `Dockerfile.web` for app and `Dockerfile.worker`
for the worker. Compose file is `docker-compose.yaml` at the repo root.

Required Coolify secrets:

```
DATABASE_URL              postgres://dam:CHANGEME@db:5432/dam
S3_ENDPOINT               http://minio:9000
S3_ACCESS_KEY             CHANGEME
S3_SECRET_KEY             CHANGEME
S3_BUCKET                 dam-raw
NEXT_PUBLIC_SITE_URL      https://your-public-host
HTTP_CONTACT_EMAIL        ops@your-domain
KASENBOSAI_BASE_URL       (leave unset until access granted)
```

After first deploy: run `just migrate` inside the web container, then
`just import-ndi-watersheds` and `just import-ndi-dams` from a host with
`data/nlni/...` available.

## Long-running / cron tasks

Worker process registers these task names:

```
master:refresh:ndi          monthly 1st 03:00
master:refresh:damnet       monthly 5th 03:00
master:match                nightly 04:00
ingest:kasenbosai           hourly :05
backfill:suimon:enqueue     manual (add_job from psql)
backfill:suimon:run         every 5 min
quality:recompute           nightly 04:30
```

To trigger a one-off run from psql:

```sql
SELECT graphile_worker.add_job('quality:recompute');
SELECT graphile_worker.add_job('backfill:suimon:enqueue', '{"fromYear":2015,"toYear":2024}');
```

To inspect queued + failed jobs:

```sql
SELECT id, task_identifier, attempts, max_attempts, last_error
FROM graphile_worker.jobs ORDER BY created_at DESC LIMIT 20;
```

## Where the operator runbook lives

`deploy/ops/runbook.md` is the long-form operational doc covering everything
above plus capacity planning. This file is the LLM-quick-reference subset.
