import { readFile, readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { sql } from './client.ts';

async function ensureTable(): Promise<void> {
  await sql`CREATE TABLE IF NOT EXISTS _migrations (
    name TEXT PRIMARY KEY,
    applied_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
  )`;
}

async function appliedSet(): Promise<Set<string>> {
  const rows = await sql<{ name: string }[]>`SELECT name FROM _migrations`;
  return new Set(rows.map((r) => r.name));
}

async function migrationFiles(dir: string): Promise<string[]> {
  try {
    const entries = await readdir(dir);
    return entries.filter((e) => e.endsWith('.sql')).sort();
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return [];
    throw err;
  }
}

async function main(): Promise<void> {
  const dir = join(import.meta.dir, '..', 'migrations');
  await ensureTable();
  const applied = await appliedSet();
  const files = await migrationFiles(dir);

  for (const file of files) {
    if (applied.has(file)) {
      console.log(`= ${file} (skip)`);
      continue;
    }
    const path = join(dir, file);
    const body = await readFile(path, 'utf8');
    console.log(`> ${file}`);
    await sql.begin(async (tx) => {
      await tx.unsafe(body);
      await tx`INSERT INTO _migrations (name) VALUES (${file})`;
    });
  }

  await sql.end();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
