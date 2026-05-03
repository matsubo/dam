/**
 * Match damnet captures (data/damnet/dams.jsonl) to our master dams table.
 * Strategy: match by (name OR name_kana) + prefecture; fill in missing
 * name_kana, manager, completion_year, type, height, capacity, attach
 * external_ids.damnet, then call the slug repair logic for newly-kana'd rows.
 */
import { readFile } from 'node:fs/promises';
import { suffixedSlug, toSlug } from '@dam/core/slug';
import { sql } from '@dam/db/client';

interface DamInfo {
  id: number;
  dam_number: string;
  dam_name: string;
  dam_name_kana: string;
  prefecture: string;
  river_name: string;
  completion_year: string;
  construction_start_year: string;
  type: string;
  height: string;
  capacity_total: string;
  capacity_active: string;
  operator: string;
  // Additional master attributes (all strings as JSON-decoded; "" when absent)
  purposes: string;
  crest_length: string;
  embankment_volume: string;
  watershed_area: string | number;
  reservoir_area: string | number;
  left_bank_location: string;
  main_contractor: string;
  redevelopment_status: string;
}

const TYPE_LETTER_TO_LABEL: Record<string, string> = {
  G: '重力式コンクリート',
  A: 'アーチ式コンクリート',
  GA: '重力式アーチ',
  HG: '中空重力',
  E: 'アースフィル',
  R: 'ロックフィル',
  CFRD: 'コンクリート表面遮水壁型ロックフィル',
  GE: '重力式コンクリート・アースフィル複合',
  GF: '重力式コンクリート・フィル複合',
  BU: 'バットレス',
  MA: '多目的アーチ',
};

interface DamRow {
  id: bigint;
  slug: string;
  name: string;
  pref_code: string;
  external_ids: Record<string, string>;
}

const PREFECTURES_BY_NAME: Record<string, string> = {
  北海道: '01',
  青森県: '02',
  岩手県: '03',
  宮城県: '04',
  秋田県: '05',
  山形県: '06',
  福島県: '07',
  茨城県: '08',
  栃木県: '09',
  群馬県: '10',
  埼玉県: '11',
  千葉県: '12',
  東京都: '13',
  神奈川県: '14',
  新潟県: '15',
  富山県: '16',
  石川県: '17',
  福井県: '18',
  山梨県: '19',
  長野県: '20',
  岐阜県: '21',
  静岡県: '22',
  愛知県: '23',
  三重県: '24',
  滋賀県: '25',
  京都府: '26',
  大阪府: '27',
  兵庫県: '28',
  奈良県: '29',
  和歌山県: '30',
  鳥取県: '31',
  島根県: '32',
  岡山県: '33',
  広島県: '34',
  山口県: '35',
  徳島県: '36',
  香川県: '37',
  愛媛県: '38',
  高知県: '39',
  福岡県: '40',
  佐賀県: '41',
  長崎県: '42',
  熊本県: '43',
  大分県: '44',
  宮崎県: '45',
  鹿児島県: '46',
  沖縄県: '47',
};

function normalizeName(s: string): string {
  return s
    .normalize('NFKC')
    .replace(/(?:ダム|貯水池|池)$/u, '')
    .trim()
    .toLowerCase();
}

function num(v: string | number | null | undefined): number | null {
  if (v == null) return null;
  if (typeof v === 'number') return Number.isFinite(v) ? v : null;
  if (!v || v === '-') return null;
  const n = Number(v.replace(/,/g, ''));
  return Number.isFinite(n) ? n : null;
}

function intish(v: string): number | null {
  const n = num(v);
  return n === null ? null : Math.trunc(n);
}

