// apps/worker/src/tasks/ingest_ktr_kinu.ts
//
// Eleventh real-observation source. 国土交通省 関東地方整備局 鬼怒川ダム
// 統合管理事務所 publishes a realtime dashboard for its 4 国管理 dams
// (栃木県): 五十里 / 川俣 / 川治 / 湯西川.
//
//   https://www.ktr.mlit.go.jp/kinudamu/daminfo/jp/realDM.html
//
// Data is embedded inline as JavaScript variables in the HTML:
//
//   KansokuT = ['YYYY-MM-DD-HH-MM', ...4 items];
//   DamVal = [
//     [[validFlag, raw_int, displayStr, prevValid, prevRaw, dataNo], ... 7 rows],
//     ... 4 dams
//   ];
//
// Per-dam row mapping (DamVal[s][n]):
//   [s][0]: 貯水位 (m)        — divide displayStr by 1
//   [s][1]: 全流入量 (m³/s)
//   [s][2]: 調整流量 (m³/s)
//   [s][3]: ダム放流量 (m³/s)
//   [s][4]: 全放流量 (m³/s)   — preferred for outflow
//   [s][5]: 発電使用水量
//   [s][6]: 累加雨量 (mm)
//
// validFlag 0 is the page's own "no value" for that item (displayStr is then
// ''); a dam with it on every stored item is provider-marked empty. The four
// dams are known in advance, so a failed fetch leaves all four unreadable
// rather than unlisted.

import { type Cell, cellState, MARKED, numberIn } from '../ingest/cells.ts';
import { ingestTask } from '../ingest/run.ts';
import type { Entry, Reading } from '../ingest/types.ts';
import type { Upstream } from '../ingest/upstream.ts';

const PAGE_URL =
  process.env.KTR_KINU_DAM_URL ?? 'https://www.ktr.mlit.go.jp/kinudamu/daminfo/jp/realDM.html';

interface DamCfg {
  /** Index into KansokuT / DamVal (0..3). */
  idx: number;
  /** Slug used in DamTbl (`ikari`, `kawamata`, `kawaji`, `yunishigawa`). */
  slug: string;
  pageName: string;
}

const DAMS: DamCfg[] = [
  { idx: 0, slug: 'ikari', pageName: '五十里ダム' },
  { idx: 1, slug: 'kawamata', pageName: '川俣ダム' },
  { idx: 2, slug: 'kawaji', pageName: '川治ダム' },
  { idx: 3, slug: 'yunishigawa', pageName: '湯西川ダム' },
];

const PREF_CODE = '09';
const SOURCE_ID = 'ktr-kinu-dam';

/** One DamVal item `[validFlag, raw_int, displayStr, …]`. */
function itemCell(cols: readonly string[] | undefined): Cell {
  if (!cols) return null;
  if (cols[0] === '0') return MARKED;
  const t = (cols[2] ?? '').replace(/[,\s　]/g, '');
  if (!t || t === '-' || t === '−' || t === '欠測') return null;
  const n = Number(t);
  return Number.isFinite(n) ? n : null;
}

/** Parse "2026-05-18-14-50" (JST) → UTC Date. */
export function parseKinuTimestamp(raw: string): Date | null {
  const m = raw.match(/(\d{4})-(\d{2})-(\d{2})-(\d{2})-(\d{2})/);
  if (!m) return null;
  return new Date(
    Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3]), Number(m[4]) - 9, Number(m[5]), 0, 0),
  );
}

/** The bracketed groups at the top level of `body`, without their brackets. */
function topLevelGroups(body: string): string[] {
  const groups: string[] = [];
  let depth = 0;
  let start = -1;
  for (let i = 0; i < body.length; i++) {
    const ch = body[i];
    if (ch === '[') {
      if (depth === 0) start = i + 1;
      depth++;
    } else if (ch === ']') {
      depth--;
      if (depth === 0 && start >= 0) {
        groups.push(body.slice(start, i));
        start = -1;
      }
    }
  }
  return groups;
}

