/**
 * Repair kanji-only / placeholder dam slugs once `name_kana` becomes available.
 *
 * Many dams were ingested from the NLNI W01 master, which only carries a kanji
 * name. `toSlug()` on a kanji-only string returns an empty base, so the
 * importer falls back to a placeholder slug like `dam-1102-16`. When a later
 * source (e.g. Damnet) populates `name_kana`, we can recompute a romaji slug.
 *
 * This script walks all dams whose slug still looks like the placeholder
 * pattern AND that now have a `name_kana`, recomputes the slug from kana, and
 * updates the row. It de-duplicates against currently-taken slugs.
 *
 * Safe to run repeatedly: a no-op when there is nothing to repair.
 *
 * Usage: bun run apps/web/bin/repair_dam_slugs.ts
 */
import { suffixedSlug, toSlug } from '@dam/core/slug';
import { sql } from '@dam/db/client';

async function main(): Promise<void> {
  const rows = await sql<
    { id: bigint; slug: string; name: string; name_kana: string | null; pref_code: string }[]
  >`
    SELECT id, slug, name, name_kana, pref_code
    FROM dams
    WHERE slug LIKE 'dam-%'
      AND name_kana IS NOT NULL
  `;
  if (rows.length === 0) {
    console.log('nothing to repair');
    return;
  }
  const taken = new Set((await sql<{ slug: string }[]>`SELECT slug FROM dams`).map((r) => r.slug));

  let updated = 0;
  for (const r of rows) {
    const base = toSlug(r.name_kana ?? r.name);
    if (!base) continue;
    const candidate = `${base}-${r.pref_code}`;
    const next = suffixedSlug(candidate, taken);
    if (next === r.slug) continue;
    taken.delete(r.slug);
    taken.add(next);
    await sql`UPDATE dams SET slug = ${next} WHERE id = ${r.id}`;
    updated++;
  }
  console.log(JSON.stringify({ updated, total: rows.length }));
}

main()
  .catch((e) => {
    console.error(e);
    process.exitCode = 1;
  })
  .finally(() => sql.end({ timeout: 5 }));
