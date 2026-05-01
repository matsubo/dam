/**
 * One-off importer for the real NLNI W01 v3.2 dam dataset.
 *
 * Real schema (W01-14 release) differs from the synthetic test fixture used
 * in Plan 1; the planned `parseW01` was written against an early schema
 * sketch. Real columns observed in W01-14-g_Dam.shp:
 *   W01_001 ダム名         (string)   e.g. "駒込"
 *   W01_002 ダムコード     (number)   e.g. 191
 *   W01_003 水系名         (string)   e.g. "堤川"
 *   W01_004 河川名         (string)
 *   W01_005 ダム型式コード (string)   e.g. "7"
 *   W01_006 目的コード     (csv)      e.g. "1,2,6"
 *   W01_007 堤高           (number m)
 *   W01_008 堤頂長         (number m)
 *   W01_009 流域面積       (number km²)
 *   W01_010 総貯水容量     (number 千m³)
 *   W01_011 事業者コード   (string)
 *   W01_012 完成年         (string year or "-")
 *   W01_013 所在地         (string address starting with prefecture name)
 *   W01_014 規模           (number)
 *
 * Pre-requisite: ogr2ogr -f GeoJSON data/nlni/w01.geojson data/nlni/W01/W01-14-g_Dam.shp
 */
import { readFile } from 'node:fs/promises';
import { PREFECTURES } from '@dam/core/prefectures';
import { suffixedSlug, toSlug } from '@dam/core/slug';
import { sql } from '@dam/db/client';
import { takenSlugs, upsertDamByExternalId } from '@dam/db/repo/dams';

const SOURCE = process.argv[2] ?? `${process.cwd()}/../../data/nlni/w01.geojson`;

const TYPE_CODE_TO_LABEL: Record<string, string> = {
  '1': '重力式コンクリート',
  '2': 'アーチ式コンクリート',
  '3': '重力式アーチ',
  '4': 'バットレス',
  '5': '中空重力',
  '6': '複合',
  '7': 'アースフィル',
  '8': 'ロックフィル',
  '9': '中空重力アーチ',
  '10': 'その他',
  '11': '重力式コンクリート・フィル複合',
  '12': '重力式コンクリート・アースフィル複合',
  '13': '特殊',
};

const PREF_BY_NAME = new Map(PREFECTURES.map((p) => [p.name, p.code] as const));

interface RawProps {
  W01_001?: string;
  W01_002?: number | string;
  W01_003?: string;
  W01_004?: string;
  W01_005?: string;
  W01_006?: string;
  W01_007?: number;
  W01_008?: number;
  W01_009?: number;
  W01_010?: number;
  W01_011?: string;
  W01_012?: string | number;
  W01_013?: string;
}
interface Feature {
  type: 'Feature';
  properties: RawProps;
  geometry: { type: 'Point'; coordinates: number[] };
}
interface FC {
  type: 'FeatureCollection';
  features: Feature[];
}

function isFC(v: unknown): v is FC {
  return (
    typeof v === 'object' && v !== null && (v as { type?: string }).type === 'FeatureCollection'
  );
}

function prefCodeFromAddress(addr: string | undefined): string | null {
  if (!addr) return null;
  for (const p of PREFECTURES) {
    if (addr.startsWith(p.name)) return p.code;
  }
  return null;
}

function intish(v: unknown): number | null {
  if (v === undefined || v === null || v === '' || v === '-') return null;
  const n = typeof v === 'number' ? v : Number(v);
  return Number.isFinite(n) ? Math.trunc(n) : null;
}

function num(v: unknown): number | null {
  if (v === undefined || v === null || v === '' || v === '-') return null;
  const n = typeof v === 'number' ? v : Number(v);
  return Number.isFinite(n) ? n : null;
}

async function main(): Promise<void> {
  const raw = await readFile(SOURCE, 'utf8');
  const data: unknown = JSON.parse(raw);
  if (!isFC(data)) throw new Error('not a FeatureCollection');

  const watershedRows = await sql<{ id: bigint; name: string }[]>`SELECT id, name FROM watersheds`;
  const watershedByName = new Map(
    watershedRows.map((w) => [w.name.replace(/水系$/, ''), w.id] as const),
  );

  const taken = await takenSlugs('');

  let inserted = 0;
  let skippedNoPref = 0;
  let skippedNoCoord = 0;

  for (const f of data.features) {
    const p = f.properties;
    const name = p.W01_001;
    const ndiCode = p.W01_002;
    if (!name || ndiCode === undefined || ndiCode === null) continue;
    const coords = f.geometry?.coordinates;
    if (!Array.isArray(coords) || coords.length < 2) {
      skippedNoCoord++;
      continue;
    }
    const lng = coords[0];
    const lat = coords[1];
    if (typeof lng !== 'number' || typeof lat !== 'number') {
      skippedNoCoord++;
      continue;
    }

    const prefCode = prefCodeFromAddress(p.W01_013);
    if (!prefCode) {
      skippedNoPref++;
      continue;
    }

    const baseSlug = toSlug(name) || `dam-${ndiCode}`;
    const candidate = `${baseSlug}-${prefCode}`;
    const slug = suffixedSlug(candidate, taken);
    taken.add(slug);

    const ndiId = String(ndiCode);
    const typeLabel =
      p.W01_005 && p.W01_005 !== '-' ? (TYPE_CODE_TO_LABEL[p.W01_005] ?? p.W01_005) : null;
    const totalCapacityM3 = p.W01_010 ? p.W01_010 * 1_000 : null; // 千m³ → m³
    const watershedId = p.W01_003 ? (watershedByName.get(p.W01_003) ?? null) : null;
    const completedYear = intish(p.W01_012);
    const heightM = num(p.W01_007);

    await upsertDamByExternalId('ndi', {
      slug,
      name,
      prefCode,
      watershedId,
      type: typeLabel,
      heightM,
      totalCapacityM3,
      completedYear,
      lat,
      lng,
      externalIds: { ndi: ndiId },
    });
    inserted++;
  }

  console.log(
    JSON.stringify({ inserted, skippedNoPref, skippedNoCoord, total: data.features.length }),
  );
}

main()
  .catch((e) => {
    console.error(e);
    process.exitCode = 1;
  })
  .finally(() => sql.end({ timeout: 5 }));
