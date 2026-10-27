// apps/worker/src/tasks/jwa_chubu_realtime.ts
//
// Shared by jwa-kiso-rt (index.html, 木曽川水系) and jwa-toyokawa (index_2.html,
// 豊川水系): the overview maps of 水資源機構 中部支社 リアルタイム情報
// (water.go.jp/mizu/chubu/realtime/). Each facility on a map is a mini-list
// block, <h4>NAME</h4> followed by its own <table> of
// <th>LABEL</th><td class="data">VALUE<span class="unit">…</span></td> rows,
// and the page carries one 観測時刻 (JST) for all of them. The unit sits in
// markup right after the value (`18158<span class="unit">10<sup>3</sup>m<sup>3
// </sup></span>`), so a value is the text up to the cell's first tag: stripping
// the tags would read "18158103m3". "cc" marks a communication cut.
//
// Parsing returns every block with every label it prints, so each task can
// record the map's whole list and pick the quantities it stores.

import type { Entry, Observed } from '../ingest/types.ts';

export interface RealtimeFacility {
  /** The <h4> text ("中里貯水池"); also the stamp and universe key. */
  name: string;
  /** Label → value in the unit the page prints; null for "cc" or an empty cell. */
  values: Record<string, number | null>;
}

function parseNum(s: string): number | null {
  const cleaned = s.replace(/[,\s　]/g, '');
  if (!cleaned || cleaned === 'cc' || /^[-―—]$/.test(cleaned)) return null;
  const n = Number(cleaned);
  return Number.isFinite(n) ? n : null;
}

/** "観測時刻：YYYY年MM月DD日 HH時MM分" (JST) → UTC. */
export function parseJwaChubuTimestamp(text: string): Date | null {
  const m = text.match(/(\d{4})年(\d{2})月(\d{2})日\s+(\d{1,2})時(\d{2})分/);
  if (!m) return null;
  const d = new Date(
    Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3]), Number(m[4]) - 9, Number(m[5])),
  );
  return Number.isNaN(d.getTime()) ? null : d;
}

export function parseJwaChubuRealtime(html: string): {
  observedAt: Date | null;
  facilities: RealtimeFacility[];
} {
  const facilities: RealtimeFacility[] = [];
  // A block ends at its own </table>: the labels repeat in the next block, so
  // reading past it would lend one facility's value to another.
  for (const block of html.matchAll(/<h4>([^<]+)<\/h4>([\s\S]*?)<\/table>/g)) {
    const name = (block[1] ?? '').trim();
    if (!name) continue;
    const values: Record<string, number | null> = {};
    for (const row of (block[2] ?? '').matchAll(
      /<th>([^<]+)<\/th>\s*<td[^>]*class="data"[^>]*>([^<]*)/g,
    )) {
      values[(row[1] ?? '').trim()] = parseNum(row[2] ?? '');
    }
    facilities.push({ name, values });
  }
  return { observedAt: parseJwaChubuTimestamp(html), facilities };
}

/** The quantities a task stores from one facility's printed values. */
export type StoredQuantities = (
  values: Readonly<Record<string, number | null>>,
) => Omit<Observed, 'observedAt'>;

/**
 * One entry per facility on the map, keyed by its <h4> name (the stamp). The
 * prefecture comes from the task's list of the map; a facility new on the
 * map has none, so only an existing stamp can bind it. Names match by
 * equality only, never by prefix or contains: the name, its stem without
 * ダム ("牧尾ダム" → "牧尾"), or the name less 貯水池 ("中里貯水池" → master
 * "中里"). A facility printing none of the stored quantities ("cc" or blank
 * in every cell) is unreadable.
 */
export function facilityEntries(
  facilities: readonly RealtimeFacility[],
  observedAt: Date,
  prefByName: Readonly<Record<string, string>>,
  stored: StoredQuantities,
): Entry[] {
  return facilities.map((f) => {
    const quantities = stored(f.values);
    const printed = Object.values(quantities).some((v) => v != null);
    return {
      key: f.name,
      name: f.name,
      pref: prefByName[f.name] ?? null,
      bind: f.name.endsWith('貯水池')
        ? { name: f.name.replace(/貯水池$/, ''), exact: true }
        : { exact: true },
      reading: printed
        ? { state: 'values', observations: [{ observedAt, ...quantities }] }
        : { state: 'unreadable', why: 'no stored quantity printed ("cc" or blank)' },
    };
  });
}
