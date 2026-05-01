set shell := ["bash", "-cu"]

default:
    @just --list

# Bring up the local infra (db + minio)
up:
    docker compose up -d

# Ensure the local raw-snapshot bucket exists in MinIO
# Uses the compose network so this works on macOS Docker Desktop (no --network host).
ensure-bucket:
    docker run --rm --network dam_default \
        -e MC_HOST_local=http://${S3_ACCESS_KEY:-minio}:${S3_SECRET_KEY:-minio12345}@minio:9000 \
        minio/mc:RELEASE.2025-04-08T15-39-49Z \
        mb --ignore-existing local/${S3_BUCKET:-dam-raw}

down:
    docker compose down

# Run all migrations
migrate:
    bun run --filter @dam/db migrate

# Reset the database (drops volume — local only)
reset-db:
    docker compose down -v
    docker compose up -d --wait
    bun run --filter @dam/db migrate

# Lint, format, typecheck, test
check:
    bun run lint
    bun run typecheck
    bun test

# Run the web app
dev-web:
    bun run --filter @dam/web dev

# Run the worker
dev-worker:
    bun run --filter @dam/worker dev

# Master imports
import-ndi-watersheds *args:
    bun run packages/adapters/ndi/src/cli.ts watersheds {{args}}

import-ndi-dams *args:
    bun run packages/adapters/ndi/src/cli.ts dams {{args}}

import-damnet *args:
    bun run --filter @dam/adapters-damnet import {{args}}

reconcile:
    bun run --filter @dam/reconciler run
