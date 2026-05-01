import { parseArgs } from 'node:util';
import { sql } from '@dam/db/client';
import { loadGeoJson } from './fetcher.ts';
import { importDams } from './import_dams.ts';
import { importWatersheds } from './import_watersheds.ts';
import { parseW01 } from './parse_w01.ts';
import { parseW07 } from './parse_w07.ts';

async function main(): Promise<void> {
  const sub = process.argv[2];
  const argv = process.argv.slice(3).filter((a) => a !== '--');
  const { values } = parseArgs({
    args: argv,
    options: { source: { type: 'string' } },
    allowPositionals: true,
  });
  if (!values.source) {
    console.error('Missing --source <url-or-path>');
    process.exit(2);
  }
  const raw = await loadGeoJson(values.source);

  if (sub === 'watersheds') {
    const parsed = parseW07(raw);
    const r = await importWatersheds(parsed);
    console.log(`watersheds upserted: ${r.upserted}`);
    return;
  }
  if (sub === 'dams') {
    const parsed = parseW01(raw);
    const r = await importDams(parsed);
    console.log(`dams upserted: ${r.upserted}`);
    return;
  }
  console.error(`Unknown subcommand: ${sub}`);
  process.exit(2);
}

main()
  .catch((e) => {
    console.error(e);
    process.exitCode = 1;
  })
  .finally(async () => {
    await sql.end({ timeout: 5 });
  });
