/**
 * Seed the watersheds master from the unique river-system names found in W01.
 * Boundary stays NULL until the W07 mesh-tile dissolve runs.
 */
import { readFile } from 'node:fs/promises';
import { suffixedSlug, toSlug } from '@dam/core/slug';
import { sql } from '@dam/db/client';

interface Feature {
  type: 'Feature';
  properties: { W01_003?: string };
}
interface FC {
  type: 'FeatureCollection';
  features: Feature[];
}
const isFC = (v: unknown): v is FC =>
  typeof v === 'object' && v !== null && (v as { type?: string }).type === 'FeatureCollection';

async function main(): Promise<void> {
  const path = process.argv[2] ?? `${process.cwd()}/data/nlni/w01.geojson`;
  const data: unknown = JSON.parse(await readFile(path, 'utf8'));
  if (!isFC(data)) throw new Error('not a FeatureCollection');

  const names = new Set<string>();
  for (const f of data.features) {
    const n = f.properties.W01_003;
    if (n) names.add(n);
  }

  const taken = new Set(
    (await sql<{ slug: string }[]>`SELECT slug FROM watersheds`).map((r) => r.slug),
  );

  let inserted = 0;
  let skipped = 0;
  for (const name of names) {
    const stem = name.replace(/水系$/u, '');
    const base = toSlug(stem) || `watershed-${name}`;
    const slug = suffixedSlug(base, taken);
    taken.add(slug);
    const code = `W01-${name}`;
    const result = await sql`
      INSERT INTO watersheds (code, slug, name, kind, boundary)
      VALUES (${code}, ${slug}, ${name}, 'other', NULL)
      ON CONFLICT (code) DO NOTHING
      RETURNING id
    `;
    if (result.length > 0) inserted++;
    else skipped++;
  }
  console.log(JSON.stringify({ totalNames: names.size, inserted, skipped }));
}

main()
  .catch((e) => {
    console.error(e);
    process.exitCode = 1;
  })
  .finally(() => sql.end({ timeout: 5 }));
