// apps/worker/src/tasks/ingest_gifu_kasen.ts
//
// 岐阜県 川の防災情報 ダム諸量 — 14 ダム, hourly.
//
//   14 dams: 阿多岐/大ヶ洞/岩村/中野方/丹生川/矢作/小里川/横山/徳山/丸山/
//            阿木川/岩屋/牧尾/味噌川
//
// Source:
//   https://www.kasen.pref.gifu.lg.jp/h/Dam.html
// Format: UTF-8 HTML. Single JST timestamp ("YYYY/MM/DD HH:MM現在") for all dams.
//   Each dam in "[ダム名]" section followed by <pre> block with three metrics.
//   "***" = 欠測 (missing), "---" = 無効 (invalid): the page's own marks.
//   Values: 貯水量 (千m³) / 放流量 (m³/s) / 全流入量 (m³/s).
// Priority 308.

import { type Cell, cell, cellState, MARKED, numberIn } from '../ingest/cells.ts';
import { ingestTask } from '../ingest/run.ts';
import type { Entry, Reading } from '../ingest/types.ts';

const DATA_URL = process.env.GIFU_KASEN_DAM_URL ?? 'https://www.kasen.pref.gifu.lg.jp/h/Dam.html';

const SOURCE_ID = 'gifu-kasen';

// Names alone cross prefectures: ダム便覧 has a 岩村 in 北海道 (lower id) as
// well as this page's 岩村 in 岐阜. Every station here is in 岐阜 except three
// upper-Kiso / Yahagi dams the prefecture also reports, which ダム便覧 files
// under 長野 and 愛知.
const GIFU_PREF = '21';
const PREF_OUTSIDE_GIFU: Record<string, string> = {
  矢作ダム: '23',
  牧尾ダム: '20',
  味噌川ダム: '20',
};

// --- parsing ----------------------------------------------------------------

/** "YYYY/MM/DD HH:MM現在" JST → UTC Date */
export function parseGifuDatetime(s: string): Date | null {
  const m = s.match(/(\d{4})\/(\d{2})\/(\d{2})\s+(\d{2}):(\d{2})現在/);
  if (!m) return null;
  const d = new Date(
    Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3]), Number(m[4]) - 9, Number(m[5]), 0, 0),
  );
  return Number.isNaN(d.getTime()) ? null : d;
}

/** A value: "***" (欠測) and "---" (無効) are the page's marks. */
function valueCell(s: string): Cell {
  const t = s.replace(/&nbsp;/g, '').trim();
  if (t === '***' || t === '---') return MARKED;
  return cell(t ? Number(t) : null, false);
}

/**
 * Every dam section of the page, keyed by its printed name: the page
 * publishes no station id, and the station's prefecture keeps it apart from
 * same-named dams elsewhere.
 */
export function gifuEntries(html: string): Entry[] {
  const tsMatch = html.match(/(\d{4}\/\d{2}\/\d{2}\s+\d{2}:\d{2}現在)/);
  const observedAt = parseGifuDatetime(tsMatch?.[1] ?? '');

  // Each section: [XxxダムYyy] ... 貯水量 ... 放流量 ... 全流入量.
  // The `[^\]<]+ダム` guard excludes the [更新] link bracket at the top of the page.
  const sectionRe =
    /\[([^\]<]+ダム[^\]<]*)\][\s\S]*?貯水量\s+([\S]+)\s+千m3\s*[\r\n]+\s*放流量\s+([\S]+)\s+m3\/s\s*[\r\n]+\s*全流入量\s+([\S]+)\s+m3\/s/g;

  const entries: Entry[] = [];
  const decoded = html.replace(/&nbsp;/g, ' ');
  for (const m of decoded.matchAll(sectionRe)) {
    const name = m[1]?.trim() ?? '';
    if (!name) continue;
    const storage = valueCell(m[2] ?? '');
    const outflow = valueCell(m[3] ?? '');
    const inflow = valueCell(m[4] ?? '');
    entries.push({
      key: name,
      name,
      pref: PREF_OUTSIDE_GIFU[name] ?? GIFU_PREF,
      reading: sectionReading(observedAt, storage, outflow, inflow),
    });
  }
  return entries;
}

function sectionReading(
  observedAt: Date | null,
  storage: Cell,
  outflow: Cell,
  inflow: Cell,
): Reading {
  const state = cellState([storage, outflow, inflow]);
  if (state === 'empty') return { state, mark: '"***" / "---" in every metric' };
  if (state === 'unreadable') return { state, why: 'no numeric metric' };
  if (!observedAt) return { state: 'unreadable', why: 'no "YYYY/MM/DD HH:MM現在" on the page' };
  const thou = numberIn(storage);
  return {
    state,
    observations: [
      {
        observedAt,
        storageVolumeM3: thou !== null ? thou * 1_000 : null,
        outflowM3s: numberIn(outflow),
        inflowM3s: numberIn(inflow),
      },
    ],
  };
}

export default ingestTask(SOURCE_ID, async ({ log, upstream }) => {
  const entries = gifuEntries((await upstream.fetch(DATA_URL)).text());
  log(`${SOURCE_ID}: ${entries.length} dams listed`);
  return { entries };
});
