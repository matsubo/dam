import { suffixedSlug, toSlug } from '@dam/core/slug';
import { sql } from '@dam/db/client';
import { upsertWatershed } from '@dam/db/repo/watersheds';
import type { ParsedWatershed } from './types.ts';

export interface ImportResult {
  upserted: number;
}

export async function importWatersheds(parsed: ParsedWatershed[]): Promise<ImportResult> {
  const taken = new Set(
    (await sql<{ slug: string }[]>`SELECT slug FROM watersheds`).map((r) => r.slug),
  );

  let count = 0;
  for (const w of parsed) {
    const base = toSlug(w.name) || `watershed-${w.code}`;
    const slug = suffixedSlug(base, taken);
    taken.add(slug);

    const geometry: GeoJSON.MultiPolygon =
      w.geometry.type === 'MultiPolygon'
        ? w.geometry
        : { type: 'MultiPolygon', coordinates: [w.geometry.coordinates] };

    await upsertWatershed({
      code: w.code,
      slug,
      name: w.name,
      nameKana: w.nameKana ?? null,
      kind: w.kind,
      boundaryGeoJSON: geometry,
      areaKm2: w.areaKm2 ?? null,
    });
    count++;
  }
  return { upserted: count };
}
