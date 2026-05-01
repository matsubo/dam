import { suffixedSlug, toSlug } from '@dam/core/slug';
import { sql } from '@dam/db/client';
import { takenSlugs, upsertDamByExternalId } from '@dam/db/repo/dams';
import type { ParsedDam } from './types.ts';

export interface ImportResult {
  upserted: number;
}

async function watershedIdByCode(code: string): Promise<bigint | null> {
  const rows = await sql<{ id: bigint }[]>`SELECT id FROM watersheds WHERE code = ${code}`;
  return rows[0]?.id ?? null;
}

export async function importDams(parsed: ParsedDam[]): Promise<ImportResult> {
  const taken = await takenSlugs('');
  let count = 0;

  for (const d of parsed) {
    const base = toSlug(d.name) || `dam-${d.ndiId}`;
    const candidate = `${base}-${d.prefCode}`;
    const slug = suffixedSlug(candidate, taken);
    taken.add(slug);

    const watershedId = d.watershedCode ? await watershedIdByCode(d.watershedCode) : null;

    await upsertDamByExternalId('ndi', {
      slug,
      name: d.name,
      prefCode: d.prefCode,
      watershedId,
      manager: d.manager ?? null,
      type: d.type ?? null,
      heightM: d.heightM,
      totalCapacityM3: d.totalCapacityM3,
      effectiveCapacityM3: d.effectiveCapacityM3,
      floodCapacityM3: d.floodCapacityM3,
      completedYear: d.completedYear,
      lat: d.lat,
      lng: d.lng,
      externalIds: { ndi: d.ndiId },
    });
    count++;
  }

  return { upserted: count };
}
