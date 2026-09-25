/**
 * Match damnet captures (data/damnet/dams.jsonl) to our master dams table:
 * attach external_ids.damnet, back-fill attributes and repair placeholder
 * slugs. Same rules as the monthly `master:refresh:damnet` task — see
 * packages/adapters/damnet/src/assign.ts.
 */
import { readFile } from 'node:fs/promises';
import { applyDamnetCaptures, type DamInfo } from '@dam/adapters-damnet';
import { sql } from '@dam/db/client';

async function main(): Promise<void> {
  const path = process.argv[2] ?? `${process.cwd()}/data/damnet/dams.jsonl`;
  const raw = await readFile(path, 'utf8');
  const captures = raw
    .split('\n')
    .filter(Boolean)
    .map((l) => JSON.parse(l) as DamInfo);
  const stats = await applyDamnetCaptures(captures, (s) => console.log(s));
  console.log(JSON.stringify(stats));
}

main()
  .catch((e) => {
    console.error(e);
    process.exitCode = 1;
  })
  .finally(() => sql.end({ timeout: 5 }));
