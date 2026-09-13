#!/usr/bin/env bun
/**
 * Decide 一級 / 二級 / その他 for every watershed from 国土数値情報 and
 * emit the result as a migration (kind + ndi_code, keyed by watersheds.code).
 *
 *   bin/fetch_w05.sh                                        # once: W05 + codelist → data/nlni/w05/
 *   bun run apps/web/bin/classify_watershed_kind.ts --out packages/db/migrations/00NN_….sql
 *   bun run packages/db/src/migrate.ts                      # apply locally
 *   bun run apps/web/bin/generate_master_upsert.ts          # refresh the prod seed
 *
 * The default --out is migration 0041 (the committed result). A DB that has
 * already recorded 0041 will not re-run it, so a re-classification must go
 * into a new migration number.
 *
 * Inputs
 *   - 水系域コード codelist (code → 水系名): decides 一級 (prefix 81–89)
 *   - W05 Stream tables (水系域コード → 区間種別): decides 二級 vs その他
 *   - watersheds + dams (name, prefectures): which same-named system a row is
 *
 * Prints a JSON review report to stdout: kind counts, every name that did
 * not match the codelist, and every ambiguous name with the candidate picked.
 */
import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { parseArgs } from 'node:util';
import {
  type ClassifiedWatershed,
  classifyWatersheds,
  collectW05SectionTypes,
  parseWaterSystemCodelist,
  renderWatershedKindMigration,
} from '@dam/adapters-ndi';
import { sql } from '@dam/db/client';

const DEFAULT_OUT = 'packages/db/migrations/0041_watersheds_kind_from_ndi.sql';

interface DbRow {
  code: string;
  name: string;
  kind: string;
  prefCodes: string[];
}

async function loadStreamTables(dir: string): Promise<Uint8Array[]> {
  const names = (await readdir(dir)).filter((f) => f.endsWith('_Stream.dbf')).sort();
  if (names.length === 0) throw new Error(`no *_Stream.dbf in ${dir} — run bin/fetch_w05.sh`);
  return Promise.all(names.map(async (f) => new Uint8Array(await readFile(join(dir, f)))));
}

function countBy<T>(items: readonly T[], key: (t: T) => string): Record<string, number> {
  const counts = new Map<string, number>();
  for (const it of items) counts.set(key(it), (counts.get(key(it)) ?? 0) + 1);
  return Object.fromEntries(counts);
}

function report(before: readonly DbRow[], after: readonly ClassifiedWatershed[]) {
  const beforeKind = new Map(before.map((r) => [r.code, r.kind]));
  return {
    total: after.length,
    kinds: countBy(after, (r) => r.kind),
    transitions: countBy(after, (r) => `${beforeKind.get(r.code)}→${r.kind}`),
    unmatched: after.filter((r) => r.candidates.length === 0).map((r) => r.name),
    ambiguous: after
      .filter((r) => r.candidates.length > 1)
      .map((r) => ({ name: r.name, picked: r.ndiCode, kind: r.kind, candidates: r.candidates })),
  };
}

async function main(): Promise<void> {
  const { values } = parseArgs({
    args: process.argv.slice(2),
    options: {
      'w05-dir': { type: 'string', default: `${process.cwd()}/data/nlni/w05` },
      out: { type: 'string', default: `${process.cwd()}/${DEFAULT_OUT}` },
    },
  });
  const w05Dir = values['w05-dir'];
  const out = values.out;
  if (!w05Dir || !out) throw new Error('unreachable: defaults are set');

  const codelist = parseWaterSystemCodelist(
    await readFile(join(w05Dir, 'WaterSystemCodeCd.html'), 'utf8'),
  );
  const streams = await loadStreamTables(w05Dir);
  const sectionTypes = collectW05SectionTypes(streams);
  const rows = await sql<DbRow[]>`
    SELECT
      w.code, w.name, w.kind,
      COALESCE(array_agg(DISTINCT d.pref_code) FILTER (WHERE d.pref_code IS NOT NULL), '{}')
        AS "prefCodes"
    FROM watersheds w
    LEFT JOIN dams d ON d.watershed_id = w.id
    GROUP BY w.id
    ORDER BY w.id
  `;

  const classified = classifyWatersheds(rows, codelist, sectionTypes);
  const note = `watersheds.kind + ndi_code from 国土数値情報 (水系域コード codelist + W05 区間種別), ${streams.length} prefecture tables, ${codelist.size} codes, ${sectionTypes.size} with W05 evidence (#21)`;
  await Bun.write(out, renderWatershedKindMigration(classified, note));

  console.log(JSON.stringify({ out, ...report(rows, classified) }, null, 2));
}

main()
  .catch((e) => {
    console.error(e);
    process.exitCode = 1;
  })
  .finally(() => sql.end({ timeout: 5 }));
