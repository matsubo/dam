# Operator runbook

This is the on-call handbook for the production dam deployment. The app's
deployment artifacts live in [`deploy/`](..) (`Dockerfile.web`,
`Dockerfile.worker`, `bootstrap.sh`, `k8s.yaml`, `purge-cdn.yaml`); the
namespace, the database, its backups and the Secrets live in
matsubo/network-setting `k8s/dam.yaml`. Read this before paging anyone.

**Owner / on-call contact:** <redacted>

---

## 0. Topology (k3s since 2026-10-07)

Production runs on the home k3s cluster, namespace `dam`:

| Object | What | Defined in |
| --- | --- | --- |
| Deployment `dam-web` | Next.js, two replicas on different nodes, rolling updates, PodDisruptionBudget | `deploy/k8s.yaml` |
| Deployment `dam-worker` | graphile-worker, one replica | `deploy/k8s.yaml` |
| Service / Ingress `dam-web` | `dam.teraren.com` through Traefik; public traffic arrives over the in-cluster Cloudflare tunnel | `deploy/k8s.yaml` |
| Job `dam-purge-cdn` | Cloudflare cache purge after each rollout | `deploy/purge-cdn.yaml` |
| CNPG Cluster `dam-pg18` | PostgreSQL 18 + TimescaleDB + PostGIS, primary + synchronous standby; the app connects through Service `dam-postgres-rw` | network-setting `k8s/dam.yaml` |
| Secret `dam-env` | runtime env shared by web and worker (`DATABASE_URL`, `AUTH_*`, `CF_*`, …) | created by hand; recipe in network-setting `k8s/dam.yaml` |

`kubectl` below means cluster-admin: on t1, `sudo k3s kubectl` (the
`kubectl cnpg` plugin is in `~/bin` there). CI's deployer ServiceAccount
manages only the objects in `deploy/` and cannot read Secrets.

Database shell (superuser on the current primary):
`kubectl cnpg psql dam-pg18 -n dam -- -d dam`.

### 0.1 Deploy

`.github/workflows/deploy.yml` runs on every push to `main` (or
`gh workflow run deploy.yml`): it builds `ghcr.io/matsubo/dam-web` and
`ghcr.io/matsubo/dam-worker` tagged with the commit SHA, joins the tailnet,
applies `deploy/k8s.yaml` with those images, waits for both rollouts and runs
the CDN purge Job. A new web pod runs `bootstrap.sh` (migrations + master
upsert) before it turns Ready, and old and new pods serve side by side for a
moment, so migrations must stay additive.

The roll-out job only runs while the repository variable `DEPLOY_K3S` is
`true`. Set it to false before moving, restoring or reloading the database so
a push cannot roll web/worker mid-operation:

```sh
gh variable set DEPLOY_K3S --body false --repo matsubo/dam
```

### 0.2 Rollback

Revert the commit on `main` and push. For an immediate stop before that,
`kubectl -n dam rollout undo deploy/dam-web` (and `deploy/dam-worker`)
returns to the previous ReplicaSet; the next push re-applies whatever `main`
holds. Neither undoes a migration.

## 1. First-time bring-up

1. Cluster side: the prerequisites, the `dam-pg18` Cluster and the Secrets
   `dam-pg-app`, `dam-env`, `ghcr-pull` as described in the header of
   network-setting `k8s/dam.yaml`. Restore the database from a backup (§4)
   rather than starting empty.
2. Set `DEPLOY_K3S` to `true` and run the workflow
   (`gh workflow run deploy.yml`). On an empty database `bootstrap.sh`
   restores the bundled `/seed/master.sql.gz` (dams, watersheds, rivers,
   source priorities).
3. Issue the first API key (§3).

The worker starts with the rollout; nothing else to do.

---

## 2. Stop / start the worker

The worker has no HTTP surface; the only ways to control it are:

- **Stop:** `kubectl -n dam scale deploy/dam-worker --replicas=0`. This is
  safe; in flight jobs are picked up on the next start because
  graphile-worker stores its queue in Postgres.
