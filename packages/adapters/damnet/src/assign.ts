// packages/adapters/damnet/src/assign.ts
//
// Pure rules deciding which ダム便覧 record belongs to which master row. No
// I/O, so the rules can be tested against the collisions reported in #54.
//
// ダム便覧 registers a redeveloped dam twice, as 〇〇ダム（元） and 〇〇ダム（再）,
// exactly like NDI does. The marker is therefore part of the key: stripping
// it (as the matcher did until #54) collapsed both records onto both rows and
// let whichever was processed last win, swapping 17 pairs.
//
// Within a key:
//   1 master × 1 record  → bind, replacing whatever stamp the master holds.
//   more than one either side (true namesakes: 芦別×2 in 北海道) → names cannot
//     tell them apart, so an existing stamp that points into the group is
//     kept; if exactly one master and one record are left over they bind; any
//     other remainder is reported as ambiguous and left alone.
//
// 参考掲載 records (dam_number `S…`) are a different structure that happens to
// share the name (S003 湯西川 is a 12.5 m 1960 dam, not the 119 m MLIT one),
// so they are never assigned.

import { PREFECTURES } from '@dam/core/prefectures';

export interface MasterRef {
  id: string;
  name: string;
  prefCode: string;
  damnet: string | null;
}

export interface CaptureRef {
  damNumber: string;
  name: string;
  prefecture: string;
}

export interface Assignment<C extends CaptureRef> {
  masterId: string;
  capture: C;
}

export interface AmbiguousGroup {
  key: string;
  masterIds: string[];
  damNumbers: string[];
}

const PREF_CODE_BY_NAME = new Map(PREFECTURES.map((p) => [p.name, p.code]));

/** `base|marker`, e.g. 千五沢ダム（元） → `千五沢|元`, 道志ダム → `道志|`. */
export function damnetNameKey(name: string): string {
  const folded = name.normalize('NFKC').replace(/\s+/gu, '').toLowerCase();
  const m = /^(.*?)(?:\(([^()]*)\))?$/u.exec(folded);
  const base = (m?.[1] ?? folded).replace(/(?:ダム|貯水池|池)$/u, '');
  return `${base}|${m?.[2] ?? ''}`;
}

function groupBy<T>(items: T[], keyOf: (t: T) => string | null): Map<string, T[]> {
  const out = new Map<string, T[]>();
  for (const item of items) {
    const key = keyOf(item);
    if (key === null) continue;
    out.set(key, [...(out.get(key) ?? []), item]);
  }
  return out;
}

export function assignCaptures<C extends CaptureRef>(
  masters: MasterRef[],
  captures: C[],
): { assignments: Assignment<C>[]; ambiguous: AmbiguousGroup[] } {
  const mastersByKey = groupBy(masters, (m) => `${m.prefCode}|${damnetNameKey(m.name)}`);
  const capturesByKey = groupBy(
    captures.filter((c) => !c.damNumber.startsWith('S')),
    (c) => {
      const pref = PREF_CODE_BY_NAME.get(c.prefecture);
      return pref ? `${pref}|${damnetNameKey(c.name)}` : null;
    },
  );

  const assignments: Assignment<C>[] = [];
  const ambiguous: AmbiguousGroup[] = [];
  for (const [key, group] of capturesByKey) {
    const ms = mastersByKey.get(key) ?? [];
    const [onlyMaster] = ms;
    const [onlyCapture] = group;
    if (ms.length === 1 && group.length === 1 && onlyMaster && onlyCapture) {
      assignments.push({ masterId: onlyMaster.id, capture: onlyCapture });
      continue;
    }
    const byNumber = new Map(group.map((c) => [c.damNumber, c]));
    const kept: MasterRef[] = [];
    for (const m of ms) {
      const c = m.damnet === null ? undefined : byNumber.get(m.damnet);
      if (!c) continue;
      kept.push(m);
      assignments.push({ masterId: m.id, capture: c });
    }
    const keptNumbers = new Set(kept.map((m) => m.damnet));
    const restMasters = ms.filter((m) => !kept.includes(m));
    const restCaptures = group.filter((c) => !keptNumbers.has(c.damNumber));
    const [restMaster] = restMasters;
    const [restCapture] = restCaptures;
    if (restMasters.length === 1 && restCaptures.length === 1 && restMaster && restCapture) {
      assignments.push({ masterId: restMaster.id, capture: restCapture });
    } else if (restMasters.length > 0 && restCaptures.length > 0) {
      ambiguous.push({
        key,
        masterIds: restMasters.map((m) => m.id),
        damNumbers: restCaptures.map((c) => c.damNumber),
      });
    }
  }
  return { assignments, ambiguous };
}
