# Operator runbook

This is the on-call handbook for the production dam deployment. The
deployment artifacts live in [`deploy/coolify/`](../coolify/) and the backup
config in [`deploy/backup/`](../backup/). Read this before paging anyone.

**Owner / on-call contact:** matsubokkuri@gmail.com

---

## 0. Topology (since 2026-09-11, #30)

Production is four Coolify resources, not one compose stack: `dam-web`
(Next.js, rolling updates), `dam-worker` (graphile-worker), `dam-db`
(TimescaleDB, image pinned by digest) and `dam-minio` (raw-snapshot bucket).
Layout, env vars, rolling-update rules and rollback are in
`deploy/coolify/README.md`. Where this runbook says "the `app` container" read
`dam-web`; "the `worker` service" read `dam-worker`; "the `db` container" read
`dam-db`; "the `minio` service" read `dam-minio`. Each is its own Coolify
resource with its own terminal, logs and Stop/Start buttons. The former compose
file is kept at `deploy/coolify/docker-compose.legacy.yaml` for reference.

## 1. First-time bring-up

Assumes a fresh Coolify resource has been created from
the four resources described in `deploy/coolify/README.md` exist and all required env vars are set
(see [`deploy/coolify/README.md`](../coolify/README.md)).

```sh
# All commands below run inside the `app` container's Coolify terminal.
just up                                  # only relevant when you ssh into the host
bun run --filter @dam/db migrate         # equivalent: just migrate
bun run packages/storage/src/ensure-bucket.ts   # equivalent: just ensure-bucket

# Master data — order matters (watersheds before dams):
bun run packages/adapters/ndi/src/cli.ts watersheds
bun run packages/adapters/ndi/src/cli.ts dams
bun run --filter @dam/adapters-damnet import

# Reconcile master tables (dedupe, slug repair, etc.):
bun run --filter @dam/reconciler run

# Issue the bootstrap API key — token is shown ONCE:
bun run bin/api_key.ts issue --email you@example.com --label bootstrap
```

The worker starts automatically when Coolify deploys the stack; nothing to do.

---

## 2. Stop / start the worker

The worker has no HTTP surface; the only ways to control it are:

- **Stop:** Coolify UI → `dam-worker` → "Stop". This is safe; in
  flight jobs are picked up on the next start because graphile-worker stores
  its queue in Postgres.
- **Start:** same UI → "Start".
- **Restart after a config change** (env var, image rebuild): bump the deploy
  in Coolify, or `docker compose up -d --force-recreate worker` if you ssh into
  the host directly.

To pause scheduled scrapes without stopping the worker, use graphile-worker's
admin SQL on the `db` service:

```sql
update graphile_worker.jobs set run_at = run_at + interval '1 day' where task_identifier like 'scrape_%';
```

---

## 3. API key management

```sh
# Issue (token printed once — copy it now):
bun run bin/api_key.ts issue --email user@example.com --label "client name"

# List active keys:
bun run bin/api_key.ts list

# Revoke by id (id from list):
bun run bin/api_key.ts revoke --id <key_id>
```

Keys are hashed with `API_KEY_PEPPER`; rotating the pepper invalidates every
key. If you suspect a leaked pepper:

1. Issue replacement keys to all clients first.
2. Rotate `API_KEY_PEPPER` in Coolify.
3. Redeploy.
4. Revoke the old keys.

---

## 4. Backups (pgBackRest)

Configuration lives at [`deploy/backup/pgbackrest.conf`](../backup/pgbackrest.conf).
The placeholders in that file are substituted from Coolify env vars at sidecar
start. The schedule (full weekly + hourly diff) is enforced by a cron job
inside the pgbackrest sidecar.

### 4.1 Manual full backup

```sh
# Run inside the pgbackrest sidecar:
pgbackrest backup --stanza=main --type=full
```

### 4.2 Verify a backup

```sh
pgbackrest info --stanza=main
pgbackrest verify --stanza=main
```

### 4.3 Point-in-time restore (PITR)

This is destructive; it stops Postgres and replaces the data directory.

```sh
# 1. Stop the app and worker so they don't reconnect mid-restore.
#    (Coolify UI → Stop on `app` and `worker`.)

# 2. Stop Postgres on the db container.
docker compose stop db

# 3. From the pgbackrest sidecar, restore to the desired timestamp:
pgbackrest restore --stanza=main \
  --type=time \
  --target="2026-05-02 03:14:00+09" \
  --delta

# 4. Start Postgres. It will replay WAL up to the target timestamp.
docker compose start db

# 5. Once `pg_isready` succeeds, start app and worker again.
```

### 4.4 Disaster recovery (full host loss)

1. Bring up a new Coolify host and recreate the stack (same compose file).
2. Set the same `PGBACKREST_*` env vars so the new sidecar finds the existing
   S3 repository.
3. Stop the freshly-initialized `db` container.
4. Run `pgbackrest restore --stanza=main --delta` to fetch the latest backup.
5. Start `db`, then `app`, then `worker`.

Restore objective: RTO 1h, RPO 1h (matches the diff-backup cadence).

---

## 5. Image bumps

