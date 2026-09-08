/**
 * 国土数値情報 W07（流域メッシュ）: one feature per 100 m mesh cell.
 *
 *   W07_001 細分メッシュコード      W07_002 水系域コード (6 桁)
 *   W07_003 河川コード (10 桁)      W07_004 水系名       W07_005 河川名
 *
 * W07 carries no 一級/二級 flag; `kind` here is what the 水系域コード alone
 * can tell (8x prefix → 一級). Splitting 二級 from その他 needs W05 — see
 * classify_watersheds.ts.
 */
import type { ParsedWatershed } from './types.ts';
import { kindFromWatershedCode } from './watershed_kind.ts';

interface W07Properties {
  W07_001?: string;
  W07_002?: string;
  W07_003?: string;
  W07_004?: string;
  W07_005?: string;
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

const UNKNOWN_SYSTEM_CODE = /^\d{2}0000$/;

function isFC(v: unknown): v is W07FeatureCollection {
  return (
    typeof v === 'object' &&
    v !== null &&
    (v as { type?: string }).type === 'FeatureCollection' &&
    Array.isArray((v as { features?: unknown }).features)
  );
}

export function parseW07(rawJson: string): ParsedWatershed[] {
  const data: unknown = JSON.parse(rawJson);
  if (!isFC(data)) throw new Error('W07: not a FeatureCollection');
  const out: ParsedWatershed[] = [];
  for (const f of data.features) {
    const code = f.properties.W07_002;
    const name = f.properties.W07_004;
    if (!code || !name || UNKNOWN_SYSTEM_CODE.test(code)) continue;
    if (f.geometry?.type !== 'Polygon' && f.geometry?.type !== 'MultiPolygon') continue;
    out.push({
      code,
      ndiCode: code,
      name,
      kind: kindFromWatershedCode(code),
      geometry: f.geometry,
    });
  }
  return out;
}