async function main(): Promise<void> {
  const path = process.argv[2] ?? `${process.cwd()}/data/damnet/dams.jsonl`;
  const raw = await readFile(path, 'utf8');
  const lines = raw.split('\n').filter(Boolean);
  const captures: DamInfo[] = lines.map((l) => JSON.parse(l) as DamInfo);

  // Preload all master dams keyed by (prefCode, normalized name)
  const allDams = await sql<DamRow[]>`
    SELECT id, slug, name, pref_code, external_ids FROM dams
  `;
  const damByKey = new Map<string, DamRow>();
  for (const d of allDams) {
    damByKey.set(`${d.pref_code}|${normalizeName(d.name)}`, d);
  }
  const allSlugs = new Set(allDams.map((d) => d.slug));

  let matched = 0;
  let skippedNoPref = 0;
  let skippedNotFound = 0;
  let attached = 0;
  let attrUpdated = 0;
  let slugUpdated = 0;

  for (const c of captures) {
    const prefCode = PREFECTURES_BY_NAME[c.prefecture];
    if (!prefCode) {
      skippedNoPref++;
      continue;
    }
    const key = `${prefCode}|${normalizeName(c.dam_name)}`;
    const target = damByKey.get(key);
    if (!target) {
      skippedNotFound++;
      continue;
    }
    matched++;

    // 1. Append damnet external_id (idempotent)
    const alreadyHas = target.external_ids?.damnet === c.dam_number;
    if (!alreadyHas) {
      await sql`
        UPDATE dams
        SET external_ids = external_ids || jsonb_build_object('damnet', ${c.dam_number}::text)
        WHERE id = ${target.id}
      `;
      attached++;
    }

    // 2. Apply attributes (only fill missing values)
    const completed = intish(c.completion_year);
    const heightM = num(c.height);
    const capacity = num(c.capacity_total);
    const capacityM3 = capacity ? capacity * 1_000 : null;
    const active = num(c.capacity_active);
    const activeCapacityM3 = active ? active * 1_000 : null;
    const typeLabel = c.type ? (TYPE_LETTER_TO_LABEL[c.type] ?? c.type) : null;
    const operator = c.operator || null;
    const kana = c.dam_name_kana || null;
    // Additional spec columns (Damnet → master)
    const constructionStart = intish(c.construction_start_year);
    const purposes = c.purposes || null;
    const crestLengthM = num(c.crest_length);
    const embankmentVolume = num(c.embankment_volume); // 千 m³
    const embankmentVolumeM3 = embankmentVolume ? embankmentVolume * 1_000 : null;
    const watershedAreaKm2 = num(c.watershed_area);
    // Damnet stores reservoir_area in hectares (1 km² = 100 ha).
    const reservoirAreaHa = num(c.reservoir_area);
    const reservoirAreaKm2 = reservoirAreaHa != null ? reservoirAreaHa / 100 : null;
    const leftBankLocation = c.left_bank_location || null;
    const mainContractor = c.main_contractor || null;
    const redevelopmentStatus = c.redevelopment_status || null;
    const hasAnyUpdate =
      kana ||
      operator ||
      typeLabel ||
      heightM ||
      capacityM3 ||
      activeCapacityM3 ||
      completed ||
      constructionStart ||
      purposes ||
      crestLengthM ||
      embankmentVolumeM3 ||
      watershedAreaKm2 ||
      reservoirAreaKm2 ||
      leftBankLocation ||
      mainContractor ||
      redevelopmentStatus;
    if (hasAnyUpdate) {
      await sql`
        UPDATE dams SET
          name_kana               = COALESCE(${kana}, name_kana),
          manager                 = COALESCE(${operator}, manager),
          type                    = COALESCE(${typeLabel}, type),
          height_m                = COALESCE(${heightM}, height_m),
          total_capacity_m3       = COALESCE(${capacityM3}, total_capacity_m3),
          active_capacity_m3      = COALESCE(${activeCapacityM3}, active_capacity_m3),
          completed_year          = COALESCE(${completed}, completed_year),
          construction_start_year = COALESCE(${constructionStart}, construction_start_year),
          purposes                = COALESCE(${purposes}, purposes),
          crest_length_m          = COALESCE(${crestLengthM}, crest_length_m),
          embankment_volume_m3    = COALESCE(${embankmentVolumeM3}, embankment_volume_m3),
          watershed_area_km2      = COALESCE(${watershedAreaKm2}, watershed_area_km2),
          reservoir_area_km2      = COALESCE(${reservoirAreaKm2}, reservoir_area_km2),
          left_bank_location      = COALESCE(${leftBankLocation}, left_bank_location),
          main_contractor         = COALESCE(${mainContractor}, main_contractor),
          redevelopment_status    = COALESCE(${redevelopmentStatus}, redevelopment_status)
        WHERE id = ${target.id}
      `;
      attrUpdated++;
    }

    // 3. If slug is the placeholder (dam-NNNN-PP) and we now have kana, repair it.
    if (target.slug.startsWith('dam-') && kana) {
      const base = toSlug(kana) || target.slug.replace(/^dam-/, '').split('-')[0];
      const candidate = `${base}-${prefCode}`;
      const newSlug = suffixedSlug(candidate, allSlugs);
      if (newSlug !== target.slug) {
        allSlugs.delete(target.slug);
        allSlugs.add(newSlug);
        await sql`UPDATE dams SET slug = ${newSlug} WHERE id = ${target.id}`;
        slugUpdated++;
      }
    }
  }

  console.log(
    JSON.stringify({
      captures: captures.length,
      matched,
      skippedNoPref,
      skippedNotFound,
      attached,
      attrUpdated,
      slugUpdated,
    }),
  );
}

main()
  .catch((e) => {
    console.error(e);
    process.exitCode = 1;
  })
  .finally(() => sql.end({ timeout: 5 }));