- **Start:** `kubectl -n dam scale deploy/dam-worker --replicas=1`.
- **Restart after a config change** (Secret `dam-env`):
  `kubectl -n dam rollout restart deploy/dam-worker`.

A deploy re-applies `replicas: 1`, so a stopped worker comes back on the next
push unless `DEPLOY_K3S` is false.

To pause scheduled scrapes without stopping the worker, use graphile-worker's
admin SQL in the database shell:

```sql
update graphile_worker.jobs set run_at = run_at + interval '1 day' where task_identifier like 'scrape_%';
```

---

## 3. API key management

`bin/api_key.ts` is not in the images. Run it from a repo checkout against a
port-forward of the database Service:

```sh
# Terminal 1 (cluster-admin; listens on that host's 127.0.0.1, so from another
# machine add `ssh -L 15432:127.0.0.1:15432 t1`):
kubectl -n dam port-forward svc/dam-postgres-rw 15432:5432

# Terminal 2, repo root. The dam role's password is in network-setting
# credentials.yaml (same value as in Secret dam-env's DATABASE_URL).
export DATABASE_URL=postgres://dam:<password>@127.0.0.1:15432/dam

# Issue (token printed once — copy it now):
bun run bin/api_key.ts issue --email user@example.com --label "client name"

# List active keys:
bun run bin/api_key.ts list

# Revoke by id (id from list):
bun run bin/api_key.ts revoke --id <key_id>
```

Keys are stored as SHA-256 hashes (`packages/db/src/repo/api_keys.ts`); the
plaintext exists only in the issue output.

---

## 4. Backups (CloudNativePG volume snapshots)

Backups are cluster-side; the full description, including the tested restore
procedure and its pitfalls, is under "Backups" and "Restore" in
network-setting `k8s/dam.yaml`. In short:

- ScheduledBackup `dam-pg18-daily` takes an online base backup from the
  standby every day at 03:45 JST as a Longhorn VolumeSnapshot; CronJob
  `dam-pg-backup-retention` keeps the newest 14.
- There is no WAL archive, so no point-in-time recovery. Losing one instance
  loses no committed write (synchronous standby, automatic failover); losing
  both falls back to the last daily backup (RPO up to one day).

### 4.1 On-demand backup (before risky work)

```sh
kubectl apply -f - <<'EOF'
apiVersion: postgresql.cnpg.io/v1
kind: Backup
metadata: { name: dam-pg18-manual-YYYYMMDD, namespace: dam }
spec: { cluster: { name: dam-pg18 }, method: volumeSnapshot }
EOF
```

### 4.2 List backups

```sh
kubectl -n dam get backups.postgresql.cnpg.io
```

(`kubectl get backup` is Longhorn's CRD, not CNPG's.)

### 4.3 Restore

Set `DEPLOY_K3S` to false and stop the worker (§2), bootstrap a new Cluster
from the chosen VolumeSnapshot, then point Service `dam-postgres-rw` at it
(network-setting `k8s/dam.yaml`, "Restore"). Start the worker and set
`DEPLOY_K3S` back to true afterwards. Rows ingested after the backup are
lost; re-running the ingest tasks refills what upstreams still publish
(observation upserts are idempotent).

---

## 5. Image bumps

### 5.1 Postgres / TimescaleDB

The database runs `ghcr.io/matsubo/dam-postgres`, built from
`deploy/postgres/Dockerfile` by `.github/workflows/postgres-image.yml`. An
extension or PostgreSQL minor bump is a new image plus `ALTER EXTENSION …
UPDATE`; a PostgreSQL major is a new Cluster. Both procedures (with the
backup to take first) are in network-setting `k8s/dam.yaml`, "Extension
upgrade" and "Upgrade 16 -> 18".

### 5.2 Bun

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
| Web / worker stdout | `kubectl -n dam logs deploy/dam-web` (one pod; `-l app=dam-web --prefix` for both), `kubectl -n dam logs deploy/dam-worker`; add `--previous` for a crashed container |
| `bootstrap.sh` | head of the web pod's log |
| Postgres | `kubectl -n dam logs <instance pod> -c postgres`; state: `kubectl cnpg status dam-pg18 -n dam` |
| Deploys | the GitHub Actions runs of `deploy.yml` |
| Database metrics | Grafana dashboard "CloudNativePG" |

