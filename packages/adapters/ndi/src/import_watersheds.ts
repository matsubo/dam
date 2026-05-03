import { suffixedSlug, toSlug } from '@dam/core/slug';
import { sql } from '@dam/db/client';
import { upsertWatershed } from '@dam/db/repo/watersheds';
import type { ParsedWatershed } from './types.ts';

interface ImportResult {
  upserted: number;
}

export async function importWatersheds(parsed: ParsedWatershed[]): Promise<ImportResult> {
  const existing = new Map(
    (await sql<{ code: string; slug: string }[]>`SELECT code, slug FROM watersheds`).map(
      (r) => [r.code, r.slug] as const,
    ),
  );
  const taken = new Set(existing.values());

  let count = 0;
  for (const w of parsed) {
    const slug =
      existing.get(w.code) ??
      (() => {
        const base = toSlug(w.name) || `watershed-${w.code}`;
        const candidate = suffixedSlug(base, taken);
        taken.add(candidate);
        return candidate;
      })();

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