### 5.1 MinIO

1. Find the latest tag at https://hub.docker.com/r/minio/minio/tags (use a
   pinned `RELEASE.YYYY-MM-DDTHH-MM-SSZ` tag — never `latest`).
2. Coolify UI → `dam-minio` → edit the compose (`minio.image`) and restart.
3. Open a PR. After merge, Coolify auto-deploys.
4. The first start after a major bump may run an internal data migration; tail
   the `minio` logs in Coolify until you see `API: ... :9000`.

### 5.2 Postgres / TimescaleDB

Major-version bumps require `pg_dump`/`pg_restore`. Do NOT bump the major in
the compose file without first taking a manual full pgBackRest backup and
testing the restore path on a staging host.

### 5.3 Bun

The image base `oven/bun:1.4` is pinned to a major+minor and must match the
bun that maintains `bun.lock` (`bun --version` locally). A mismatch fails the
build at `bun install --frozen-lockfile` — that is what broke every deploy
between 2026-08-16 and 2026-09-08 while the image was still `1.3`. When
bumping bun locally, bump both Dockerfiles in the same commit and run
`bun test` against the new image first.

---

## 6. Logs

| What | Where |
| --- | --- |
| App / worker stdout | Coolify UI → resource → service → "Logs" tab |
| Postgres logs | Coolify UI → `db` service → "Logs" |
| MinIO access log | Coolify UI → `minio` service → "Logs" |
| pgBackRest | Coolify UI → pgbackrest sidecar → "Logs"; archived under `/var/log/pgbackrest` inside the sidecar |
| Raw HTTP snapshots from scrapers | MinIO bucket `dam-raw` (prefix per source) |

Coolify retains roughly the last few hundred MB of stdout per service; for
longer retention forward to a syslog target via Coolify's log drains.

---

## 7. "Scraper broke because upstream changed" playbook

This is the single most common page. The symptom is usually one source's
`scrape_*` task failing repeatedly in graphile-worker.

### 7.1 Identify which source

```sh
# Inside the db container:
psql -U dam -d dam -c "
  select task_identifier, last_error
    from graphile_worker.jobs
   where attempts >= max_attempts
   order by updated_at desc
   limit 20;
"
```

The task identifier (`scrape_kasenbosai`, `scrape_damnet`, `scrape_ndi`,
`scrape_suimon`) tells you which adapter to inspect.

### 7.2 Capture the new upstream response

The worker stores raw HTTP responses in MinIO (`dam-raw` bucket). Pull the
latest failed snapshot:

```sh
mc cp local/dam-raw/<source>/<latest-key> /tmp/upstream.html
```

If the failure is a parser error, that file is your new fixture.

### 7.3 Add a fixture and a test

Each adapter under `packages/adapters/<name>/` has a `tests/` (or
`__tests__/`) directory with HTML/CSV fixtures. Add the new capture there and
write a unit test that asserts the parser returns the expected structured
output. **Do not skip this step** — the fixture is the regression guard.

```sh
# Examples (paths may differ slightly):
ls packages/adapters/kasenbosai/tests/fixtures/
ls packages/adapters/damnet/tests/fixtures/
```

### 7.4 Fix the parser

Edit the adapter's parser (typically `packages/adapters/<name>/src/parse.ts`
or `parser.ts`). Run:

```sh
bun test packages/adapters/<name>
```

Once green, run the full suite:

```sh
bun test
```

### 7.5 Validate against the live upstream (optional but recommended)

Each adapter ships a CLI that can be run as a one-shot fetch+parse:

```sh
bun run packages/adapters/<name>/src/cli.ts --once
```

If that prints sensible records, ship it.

### 7.6 Ship the fix

1. Commit (`fix(<adapter>): handle <change> upstream`) and push.
2. Coolify rebuilds and redeploys.
3. Re-queue the failed jobs:

```sql
update graphile_worker.jobs
   set attempts = 0, run_at = now()
 where task_identifier = 'scrape_<name>'
   and attempts >= max_attempts;
```

---

## 8. Common Postgres health checks

```sh
# Connection count:
psql -U dam -d dam -c "select count(*) from pg_stat_activity;"

# Slow queries:
psql -U dam -d dam -c "
  select pid, now() - query_start as duration, state, query
    from pg_stat_activity
   where state = 'active' and now() - query_start > interval '30 seconds'
   order by duration desc;
"

# Disk usage of the largest tables:
psql -U dam -d dam -c "
  select relname, pg_size_pretty(pg_total_relation_size(relid)) as size
    from pg_catalog.pg_statio_user_tables
   order by pg_total_relation_size(relid) desc
   limit 20;
"
```

Hypertable-specific checks (TimescaleDB) for the observation tables:

```sh
psql -U dam -d dam -c "select * from timescaledb_information.hypertables;"
psql -U dam -d dam -c "select * from timescaledb_information.chunks order by range_start desc limit 10;"
```

---

## 9. Escalation

If the runbook doesn't get you out of the hole within ~30 min, page
**matsubokkuri@gmail.com** with:

- Coolify resource name + the failing service.
- The first stack trace or error from logs.
- Anything you've already tried.
