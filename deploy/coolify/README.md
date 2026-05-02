# Coolify deployment

This directory holds the artifacts Coolify needs to build and run dam in
production. The full operator runbook (backups, scrapers, on-call) lives in
[`deploy/ops/runbook.md`](../ops/runbook.md); this file is the **minimum** you
need to bring the stack up the first time.

## Layout

| File | Purpose |
| --- | --- |
| `Dockerfile.web` | Builds and runs the Next.js app on `:3000`. |
| `Dockerfile.worker` | Builds and runs the graphile-worker process. |
| `docker-compose.coolify.yml` | Wires `app` + `worker` + `db` + `minio` together for a single-server deploy. |

## First-time bring-up

1. **Create the Coolify resource.** Choose "Docker Compose" and point it at this
   repo's `deploy/coolify/docker-compose.coolify.yml`. Coolify clones the repo
   itself, so the `build.context: ../..` reaches the workspace root inside
   Coolify's checkout.
2. **Set environment variables** in the Coolify UI (do not commit them):
   - `POSTGRES_PASSWORD`
   - `S3_ACCESS_KEY`, `S3_SECRET_KEY` (used both as MinIO root creds and as the
     app's S3 client creds)
   - `API_KEY_PEPPER` — generate with `openssl rand -hex 32`
   - `KASENBOSAI_USER_AGENT` — see `packages/adapters/kasenbosai/README.md`;
     must include a real contact address per upstream's TOS
   - `NEXT_PUBLIC_SITE_URL` — e.g. `https://dam.example.com`
3. **Deploy.** Coolify builds both Dockerfiles in parallel and starts the
   services. The `app` healthcheck hits `/api/health`, so first-time deployment
   blocks until the migrations are applied and the app responds.
4. **Apply migrations.** From the Coolify terminal for the `app` container:
   ```sh
   bun run --filter @dam/db migrate
   ```
   (Equivalent to `just migrate` locally.)
5. **Create the raw-snapshot bucket** in MinIO. From the Coolify terminal for
   the `app` container:
   ```sh
   bun run packages/storage/src/ensure-bucket.ts
   ```
   Or open the MinIO console (port 9001) and create `dam-raw` manually.
6. **Import master data.** See the runbook section "Master data".
7. **Issue the first API key**:
   ```sh
   bun run bin/api_key.ts issue --email you@example.com --label bootstrap
   ```
   Save the returned token — it is shown only once.

## Rolling deploys

Coolify rebuilds and recreates the containers on each git push. The `worker`
service has no HTTP surface and will be torn down and replaced; in-flight
graphile-worker jobs are picked up by the next process because job state lives
in Postgres.

## Logs

- **App / worker stdout**: Coolify UI → resource → "Logs" tab. Streamed in real
  time; Coolify retains the last few hundred MB.
- **Postgres**: same UI, but for the `db` service.
- **MinIO**: same UI for the `minio` service. Audit log goes to stdout when
  `MINIO_AUDIT_WEBHOOK_*` is set (not configured by default).

## Rollback

`Coolify UI → Deployments → pick a previous SHA → Redeploy`. The image is
rebuilt from that SHA. Database migrations are forward-only; if a deploy
included a destructive migration, follow the PITR procedure in the runbook
instead.

## See also

- [`deploy/ops/runbook.md`](../ops/runbook.md) — full operator handbook.
- [`deploy/backup/pgbackrest.conf`](../backup/pgbackrest.conf) — backup config.
