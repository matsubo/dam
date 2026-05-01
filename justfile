set shell := ["bash", "-cu"]

default:
    @just --list

# Bring up the local infra (db + minio)
up:
    docker compose up -d

down:
    docker compose down

# Run all migrations
migrate:
    bun run --filter @dam/db migrate

# Reset the database (drops volume — local only)
reset-db:
    docker compose down -v
    docker compose up -d
    sleep 2
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
    bun run --filter @dam/adapters-ndi import:watersheds {{args}}

import-ndi-dams *args:
    bun run --filter @dam/adapters-ndi import:dams {{args}}

import-damnet *args:
    bun run --filter @dam/adapters-damnet import {{args}}

reconcile:
    bun run --filter @dam/reconciler run
