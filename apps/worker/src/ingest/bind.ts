// Binding a universe entry to its master dam: pure, so the run suite can
// test every rung without a database.
//
// Order: an NDI pin, then the one row in scope already stamped with the
// entry's key (#57: a stamp, once right, is never re-decided by name), then
// the name ladder inside the entry's prefecture scope:
//   exact published name → same stem → stem + ダム → prefix → contains
// The stem drops （…）/(…) annotations and a trailing ダム, after NFKC and the
// kanji variant folds. At the best rung, one candidate wins; a （元）/（再）
// pair goes to the live twin (preferMaster); any other tie leaves the entry
// unbound (Q32) rather than picking the lowest id.

import { type BindableMaster, preferMaster, twinOf } from '@dam/core/dam_binding';
import type { Bind } from './types.ts';

export interface Master extends BindableMaster {
  prefCode: string | null;
  ndi: string | null;
  totalCapacityM3: number | null;
  activeCapacityM3: number | null;
}

/** Codepoint variants of one kanji (and ordinal spellings), folded so the feed and the master compare equal. */
const VARIANTS: readonly (readonly [RegExp, string])[] = [
  [/槇/g, '槙'],
  // iwate-kasen prints 「遠野第二ダム」 where ダム便覧 has 「遠野第2」.
  [/第二/g, '第2'],
];

export function stemOf(name: string): string {
  let s = name.normalize('NFKC').replace(/[（(][^）)]*[）)]/g, '');
  for (const [from, to] of VARIANTS) s = s.replace(from, to);
  return s.trim().replace(/ダム$/, '').trim();
}

export type Binding =
  | { readonly dam: Master; readonly by: 'pin' | 'stamp' | 'name' }
  | { readonly dam: null; readonly why: string };

export interface BindTarget {
  readonly key: string;
  readonly name: string;
  readonly pref: string | readonly string[] | null;
  readonly bind?: Bind;
}

function inScope(m: Master, pref: string | readonly string[] | null): boolean {
  if (pref === null) return true;
  return typeof pref === 'string' ? m.prefCode === pref : pref.includes(m.prefCode ?? '');
}

/**
 * `notDam`: the key carries a not_dam_reason (a weir, a combined row), so
 * only a pin or an existing stamp may bind it (Q35).
 */
export function bindEntry(
  target: BindTarget,
  masters: readonly Master[],
  notDam: boolean,
  year = new Date().getFullYear(),
): Binding {
  const bind = target.bind;
  if (bind === 'never') return { dam: null, why: 'not one master dam' };
  if (bind && 'ndi' in bind) {
    const pinned = masters.find((m) => m.ndi === bind.ndi);
    return pinned
      ? { dam: pinned, by: 'pin' }
      : { dam: null, why: `no master with NDI ${bind.ndi}` };
  }
  const scoped = masters.filter((m) => inScope(m, target.pref));
  const stamped = scoped.filter((m) => m.stamp === target.key);
  if (stamped.length === 1 && stamped[0]) return { dam: stamped[0], by: 'stamp' };
  if (notDam) return { dam: null, why: 'not_dam_reason set' };
  if (target.pref === null) return { dam: null, why: 'no prefecture to search' };

  const name = bind?.name ?? target.name;
  const stem = stemOf(name);
  if (!stem) return { dam: null, why: 'empty name' };
  const lastRung = bind?.exact ? 2 : 4;
  let best: Master[] = [];
  let bestRung = Number.POSITIVE_INFINITY;
  for (const m of scoped) {
    const mStem = stemOf(m.name);
    let rung: number;
    if (m.name.normalize('NFKC') === name.normalize('NFKC')) rung = 0;
    else if (mStem === stem) rung = 1;
    else if (m.name.normalize('NFKC') === `${stem}ダム`) rung = 2;
    else if (mStem.startsWith(stem)) rung = 3;
    else if (mStem.includes(stem)) rung = 4;
    else continue;
    if (rung > lastRung) continue;
    if (rung < bestRung) {
      best = [m];
      bestRung = rung;
    } else if (rung === bestRung) {
      best.push(m);
    }
  }
  if (best.length === 0) return { dam: null, why: `no master named like ${name}` };
  if (best.length === 1 && best[0]) return { dam: best[0], by: 'name' };
  const bases = new Set(best.map((m) => twinOf(m.name)?.base ?? `#${m.id}`));
  if (bases.size === 1) {
    const live = best.reduce((a, b) => (preferMaster(b, a, year) ? b : a));
    return { dam: live, by: 'name' };
  }
  return {
    dam: null,
    why: `ambiguous: ${best.map((m) => `${m.name}#${m.id}`).join(', ')}`,
  };
}
