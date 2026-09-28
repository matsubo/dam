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

import { type BindableMaster, preferMaster, stampedMaster, twinOf } from '@dam/core/dam_binding';
import { sql } from '@dam/db/client';
import { bindExternalId } from '@dam/db/repo/dams';
import type { UniverseRow } from '@dam/db/repo/source_universe';

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

// --- binding ----------------------------------------------------------------

/**
 * The master row for a facility among same-prefecture candidates whose name,
 * less any （元）/（再）, is the facility's full name or its stem ("牧尾ダム"
 * → "牧尾"). The row stamped with the key keeps it; else the full name beats
 * the stem, twins of one dam go to the live one, and two different dams at
 * the best rank bind to neither.
 */
export function chooseFacilityMaster<M extends BindableMaster>(
  key: string,
  candidates: M[],
): M | null {
  const stamped = stampedMaster(candidates, key);
  if (stamped) return stamped;
  const exact = candidates.filter((m) => (twinOf(m.name)?.base ?? m.name) === key);
  const [a, b, ...more] = exact.length > 0 ? exact : candidates;
  if (!a) return null;
  if (!b) return a;
  const ta = twinOf(a.name);
  const tb = twinOf(b.name);
  // Two rows are one dam only as its （元） and （再）.
  if (more.length > 0 || !ta || !tb || ta.base !== tb.base || ta.marker === tb.marker) return null;
  return preferMaster(a, b) ? a : b;
}

/**
 * Bind each listed facility whose prefecture is known to its master dam and
 * stamp it; return the bindings and the universe rows for the whole list. A
 * facility missing from `prefByName` (new on the map) is recorded unresolved.
 */
export async function matchFacilities(
  sourceId: string,
  facilities: RealtimeFacility[],
  prefByName: Readonly<Record<string, string>>,
  log: (s: string) => void,
): Promise<{ damByName: Map<string, bigint>; universe: UniverseRow[] }> {
  const damByName = new Map<string, bigint>();
  const universe: UniverseRow[] = [];
  for (const f of facilities) {
    const prefCode = prefByName[f.name] ?? null;
    const hasData = Object.values(f.values).some((v) => v !== null) ? true : null;
    let damId: bigint | null = null;
    if (prefCode === null) {
      log(`${sourceId}: "${f.name}" is new on the map; add its prefecture to bind it`);
    } else {
      const candidates = await sql<BindableMaster[]>`
        SELECT id, name, completed_year AS "completedYear",
               external_ids->>${sourceId} AS stamp
        FROM dams
        WHERE pref_code = ${prefCode}
          AND (external_ids->>${sourceId} = ${f.name}
               OR regexp_replace(name, '[（(](元|再)[）)]$', '')
                  IN (${f.name}, ${f.name.replace(/(ダム|貯水池)$/, '')}))
        ORDER BY id
      `;
      damId = chooseFacilityMaster(f.name, candidates)?.id ?? null;
      if (damId === null) log(`${sourceId}: no single master dam for "${f.name}"`);
    }
    universe.push({ externalId: f.name, name: f.name, prefCode, resolvedDamId: damId, hasData });
    if (damId === null) continue;
    damByName.set(f.name, damId);
    await bindExternalId(damId, sourceId, f.name);
  }
  return { damByName, universe };
}
