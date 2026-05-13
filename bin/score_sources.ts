// bin/score_sources.ts
//
// Joins docs/superpowers/sources-backlog.json against the live `dams` table
// to:
//   1. Count how many master dams each candidate `managerPattern` actually
//      covers — keeps the manifest honest as master grows / shrinks.
//   2. Score each candidate by
//        yield = damCount × cadenceWeight × legalWeight ÷ adapterCost
//      to rank the work backlog.
//   3. Emit a markdown-ish table for humans + the updated JSON for tooling.
//
// Usage:
//   bun run bin/score_sources.ts             # print ranked table
//   bun run bin/score_sources.ts --write     # also overwrite the JSON with
//                                            # damCount field filled in
//
// Auto-runs against the local DB (DATABASE_URL env). Read-only — no writes
// unless --write is passed (and even then only to the JSON file).

import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { parseArgs } from 'node:util';
import { sql } from '../packages/db/src/client.ts';

const MANIFEST_PATH = join(import.meta.dir, '..', 'docs', 'superpowers', 'sources-backlog.json');

const CADENCE_WEIGHT: Record<string, number> = {
  hourly: 24,
  daily: 1,
  '10d': 0.1,
  unknown: 0.5,
};

const LEGAL_WEIGHT: Record<string, number> = {
  open: 1,
  mixed: 0.4,
  blocked: 0.05,
  unknown: 0.5,
};

const ADAPTER_COST: Record<string, number> = {
  'html-table': 1,
  'js-rendered': 3,
  pdf: 5,
  xml: 1,
  sparql: 2,
  unknown: 2,
};

interface Manifest {
  _meta: Record<string, unknown>;
  covered: Array<{ id: string; operator: string; dams: number; cadence: string }>;
  candidates: Array<{
    managerPattern: string;
    operator: string;
    url: string | null;
    format: string;
    license: string;
    cadence: string;
    legalStance: string;
    status: string;
    notes?: string;
  }>;
}

async function patternToCount(pattern: string): Promise<number> {
  if (pattern === '*') return 0; // wildcard candidates have no DB-derivable count
  // Split on '|' for OR patterns. Each alternative is a substring match.
  const parts = pattern
    .split('|')
    .map((s) => s.trim())
    .filter(Boolean);
  const totals = await Promise.all(
    parts.map(async (p) => {
      const r = await sql<{ n: number }[]>`
        SELECT COUNT(*)::int AS n FROM dams WHERE manager LIKE ${`%${p}%`}
      `;
      return r[0]?.n ?? 0;
    }),
  );
  return totals.reduce((a, b) => a + b, 0);
}

interface Scored {
  rank: number;
  operator: string;
  damCount: number;
  cadence: string;
  legalStance: string;
  format: string;
  status: string;
  score: number;
  url: string | null;
}

async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  const { values } = parseArgs({
    args: argv,
    options: { write: { type: 'boolean', default: false } },
    allowPositionals: true,
  });

  const raw = await readFile(MANIFEST_PATH, 'utf8');
  const manifest = JSON.parse(raw) as Manifest;

  const scored: Scored[] = [];
  let i = 0;
  for (const c of manifest.candidates) {
    const damCount = await patternToCount(c.managerPattern);
    const cw = CADENCE_WEIGHT[c.cadence] ?? CADENCE_WEIGHT.unknown ?? 0.5;
    const lw = LEGAL_WEIGHT[c.legalStance] ?? LEGAL_WEIGHT.unknown ?? 0.5;
    const ac = ADAPTER_COST[c.format] ?? ADAPTER_COST.unknown ?? 2;
    const score = (damCount * cw * lw) / ac;
    scored.push({
      rank: ++i,
      operator: c.operator,
      damCount,
      cadence: c.cadence,
      legalStance: c.legalStance,
      format: c.format,
      status: c.status,
      score: Math.round(score * 10) / 10,
      url: c.url,
    });
  }

  scored.sort((a, b) => b.score - a.score);
  scored.forEach((s, idx) => {
    s.rank = idx + 1;
  });

  console.log('| # | Operator | Dams | Cadence | Legal | Format | Status | Score |');
  console.log('|---|---|---:|---|---|---|---|---:|');
  for (const s of scored) {
    console.log(
      `| ${s.rank} | ${s.operator} | ${s.damCount} | ${s.cadence} | ${s.legalStance} | ${s.format} | ${s.status} | ${s.score.toFixed(1)} |`,
    );
  }

  if (values.write) {
    // Fill back damCount into the manifest (preserve existing shape).
    const updated = {
      ...manifest,
      candidates: manifest.candidates.map((c) => ({
        ...c,
        damCount: scored.find((s) => s.operator === c.operator)?.damCount ?? 0,
        score: scored.find((s) => s.operator === c.operator)?.score ?? 0,
      })),
    };
    await writeFile(MANIFEST_PATH, `${JSON.stringify(updated, null, 2)}\n`);
    console.log(`\nWrote ${MANIFEST_PATH}`);
  }

  await sql.end();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