There is no log aggregation: a pod's logs go away with the pod, and the
kubelet rotates them while it runs.

---

## 7. "Scraper broke because upstream changed" playbook

This is the single most common page. The symptom is usually one source's
`scrape_*` task failing repeatedly in graphile-worker.

### 7.1 Identify which source

```sh
kubectl cnpg psql dam-pg18 -n dam -- -d dam -c "
  select task_identifier, last_error
    from graphile_worker.jobs
   where attempts >= max_attempts
   order by updated_at desc
   limit 20;
"
```

The task identifier (`scrape_kasenbosai`, `scrape_damnet`, `scrape_ndi`,
`scrape_suimon`) tells you which adapter to inspect.

### 7.2 Add a fixture and a test

Each adapter under `packages/adapters/<name>/` has a `tests/` (or
`__tests__/`) directory with HTML/CSV fixtures. Fetch the current upstream
response and add it there, then
write a unit test that asserts the parser returns the expected structured
output. **Do not skip this step** — the fixture is the regression guard.

```sh
# Examples (paths may differ slightly):
ls packages/adapters/damnet/tests/fixtures/
```

### 7.3 Fix the parser

Edit the adapter's parser (typically `packages/adapters/<name>/src/parse.ts`
or `parser.ts`). Run:

```sh
bun test packages/adapters/<name>
```

Once green, run the full suite:

```sh
bun test
```

### 7.4 Validate against the live upstream (optional but recommended)

Each adapter ships a CLI that can be run as a one-shot fetch+parse:

```sh
bun run packages/adapters/<name>/src/cli.ts --once
```

If that prints sensible records, ship it.

### 7.5 Ship the fix

1. Commit (`fix(<adapter>): handle <change> upstream`) and push.
2. The deploy workflow builds the images and rolls them out (§0.1).
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
damsql() { kubectl cnpg psql dam-pg18 -n dam -- -d dam "$@"; }

# Connection count:
damsql -c "select count(*) from pg_stat_activity;"

# Slow queries:
damsql -c "
  select pid, now() - query_start as duration, state, query
    from pg_stat_activity
   where state = 'active' and now() - query_start > interval '30 seconds'
   order by duration desc;
"

# Disk usage of the largest tables:
damsql -c "
  select relname, pg_size_pretty(pg_total_relation_size(relid)) as size
    from pg_catalog.pg_statio_user_tables
   order by pg_total_relation_size(relid) desc
   limit 20;
"
```

Hypertable-specific checks (TimescaleDB) for the observation tables:

```sh
damsql -c "select * from timescaledb_information.hypertables;"
damsql -c "select * from timescaledb_information.chunks order by range_start desc limit 10;"
```

---

## 9. One-off data fixes (`deploy/ops/oneoff/`)

`observations` is a compressed hypertable. An `UPDATE` / `DELETE` / re-dating
`INSERT` that reaches compressed chunks has to decompress them, and
TimescaleDB caps that per transaction
(`timescaledb.max_tuples_decompressed_per_dml_transaction`). Rules:

- DML on compressed `observations` rows **never goes in a migration**: the web
  boot runs migrations on every deploy, and lifting the cap there stalls or
  bloats the migrate run (see the header of migration 0045). Write a dated
  file `deploy/ops/oneoff/YYYY-MM-DD_<what>.sql` whose header states when to
  run it, the command and any follow-up.
- The script is its own transaction: it opens with `BEGIN;` and
  `SET LOCAL timescaledb.max_tuples_decompressed_per_dml_transaction = 0;`
  and ends with `COMMIT;`, so the cap is lifted for that transaction only
  (`SET LOCAL` never leaks into other sessions). Follow-ups that cannot run
  in a transaction (`CALL refresh_continuous_aggregate`) stay outside it, as
  post-steps in the header.
- Run it once, by hand, and make it idempotent: a second run finds nothing
  to change.
- Rows a script inserts into a compressed chunk are compressed later as new
  batches. On TimescaleDB before 2.27 they could overlap the chunk's existing
  batches in observed_at, and the planner then reads the chunk out of order:
  obs_daily stored split (dam_id, day) groups (#115). Production runs 2.30
  since 2026-10-12. If a refresh ever fails on `obs_daily_dam_id_day_key`
  (migration 0222), find such chunks with the first `DO` block of 0222 and
  run `SELECT compress_chunk('<chunk>', recompress => true);` per chunk
  (~0.5 s each; it locks out readers of that chunk for that time), then
  `CALL refresh_continuous_aggregate('obs_daily', <chunk start>, <chunk end>, force => true);`.

Run from a repo checkout, piping the file into psql on the current primary as
role `dam`:

```sh
PRIMARY=$(kubectl -n dam get cluster.postgresql.cnpg.io dam-pg18 -o jsonpath='{.status.currentPrimary}')
kubectl -n dam exec -i "$PRIMARY" -c postgres -- env 'PGOPTIONS=-c role=dam' \
  psql -X -d dam -v ON_ERROR_STOP=1 < deploy/ops/oneoff/<file>
