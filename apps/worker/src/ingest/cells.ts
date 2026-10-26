// The flag rule in one place (plan §2): an entry with any value has values;
// one whose every field the provider marks (欠測, 調整中, "*", "---") is
// provider-marked empty; anything else is unreadable, because a cell we
// could not parse may be our own breakage.

/** A field the provider itself marks as carrying no value. */
export const MARKED: unique symbol = Symbol('provider-marked');

/** One field of an entry: a value, the provider's mark, or nothing we could read. */
export type Cell = number | typeof MARKED | null;

/** `value` when it is a finite number and not marked, MARKED when marked, else null. */
export function cell(value: number | null | undefined, marked: boolean): Cell {
  if (marked) return MARKED;
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

/** The number in a cell, or null. */
export function numberIn(c: Cell): number | null {
  return typeof c === 'number' ? c : null;
}

export function cellState(cells: readonly Cell[]): 'values' | 'empty' | 'unreadable' {
  if (cells.some((c) => typeof c === 'number')) return 'values';
  if (cells.length > 0 && cells.every((c) => c === MARKED)) return 'empty';
  return 'unreadable';
}
