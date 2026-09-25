// packages/core/src/dam_binding.ts
//
// Shared rules for binding an upstream station to a master dam row (#57).
// Ingest tasks rank candidates by name themselves; these decide what name
// matching cannot:
//
// - A row already stamped with the station (external_ids->>'<source>')
//   keeps it. Names cannot tell same-name dams apart (兵庫 has two 長谷), so
//   once a stamp is right it must not be re-decided by name every run.
// - A redeveloped dam has a （元） and a （再） row whose names reduce to the
//   same stem. The live structure is the （再） once it is completed; while it
//   is still being built (佐久間（再） has no completion year) it is the （元）.
//   Lowest id picked either at random.

export interface BindableMaster {
  id: bigint;
  name: string;
  completedYear?: number | null;
  /** This row's external_ids->>'<source>' for the source being bound. */
  stamp?: string | null;
}

const TWIN = /^(.*)\((元|再)\)$/u;

export function twinOf(name: string): { base: string; marker: '元' | '再' } | null {
  const m = TWIN.exec(name.normalize('NFKC').trim());
  if (!m?.[1]) return null;
  return { base: m[1], marker: m[2] as '元' | '再' };
}

/** True when `a` should replace `b` as the best match at the same name rank. */
export function preferMaster(
  a: BindableMaster,
  b: BindableMaster,
  year = new Date().getFullYear(),
): boolean {
  const ta = twinOf(a.name);
  const tb = twinOf(b.name);
  if (ta && tb && ta.base === tb.base && ta.marker !== tb.marker) {
    const sai = ta.marker === '再' ? a : b;
    const saiCurrent = sai.completedYear != null && sai.completedYear <= year;
    return ta.marker === (saiCurrent ? '再' : '元');
  }
  return a.id < b.id;
}

/** The single row already stamped with `key`, if exactly one is. */
export function stampedMaster<M extends BindableMaster>(masters: M[], key: string): M | null {
  const hits = masters.filter((m) => m.stamp === key);
  return hits.length === 1 ? (hits[0] ?? null) : null;
}