/**
 * Extract `KansokuT` and `DamVal` arrays from the inline JS in realDM.html.
 * Returns one Reading per configured dam, in order.
 */
export function kinuReadings(html: string): Reading[] {
  // KansokuT block:  KansokuT = [ 'YYYY-...', 'YYYY-...', ... ];
  const ksMatch = html.match(/KansokuT\s*=\s*\[([\s\S]*?)\];/);
  // DamVal block: capture the full outer-array body including its closing `]`.
  // Pattern: starts at `DamVal = [`, ends at the OUTER `];`. Inside, every
  // `]` matches an earlier `[` so the non-greedy capture must end at the
  // outermost closing. We capture between the opening `[` and the final
  // `]` (exclusive of the trailing `;`).
  const dvOuter = html.match(/DamVal\s*=\s*(\[[\s\S]*?\]\s*\]);/);
  if (!ksMatch || !dvOuter) {
    return DAMS.map(() => ({ state: 'unreadable', why: 'no KansokuT / DamVal on the page' }));
  }
  const tsRaw = [...(ksMatch[1] ?? '').matchAll(/'([\d-]+)'/g)].map((m) => m[1] ?? '');
  // Strip the outer `[ ... ]` to get the body containing the 4 sub-arrays,
  // then split each dam's sub-array into its 7 items.
  const dvBody = (dvOuter[1] ?? '').replace(/^\s*\[/, '').replace(/\]\s*$/, '');
  const itemsPerDam = topLevelGroups(dvBody).map((s) =>
    topLevelGroups(s).map((r) => r.split(',').map((c) => c.trim().replace(/^['"]|['"]$/g, ''))),
  );
  return DAMS.map((c): Reading => {
    const observedAt = parseKinuTimestamp(tsRaw[c.idx] ?? '');
    const items = itemsPerDam[c.idx];
    if (!observedAt) return { state: 'unreadable', why: `KansokuT[${c.idx}] "${tsRaw[c.idx]}"` };
    if (!items) return { state: 'unreadable', why: `no DamVal[${c.idx}]` };
    const level = itemCell(items[0]);
    const inflow = itemCell(items[1]);
    const total = itemCell(items[4]);
    const outflow = typeof total === 'number' ? total : (itemCell(items[3]) ?? total);
    const rain = itemCell(items[6]);
    const state = cellState([level, inflow, outflow]);
    if (state === 'empty') return { state, mark: 'validFlag 0 on every item' };
    if (state === 'unreadable') return { state, why: 'no numeric item' };
    return {
      state: 'values',
      observations: [
        {
          observedAt,
          waterLevelM: numberIn(level),
          inflowM3s: numberIn(inflow),
          outflowM3s: numberIn(outflow),
          rainfallMm: numberIn(rain),
        },
      ],
    };
  });
}

/** The four dams; with no page (a failed fetch) each is unreadable with the reason. */
export function kinuEntries(page: { html: string } | { error: string }): Entry[] {
  const readings =
    'html' in page
      ? kinuReadings(page.html)
      : DAMS.map((): Reading => ({ state: 'unreadable', why: page.error }));
  return DAMS.map((c) => ({
    key: c.slug,
    name: c.pageName,
    pref: PREF_CODE,
    reading: readings[c.idx] ?? { state: 'unreadable', why: 'not parsed' },
  }));
}

async function fetchPage(upstream: Upstream): Promise<{ html: string } | { error: string }> {
  try {
    return { html: (await upstream.fetch(PAGE_URL, { timeoutMs: 12_000 })).text() };
  } catch (err) {
    return { error: err instanceof Error ? err.message : String(err) };
  }
}

export default ingestTask(SOURCE_ID, async ({ upstream }) => ({
  entries: kinuEntries(await fetchPage(upstream)),
}));
