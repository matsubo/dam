// bin/test_db.ts
//
// Recreates an empty, per-worktree scratch database next to the one
// DATABASE_URL names, and prints its URL on stdout.
//
// The integration tests share whatever database they are pointed at and
// measure deltas against it. Run against the long-lived dev `dam` DB they
// fail spuriously — from leftover rows, and from a second worktree's suite
// running at the same time and deleting the same fixture IDs mid-run
// (2026-09-26: 6 phantom failures in coverage / storage_totals). Each
// worktree therefore gets its own database, dropped and recreated per run.
//
// Usage (the pre-push hook does this):
//   export DATABASE_URL=$(bun run bin/test_db.ts "$DATABASE_URL" "$(git rev-parse --show-toplevel)")
//   bun run --filter @dam/db migrate

import { createHash } from 'node:crypto';
import { basename } from 'node:path';
import postgres from 'postgres';

const PG_IDENTIFIER_MAX = 63;

/** Same server and credentials, database `<db>_test_<worktree>_<hash>`. */
export function scratchDatabaseUrl(baseUrl: string, worktreePath: string): string {
  const url = new URL(baseUrl);
  const baseDb = url.pathname.slice(1) || 'postgres';
  const hash = createHash('sha1').update(worktreePath).digest('hex').slice(0, 8);
  const label = basename(worktreePath)
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '');
  const prefix = `${baseDb}_test_${label}`.slice(0, PG_IDENTIFIER_MAX - hash.length - 1);
  url.pathname = `/${prefix.replace(/_+$/, '')}_${hash}`;
  return url.toString();
}

async function recreate(scratchUrl: string): Promise<void> {
  const url = new URL(scratchUrl);
  const name = url.pathname.slice(1);
  url.pathname = '/postgres';
  const admin = postgres(url.toString(), { max: 1, onnotice: () => {} });
  try {
    await admin.unsafe(`DROP DATABASE IF EXISTS "${name}" WITH (FORCE)`);
    await admin.unsafe(`CREATE DATABASE "${name}"`);
  } finally {
    await admin.end();
  }
}

if (import.meta.main) {
  const [baseUrl, worktreePath] = process.argv.slice(2);
  if (!baseUrl || !worktreePath) {
    console.error('usage: bun run bin/test_db.ts <database-url> <worktree-path>');
    process.exit(2);
  }
  const scratch = scratchDatabaseUrl(baseUrl, worktreePath);
  try {
    await recreate(scratch);
  } catch (err) {
    console.error(`test_db: could not recreate ${new URL(scratch).pathname.slice(1)}:`, err);
    process.exit(1);
  }
  process.stdout.write(`${scratch}\n`);
}
