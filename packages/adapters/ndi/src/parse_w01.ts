import type { ParsedDam } from './types.ts';

interface W01Properties {
  W01_001?: string; // unique id
  W01_002?: string; // name
  W01_003?: string; // pref code
  W01_004?: string; // manager
  W01_005?: string; // type
  W01_006?: string; // height m
  W01_007?: string; // total capacity m3
  W01_008?: string; // effective capacity
  W01_009?: string; // flood capacity
  W01_010?: string; // completed year
  W01_021?: string; // watershed code
}

interface Feature {
  type: 'Feature';
  properties: W01Properties;
  geometry: { type: 'Point'; coordinates: number[] };
}

interface FC {
  type: 'FeatureCollection';
  features: Feature[];
}

function isFC(v: unknown): v is FC {
  return (
    typeof v === 'object' &&
    v !== null &&
    (v as { type?: string }).type === 'FeatureCollection' &&
    Array.isArray((v as { features?: unknown }).features)
  );
}

function num(s: string | undefined): number | null {
  if (s === undefined || s === '') return null;
  const n = Number(s);
  return Number.isFinite(n) ? n : null;
}

function intish(s: string | undefined): number | null {
  const n = num(s);
  return n === null ? null : Math.trunc(n);
}

export function parseW01(rawJson: string): ParsedDam[] {
  const data: unknown = JSON.parse(rawJson);
  if (!isFC(data)) throw new Error('W01: not a FeatureCollection');
  const out: ParsedDam[] = [];
  for (const f of data.features) {
    const id = f.properties.W01_001;
    const name = f.properties.W01_002;
    const pref = f.properties.W01_003;
    if (!id || !name || !pref) continue;
    const coords = f.geometry?.coordinates;
    if (!Array.isArray(coords) || coords.length < 2) continue;
    const lng = coords[0];
    const lat = coords[1];
    if (typeof lng !== 'number' || typeof lat !== 'number') continue;
    out.push({
      ndiId: id,
      name,
      prefCode: pref.padStart(2, '0'),
      manager: f.properties.W01_004 ?? null,
      type: f.properties.W01_005 ?? null,
      heightM: num(f.properties.W01_006),
      totalCapacityM3: num(f.properties.W01_007),
      effectiveCapacityM3: num(f.properties.W01_008),
      floodCapacityM3: num(f.properties.W01_009),
      completedYear: intish(f.properties.W01_010),
      watershedCode: f.properties.W01_021 ?? null,
      lat,
      lng,
    });
  }
  return out;
}
