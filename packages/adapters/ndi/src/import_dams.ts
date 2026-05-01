import { suffixedSlug, toSlug } from '@dam/core/slug';
import { sql } from '@dam/db/client';
import { takenSlugs, upsertDamByExternalId } from '@dam/db/repo/dams';
import type { ParsedDam } from './types.ts';

export interface ImportResult {
  upserted: number;
}

export async function importDams(parsed: ParsedDam[]): Promise<ImportResult> {
  const taken = await takenSlugs('');
  const watershedMap = new Map(
    (await sql<{ id: bigint; code: string }[]>`SELECT id, code FROM watersheds`).map(
      (r) => [r.code, r.id] as const,
    ),
  );

  let count = 0;
  let unresolved = 0;

  for (const d of parsed) {
    const base = toSlug(d.name) || `dam-${d.ndiId}`;
    const candidate = `${base}-${d.prefCode}`;
    const slug = suffixedSlug(candidate, taken);
    taken.add(slug);

    let watershedId: bigint | null = null;
    if (d.watershedCode) {
      watershedId = watershedMap.get(d.watershedCode) ?? null;
      if (watershedId === null) {
        unresolved++;
      }
    }

    await upsertDamByExternalId('ndi', {
      slug,
      name: d.name,
      prefCode: d.prefCode,
      watershedId,
      manager: d.manager ?? null,
      type: d.type ?? null,
      heightM: d.heightM ?? null,
      totalCapacityM3: d.totalCapacityM3 ?? null,
      effectiveCapacityM3: d.effectiveCapacityM3 ?? null,
      floodCapacityM3: d.floodCapacityM3 ?? null,
      completedYear: d.completedYear ?? null,
      lat: d.lat,
      lng: d.lng,
      externalIds: { ndi: d.ndiId },
    });
    count++;
  }

  if (unresolved > 0) {
    console.warn(
      `importDams: ${unresolved} dams had a watershedCode that did not resolve to a known watershed`,
    );
  }

  return { upserted: count };
}
