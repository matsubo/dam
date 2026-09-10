# Coolify deployment

This directory holds the artifacts Coolify needs to build and run dam in
production. The full operator runbook (backups, scrapers, on-call) lives in
[`deploy/ops/runbook.md`](../ops/runbook.md); this file is the **minimum** you
need to understand and operate the production layout.

## Layout

Production is **four Coolify resources** on the `coolify` Docker network
(since 2026-09-11, #30). Nothing runs from a compose file any more.

| Resource | Coolify type | Built from | Notes |
| --- | --- | --- | --- |
| `dam-web` | Application, build pack **Dockerfile** | `deploy/coolify/Dockerfile.web` | Serves `dam.teraren.com` on `:3000`. Health check = the Dockerfile `HEALTHCHECK` (`/api/v1/healthz`); Coolify's own probe is **off** because the run image has neither curl nor wget. This is the resource that gets **rolling updates**. |
| `dam-worker` | Application, build pack **Dockerfile** | `deploy/coolify/Dockerfile.worker` | graphile-worker. No domain, no health check; a deploy briefly overlaps two workers, which graphile-worker tolerates (job locks live in Postgres). |
| `dam-db` | Database → PostgreSQL | image pinned to the `timescale/timescaledb-ha:pg16-all` **digest** that was running before the split | Data volume mounted at `/home/postgres/pgdata/data` (the image's `PGDATA`), not Coolify's default `/var/lib/postgresql`. Reachable as `postgres://dam:…@<db-uuid>:5432/dam`. |
| `dam-minio` | Service (raw compose) | `minio/minio:RELEASE.2025-04-22T22-12-26Z` | Bucket `dam-raw`. Reachable as `http://minio-<service-uuid>:9000` ("Connect to predefined network" is on). |

| File | Purpose |
| --- | --- |
| `Dockerfile.web` | Builds and runs the Next.js app on `:3000`, then `bootstrap.sh` at start. |
| `Dockerfile.worker` | Builds and runs the graphile-worker process. |
| `bootstrap.sh` | Runs pending migrations and the master upsert on every web start. |
| `docker-compose.legacy.yaml` | The former single-resource stack. Reference and rollback only. |

Local development does not use any of this: see `/docker-compose.dev.yml`
and `just` at the repo root.

## Environment variables

Set in the Coolify UI on **both** `dam-web` and `dam-worker` (they share the
same set; unused keys are harmless):

- `DATABASE_URL` — `postgres://dam:<POSTGRES_PASSWORD>@<dam-db uuid>:5432/dam`
- `S3_ENDPOINT` — `http://minio-<dam-minio uuid>:9000`; `S3_REGION` — `us-east-1`; `S3_BUCKET` — `dam-raw`
- `S3_ACCESS_KEY`, `S3_SECRET_KEY` — also set on the `dam-minio` service as its root credentials
- `POSTGRES_PASSWORD` — the password inside `DATABASE_URL`
- `API_KEY_PEPPER` — generate with `openssl rand -hex 32`
- `ADMIN_SECRET` — bearer for `POST /api/v1/admin/jobs`
- `KASENBOSAI_USER_AGENT`, `DAMNET_LIST_URL` — see the adapter READMEs; must include a real contact address per upstream's TOS
- `NEXT_PUBLIC_SITE_URL` (build time), `NEXT_PUBLIC_GTM_ID`, `NEXT_PUBLIC_ADSENSE_CLIENT`
- `AUTH_SECRET`, `AUTH_URL`, `AUTH_TRUST_HOST`, `AUTH_GOOGLE_ID`, `AUTH_GOOGLE_SECRET`
- `NODE_ENV=production`, `NEXT_TELEMETRY_DISABLED=1`
- `BOOTSTRAP_UPSERT_MASTER=1`. Do **not** set `BOOTSTRAP_KICK` permanently: under
  rolling updates it would drop stuck jobs and re-enqueue every crawler on every
  deploy. Set it for one deploy, then remove it.

## Deploys and rolling updates

A push to `main` triggers a build of `dam-web` and `dam-worker` (each rebuilds
its own image; the data resources are untouched). For `dam-web`, Coolify
starts the new container, waits until the Dockerfile `HEALTHCHECK` reports
healthy (`bootstrap.sh` has to finish first: migrations plus the ~16 MB master
upsert), switches Traefik, then stops the old container. Keep these true or
rolling updates silently degrade to stop-then-start:

- `dam-web` has a domain, no host port mapping, default container name, and
  Coolify's health check setting **disabled** (Dockerfile HEALTHCHECK in use).
- Migrations are additive. Old and new web containers run side by side for a
  minute; a destructive migration would break the old one.
- Coolify's health polling window is `interval × retries` even when its probe
  is off; `dam-web` uses 5 s × 40 so a 3 min bootstrap still fits.

`dam-db` and `dam-minio` only restart when *you* restart them.

## First-time bring-up (fresh server)

1. Create `dam-db` (PostgreSQL, image `timescale/timescaledb-ha:pg16-all`,
   user/db `dam`), add a persistent storage at `/home/postgres/pgdata/data`, start.
2. Create `dam-minio` from `docker-compose.legacy.yaml`'s `minio` service
   (raw compose), set `S3_ACCESS_KEY` / `S3_SECRET_KEY`, enable "Connect to
   predefined network", start.
3. Create `dam-web` and `dam-worker` (Dockerfile build pack, base directory
   `/`), set the variables above, deploy `dam-web` first: `bootstrap.sh`
   restores `/seed/master.sql.gz` into an empty database.
4. Create the bucket from the `dam-web` terminal:
   `bun run packages/storage/src/ensure-bucket.ts`
5. Issue the first API key: `bun run bin/api_key.ts issue --email you@example.com --label bootstrap`.

## Rollback

- **Code**: Coolify UI → `dam-web` → Deployments → pick a previous SHA →
  Redeploy (rolling, no downtime). Same for `dam-worker`.
- **Whole stack** (only if the split itself is the problem): the legacy compose
  resource `frd6so0qmtknwe7kogjyalkw` is stopped with auto-deploy off and still
  owns volumes `frd6so0qmtknwe7kogjyalkw_db-data` / `_minio-data` as they were
  at cutover. Point its compose location at `deploy/coolify/docker-compose.legacy.yaml`,
  stop `dam-web`/`dam-worker`, start it. Data written after the cutover stays in
  `dam-db` only.

## Logs

Coolify UI → resource → "Logs". `dam-web` logs are the Next.js server plus
`bootstrap.sh` (also served at `/bootstrap.txt`); `dam-worker` logs are the
task runner. `dam-db` and `dam-minio` have their own log tabs.

## See also

- [`deploy/ops/runbook.md`](../ops/runbook.md) — full operator handbook.
- [`deploy/backup/pgbackrest.conf`](../backup/pgbackrest.conf) — backup config.