```

The table's `psql -U dam -d dam -v ON_ERROR_STOP=1 -f <file>` stands for that
command; its follow-up SQL runs in the database shell (§0).

| Script | Run when | Command, then follow-up |
| --- | --- | --- |
| `2026-09-28_jwa_toyokawa_units.sql` | Once on prod, after `fix(jwa-toyokawa)` (reads 有効貯水量 as 10³m³, stores no outflow) is deployed. Subtracts the 103 m³ the old parser read from the unit's "10³" on every 宇連/大島 volume, re-derives their rates, nulls the 放流量（利水） stored as outflow, deletes the 53 communication-cut rows made of unit digits (dry run: DELETE 53, UPDATE 5,583). Idempotent; the final `SELECT` should report 0, 0, 0. | `psql -U dam -d dam -v ON_ERROR_STOP=1 -f 2026-09-28_jwa_toyokawa_units.sql`, then `SELECT graphile_worker.add_job('aggregates:refresh');` |
| `2026-09-28_nakazato_stub.sql` | Once on prod, after `feat/n4-mie-nara-wakayama` (jwa-chubu per-block parser, migration 0083) is deployed. Moves 中里's JWA rows off the invented 長野 stub to NDI 940, drops the stub, clears the old parser's volumes and rates. Aborts if 0083 is not applied. | First check `SELECT applied_at FROM _migrations WHERE name = '0083_drop_fabricated_nakazato_nagano.sql';` then `psql -U dam -d dam -v ON_ERROR_STOP=1 -f 2026-09-28_nakazato_stub.sql`, then `SELECT graphile_worker.add_job('ingest:jwa-chubu');` and `SELECT graphile_worker.add_job('aggregates:refresh');` |
| `2026-09-28_dedupe_observations.sql` | Once on prod, after the `observations:rebind` fix (INSERT … ON CONFLICT instead of DELETE … USING + UPDATE) is deployed and BEFORE any further `observations:rebind` job. Drops the second copy of the 33,219 keys the round-2 rebind stored twice in compressed chunks (0 differing groups in the 2026-09-28 dry run); a group whose copies differ is skipped and listed. Needs a superuser. Holds EXCLUSIVE locks on the 35 chunks involved for the transaction (reads continue). Idempotent; the final `SELECT` should report 0. Run it again after the round-3 rebind as a check. | `psql -U dam -d dam -v ON_ERROR_STOP=1 -f 2026-09-28_dedupe_observations.sql`, then, outside a transaction: `CALL refresh_continuous_aggregate('obs_daily', '2023-12-31', '2026-08-28', force => true);` and `CALL refresh_continuous_aggregate('obs_monthly', '2023-12-01', '2026-09-01', force => true);` |
| `2026-09-28_redate_chiba_suisei.sql` | Once on prod, after the ingest_chiba heading fix (dates chiba-suisei by the table heading, not the chart alt) is deployed. Moves six weeks of rows to their survey date; guarded per date, so re-runs move nothing. The final `SELECT` lists dams per survey date. | `psql -U dam -d dam -v ON_ERROR_STOP=1 -f 2026-09-28_redate_chiba_suisei.sql` |
| `2026-09-28_tottori_bousai_placeholders.sql` | Once on prod, after ingest_tottori_bousai's skip of items more than 20 m below their own 最低水位 is deployed. Deletes the stored placeholder / copied rows (423 in the 2026-09-28 dry run). Idempotent. | `psql -U dam -d dam -v ON_ERROR_STOP=1 -f 2026-09-28_tottori_bousai_placeholders.sql`, then, outside a transaction: `CALL refresh_continuous_aggregate('obs_daily', '2026-06-01', now() - interval '59 days');` and `CALL refresh_continuous_aggregate('obs_monthly', '2026-06-01', '2026-08-01');` |
| `2026-09-28_yamaguchi_bousai_outage_zeros.sql` | Once on prod, after the ingest_yamaguchi_bousai fix that skips 貯水位 0.00 outage rows is deployed. Deletes the 283 stored zero rows on 10 dams; idempotent. The final `SELECT` should report 0. | `psql -U dam -d dam -v ON_ERROR_STOP=1 -f 2026-09-28_yamaguchi_bousai_outage_zeros.sql` |
| `2026-09-28_prune_ingest_retries.sql` | Once on prod, after the worker whose crontab gives every `ingest:*` line `?jobKey=<task>` is deployed; before it, the pile regrows hourly. Removes unlocked, keyless `ingest:*` jobs that have failed at least once through `graphile_worker.complete_jobs` (dry run: 86 `ingest:kyoto-bousai` retries, attempts 8–23 of 25). Touches no `observations`; idempotent. The final `SELECT` should report 0. | `psql -U dam -d dam -v ON_ERROR_STOP=1 -f 2026-09-28_prune_ingest_retries.sql` |
| `2026-09-28_kanagawa_dam_daily_restamp.sql` | Once on prod, after `fix(kanagawa-dam)` (reads summary.php as a 30-day daily window) is deployed. Collapses the old adapter's misdated "hourly" rows to one row per dam and day, stamped at 24:00 JST (dry run: DELETE 16,415, INSERT 690 = 5 dams × 138 days). Safe whether or not the new worker has run first; idempotent. The final `SELECT` should report 0 rows off 15:00Z. | `psql -U dam -d dam -v ON_ERROR_STOP=1 -f 2026-09-28_kanagawa_dam_daily_restamp.sql`, then `SELECT graphile_worker.add_job('ingest:kanagawa-dam');` and `SELECT graphile_worker.add_job('aggregates:refresh');` |
| `2026-09-28_aitoyo_restamp_reading_hour.sql` | Once on prod, after `fix(aitoyo)` (stamps 当日 24時 / 9時) is deployed. Moves the old rows from the start of the 現在 day to the reading hour: +24 h for 牧尾/阿木川/味噌川/岩屋/宇連, +9 h for 矢作/羽布 (dry run: 511 rows, 0 conflicts). Safe whether or not the new worker has run first; idempotent. The final `SELECT` should report `at_15z` 0 for 矢作/羽布. | `psql -U dam -d dam -v ON_ERROR_STOP=1 -f 2026-09-28_aitoyo_restamp_reading_hour.sql`, then `SELECT graphile_worker.add_job('aggregates:refresh');` |
| `2026-09-28_jwa_chikugo_rt_oozeki_volume.sql` | Once on prod, after `fix(jwa-chikugo-rt)` (stores no 有効貯水量 for 筑後大堰, whose page prints its 930 千m³ capacity in every row) is deployed. Nulls the constant 930,000 m³ volume and the 1.0000 rate the trigger derived from it on 筑後大堰 (NDI 2475); dry run: UPDATE 28, one more per hour until the deploy. Idempotent; the final `SELECT` should report 0. | `psql -U dam -d dam -v ON_ERROR_STOP=1 -f 2026-09-28_jwa_chikugo_rt_oozeki_volume.sql`, then `SELECT graphile_worker.add_job('aggregates:refresh');` (run back to back with the next script, one refresh covers both) |
| `2026-09-28_jwa_chikugo_closed_day_repeats.sql` | Once on prod, after `fix(jwa-chikugo)` (dates rows by the page's 水源情報【…】 heading, not the run date) is deployed. Deletes the rows stamped on a Saturday, Sunday or holiday that exactly repeat the same dam's previous day (dry run: DELETE 204 of 955 — Sundays 138, Saturdays 38, holidays 28). Rows that are one day late but not repeats stay. Idempotent; the final `SELECT` should report 0. | `psql -U dam -d dam -v ON_ERROR_STOP=1 -f 2026-09-28_jwa_chikugo_closed_day_repeats.sql`, then `SELECT graphile_worker.add_job('aggregates:refresh');` |
| `2026-09-28_jwa_fukudou_rounded_rate.sql` | Once on prod, after `fix(jwa-fukudou)` (accepts the page's whole-percent 貯水率 when tying 総貯水量 to the master) is deployed. Fills in the 3,653,400 m³ the old check dropped from 山口調整池's 2026-09-28 0時 row (dry run: UPDATE 1; 0 if the fixed worker already re-read that edition). Idempotent; the final `SELECT` should report 3653400.00. | `psql -U dam -d dam -v ON_ERROR_STOP=1 -f 2026-09-28_jwa_fukudou_rounded_rate.sql` |
| `2026-09-28_jwa_kiso_rt_nakazato_flows.sql` | Once on prod, after `fix(jwa-kiso-rt)` (ends each dam's section at its own table) is deployed. Nulls the inflow / outflow stored for 中里貯水池 (NDI 940), which were 長良川河口堰's 流入量 and 木曽川大堰's 放流量 (dry run: UPDATE 2,613, every jwa-kiso-rt 中里 row). Idempotent; the final `SELECT` should report 0. | `psql -U dam -d dam -v ON_ERROR_STOP=1 -f 2026-09-28_jwa_kiso_rt_nakazato_flows.sql` |
| `2026-09-28_jwa_yoshino_flows.sql` | Once on prod, right after `fix(jwa-yoshino)` (reads each value from its `<td>`, not the "3" of the `m<sup>3</sup>/s` label) is deployed. Nulls the inflow and outflow on every jwa-yoshino row where both are 3 (dry run: UPDATE 13,815 on 5 dams; grows by 5 an hour until the deploy). Levels and 早明浦's rate were unaffected. Idempotent; the final `SELECT` should report 0. | `psql -U dam -d dam -v ON_ERROR_STOP=1 -f 2026-09-28_jwa_yoshino_flows.sql` |
| `2026-09-28_tottori_bousai_sugisawa_rate.sql` | Once on prod, after the ingest_tottori_bousai fix that stores no 有効容量貯水率 for 国's 菅沢 is deployed. Nulls tottori-bousai's 菅沢 rates that equal volume / 15,403 千m³ (the feed's 有効 figure, ~3 % against the manager's ~39 %) so the trigger re-derives them with bit 32 and they stop outranking kasenbosai (dry run: 2,533 of 2,533 rows, 1,848 compressed; grows one an hour until the deploy). Idempotent; the final `SELECT` should report 0, 0. | `psql -U dam -d dam -v ON_ERROR_STOP=1 -f 2026-09-28_tottori_bousai_sugisawa_rate.sql`, then `SELECT graphile_worker.add_job('aggregates:refresh');` |
| `2026-09-28_redate_kyushu_nousei_9am.sql` | Once on prod, after `fix(kyushu-nousei)` (stamps the 佐賀/熊本/大分/宮崎 blocks at 09:00 JST, not JST midnight) is deployed. Moves those blocks' kyushu-nousei rows (33 NDIs) from 15:00Z to 00:00Z of the survey date; a row the fixed adapter already wrote there wins (dry run: 31 rows, all at 2026-08-31 15:00Z). Idempotent; the final `SELECT` should report 0. | `psql -U dam -d dam -v ON_ERROR_STOP=1 -f 2026-09-28_redate_kyushu_nousei_9am.sql` |
| `2026-09-28_tokyo_waterworks_dates.sql` | Once on prod, after `fix(tokyo-waterworks)` (observations dated by the page's 「令和N年M月D日」 and 「N時現在」, 村山・山口 no longer stored, migration 0162) is deployed; aborts if 0162 is not applied. Deletes the weekend/holiday copies of the previous business day (days whose 15 rows all repeat the day before: 48 days, 720 rows in the 2026-09-28 dry run), the remaining 村山・山口 totals on 村山下（再） (NDI 706, 97), and moves 小河内's genuine rows from 00:00 to its 7時現在 (97). Idempotent; the final `SELECT` should report 0, 0, 0. | `psql -U dam -d dam -v ON_ERROR_STOP=1 -f 2026-09-28_tokyo_waterworks_dates.sql`, then `SELECT graphile_worker.add_job('aggregates:refresh');` |
| `2026-09-28_mudam_empty_rows.sql` | Once on prod, after `fix(mudam)` (parseMudamCsv skips days whose 貯水位, 流入量 and 放流量 are all blank) is deployed. Deletes the mudam rows with every quantity NULL (dry run: 21,543 rows on 153 dams, 2019-12-31 .. 2024-12-30, all in compressed chunks). Idempotent; the final `SELECT` should report 0. | `psql -U dam -d dam -v ON_ERROR_STOP=1 -f 2026-09-28_mudam_empty_rows.sql`, then, outside a transaction: `CALL refresh_continuous_aggregate('obs_daily', '2019-12-31', '2025-01-01');` and `CALL refresh_continuous_aggregate('obs_monthly', '2019-12-01', '2025-01-01');` |
| `2026-09-28_kasenbosai_empty_rows.sql` | Once on prod; 2fe6bed (kasenbosai stores no all-欠測 reading) is already deployed. Deletes the kasenbosai rows with every quantity NULL (dry run: 74,021 rows on 358 dams, 2026-07-03 .. 2026-09-27, 27,323 of them in the last 30 days; 44,704 in compressed chunks). Idempotent; the final `SELECT` should report 0. | `psql -U dam -d dam -v ON_ERROR_STOP=1 -f 2026-09-28_kasenbosai_empty_rows.sql`, then, outside a transaction: `CALL refresh_continuous_aggregate('obs_daily', '2026-07-01', now() - interval '59 days');` and `CALL refresh_continuous_aggregate('obs_monthly', '2026-07-01', '2026-09-01');` |
| `2026-09-28_kasenbosai_flagged_zero_rows.sql` | Once on prod, after `2026-09-28_kasenbosai_empty_rows.sql` (already run: 0 all-NULL kasenbosai rows left). Deletes the kasenbosai rows of the 15 stations whose every quantity is flagged 欠測, stored as 0.000 m / 0.000 m³/s until 3ff2fdb (2026-07-03) honoured the quality codes: every row zero-or-NULL, none after 2026-07-04 (dry run: 16,595 rows, 2026-05-19 .. 2026-07-03; 河内防災, 樋口, つづら, 笛吹, 庭木, 高遠, …). Idempotent; the final `SELECT` should report 0. | `psql -U dam -d dam -v ON_ERROR_STOP=1 -f 2026-09-28_kasenbosai_flagged_zero_rows.sql`, then, outside a transaction: `CALL refresh_continuous_aggregate('obs_daily', '2026-05-19', '2026-07-04');` and `CALL refresh_continuous_aggregate('obs_monthly', '2026-05-01', '2026-08-01');` |

---

## 10. Escalation

If the runbook doesn't get you out of the hole within ~30 min, page
**<redacted>** with:

- The failing Deployment or pod (`kubectl -n dam get pods`).
- The first stack trace or error from logs.
- Anything you've already tried.
