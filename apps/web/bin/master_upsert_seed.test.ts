// apps/web/bin/master_upsert_seed.test.ts
//
// Guards the two seed files this repo ships in the web image
// (`deploy/coolify/Dockerfile.web` COPYs them to /seed/).
//
// Migration 0045 retired the `synthetic` source, but bootstrap.sh applies
// migrations *before* the bundled seed, so a seed that still carries the row
// puts it back and the retirement never sticks. Production proved it:
// /api/v1/sources still advertised `synthetic` (active, priority 200, zero
// observations) on 2026-09-18, and because that row counts as an active
// observation-producing source with no recorded universe scan, it also held
// `classifyDamCoverage`'s honesty gate open — no dam anywhere could reach
// `not_published`.
//
// `master_upsert.sql.gz` was fixed at the generator (EXCLUDED_SOURCES in
// master_upsert_sql.ts). `master.sql.gz` is a pg_dump taken by hand, so it has
// no generator to fix — the restore path still carried the row until this
// commit stripped it. Hence a test on the shipped artefacts rather than on the
// code that writes one of them.
//
// Cost: both files gunzip to ~100 MB of SQL text combined, so this reads them
// once each rather than per retired id.

import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { gunzipSync } from 'node:zlib';

const ROOT = join(import.meta.dir, '..', '..', '..');

/** Sources a migration has retired; a seed must not reintroduce them. */
const RETIRED = ['synthetic'];

const SEEDS = ['deploy/seed/master.sql.gz', 'deploy/seed/master_upsert.sql.gz'];

describe('bundled master seeds', () => {
  for (const rel of SEEDS) {
    test(`${rel} does not reintroduce a retired source`, () => {
      const text = gunzipSync(readFileSync(join(ROOT, rel))).toString('utf8');
      const offenders = RETIRED.filter((id) =>
        new RegExp(`INSERT INTO [\\w.]*source_priorities[^;]*'${id}'`).test(text),
      );
      expect(offenders).toEqual([]);
    });
  }
});
