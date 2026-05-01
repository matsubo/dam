import type { ParsedWatershed } from './types.ts';

interface W07Properties {
  W07_001?: string;
  W07_002?: string;
  W07_003?: string; // "1"=first-class, "2"=second-class
}

interface W07Feature {
  type: 'Feature';
  properties: W07Properties;
  geometry: GeoJSON.Polygon | GeoJSON.MultiPolygon;
}

interface W07FeatureCollection {
  type: 'FeatureCollection';
  features: W07Feature[];
}

function isFC(v: unknown): v is W07FeatureCollection {
  return (
    typeof v === 'object' &&
    v !== null &&
    (v as { type?: string }).type === 'FeatureCollection' &&
    Array.isArray((v as { features?: unknown }).features)
  );
}

function kindFromCode(code: string | undefined): ParsedWatershed['kind'] {
  if (code === '1') return 'first';
  if (code === '2') return 'second';
  return 'other';
}

export function parseW07(rawJson: string): ParsedWatershed[] {
  const data: unknown = JSON.parse(rawJson);
  if (!isFC(data)) throw new Error('W07: not a FeatureCollection');
  const out: ParsedWatershed[] = [];
  for (const f of data.features) {
    const code = f.properties.W07_001;
    const name = f.properties.W07_002;
    if (!code || !name) continue;
    if (f.geometry?.type !== 'Polygon' && f.geometry?.type !== 'MultiPolygon') continue;
    out.push({
      code,
      name,
      kind: kindFromCode(f.properties.W07_003),
      geometry: f.geometry,
    });
  }
  return out;
}
