// packages/adapters/damnet/src/apply_captures.ts
//
// Writes ダム便覧 dam-info records onto the master table: stamps
// external_ids->>'damnet', back-fills attributes and repairs placeholder
// slugs. Shared by the monthly `master:refresh:damnet` task and the
// `apps/web/bin/match_damnet.ts` one-off; which record belongs to which master
// is decided by `assignCaptures`.

import { suffixedSlug, toSlug } from '@dam/core/slug';
import { sql } from '@dam/db/client';
import { assignCaptures } from './assign.ts';

/** One `/wp-json/dmap/dam-info/{post_id}` response (all strings; "" when absent). */
export interface DamInfo {
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
  purposes: string;
  crest_length: string;
  embankment_volume: string;
  watershed_area: string | number;
  reservoir_area: string | number;
  left_bank_location: string;
  main_contractor: string;
  redevelopment_status: string;
}

export interface ApplyStats {
  captures: number;
  assigned: number;
  ambiguous: number;
  restamped: number;
  attrs_updated: number;
  slug_updated: number;
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
  external_ids: Record<string, string> | null;
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

function thousand(v: string | number): number | null {
  const n = num(v);
  return n === null ? null : n * 1_000;
}

async function applyAttributes(damId: bigint, c: DamInfo): Promise<void> {
  // COALESCE(new, existing): a value ダム便覧 has wins; blanks keep what was
  // there. ダム便覧 publishes 総貯水容量 and 有効貯水容量 only — capacity_active
  // is 有効貯水容量, which is why it lands in both effective_capacity_m3 and
  // active_capacity_m3 (the 貯水率 denominator, named for the role).
  const reservoirAreaHa = num(c.reservoir_area);
  await sql`
    UPDATE dams SET
      name_kana               = COALESCE(${c.dam_name_kana || null}, name_kana),
      manager                 = COALESCE(${c.operator || null}, manager),
      type                    = COALESCE(${c.type ? (TYPE_LETTER_TO_LABEL[c.type] ?? c.type) : null}, type),
      height_m                = COALESCE(${num(c.height)}, height_m),
      total_capacity_m3       = COALESCE(${thousand(c.capacity_total)}, total_capacity_m3),
      active_capacity_m3      = COALESCE(${thousand(c.capacity_active)}, active_capacity_m3),
      effective_capacity_m3   = COALESCE(${thousand(c.capacity_active)}, effective_capacity_m3),
      completed_year          = COALESCE(${intish(c.completion_year)}, completed_year),
      construction_start_year = COALESCE(${intish(c.construction_start_year)}, construction_start_year),
      purposes                = COALESCE(${c.purposes || null}, purposes),
      crest_length_m          = COALESCE(${num(c.crest_length)}, crest_length_m),
      embankment_volume_m3    = COALESCE(${thousand(c.embankment_volume)}, embankment_volume_m3),
      watershed_area_km2      = COALESCE(${num(c.watershed_area)}, watershed_area_km2),
      reservoir_area_km2      = COALESCE(${reservoirAreaHa != null ? reservoirAreaHa / 100 : null}, reservoir_area_km2),
      left_bank_location      = COALESCE(${c.left_bank_location || null}, left_bank_location),
      main_contractor         = COALESCE(${c.main_contractor || null}, main_contractor),
      redevelopment_status    = COALESCE(${c.redevelopment_status || null}, redevelopment_status)
    WHERE id = ${damId}
  `;
}

/** Placeholder slugs (`dam-NNNN-PP`) get a real one once the kana is known. */
function repairedSlug(target: DamRow, kana: string, allSlugs: Set<string>): string | null {
  if (!target.slug.startsWith('dam-') || !kana) return null;
  const base = toSlug(kana) || target.slug.replace(/^dam-/, '').split('-')[0] || '';
  if (!base) return null;
  const newSlug = suffixedSlug(`${base}-${target.pref_code}`, allSlugs);
  if (newSlug === target.slug) return null;
  allSlugs.delete(target.slug);
  allSlugs.add(newSlug);
  return newSlug;
}

export async function applyDamnetCaptures(
  captures: DamInfo[],
  log: (s: string) => void,
): Promise<ApplyStats> {
  const rows = await sql<DamRow[]>`SELECT id, slug, name, pref_code, external_ids FROM dams`;
  const byId = new Map(rows.map((r) => [r.id.toString(), r]));
  const { assignments, ambiguous } = assignCaptures(
    rows.map((r) => ({
      id: r.id.toString(),
      name: r.name,
      prefCode: r.pref_code,
      damnet: r.external_ids?.damnet ?? null,
    })),
    captures.map((c) => ({ ...c, damNumber: c.dam_number, name: c.dam_name })),
  );
  for (const g of ambiguous) {
    log(
      `damnet: ambiguous ${g.key} masters=${g.masterIds.join(',')} records=${g.damNumbers.join(',')}`,
    );
  }

  // Re-stamp in one transaction: clear every changing master and every
  // current holder of a number that moves, then stamp. Swapping two stamps
  // row by row would trip dams_ext_damnet_uniq halfway through.
  const changes = assignments.filter(
    (a) => byId.get(a.masterId)?.external_ids?.damnet !== a.capture.dam_number,
  );
  if (changes.length > 0) {
    const ids = changes.map((a) => a.masterId);
    const numbers = changes.map((a) => a.capture.dam_number);
    await sql.begin(async (tx) => {
      await tx`
        UPDATE dams SET external_ids = external_ids - 'damnet'
        WHERE id::TEXT = ANY(${ids}::TEXT[]) OR external_ids->>'damnet' = ANY(${numbers}::TEXT[])
      `;
      for (const a of changes) {
        await tx`
          UPDATE dams
          SET external_ids = external_ids || jsonb_build_object('damnet', ${a.capture.dam_number}::text)
          WHERE id = ${a.masterId}
        `;
      }
    });
  }

  const allSlugs = new Set(rows.map((r) => r.slug));
  let slugUpdated = 0;
  let attrsUpdated = 0;
  for (const a of assignments) {
    const target = byId.get(a.masterId);
    if (!target) continue;
    try {
      await applyAttributes(target.id, a.capture);
      attrsUpdated++;
      const newSlug = repairedSlug(target, a.capture.dam_name_kana, allSlugs);
      if (newSlug) {
        await sql`UPDATE dams SET slug = ${newSlug} WHERE id = ${target.id}`;
        slugUpdated++;
      }
    } catch (err) {
      log(
        `damnet: apply failed for ${a.capture.dam_number} → ${target.slug}: ${(err as Error).message}`,
      );
    }
  }

  return {
    captures: captures.length,
    assigned: assignments.length,
    ambiguous: ambiguous.length,
    restamped: changes.length,
    attrs_updated: attrsUpdated,
    slug_updated: slugUpdated,
  };
}
