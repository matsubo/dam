// apps/worker/src/tasks/ingest_mc_tottori_hydro.ts
//
// M&C鳥取水力発電 発電所・ダム運転情報 — the 4 dams on 鳥取県's hydro scheme.
//
//   茗荷谷ダム / 三朝調整池 / 中津ダム (県営発電専用; no other live source) and
//   菅沢ダム (国交省管理の多目的ダム; grouped on the page with 日野川第一発電所)
//
// M&C鳥取水力発電 holds the 運営権 (concession) for 鳥取県's hydro plants, so
// this page is the operator's own live feed.
//
// Source:
//   https://mchp-k.co.jp/business/list.php (UTF-8 HTML, no session; robots.txt
//   disallows only two archived 2023 pages)
//
// Each station is a `<div id="myModal…" class="reveal-modal">` whose <h1> is
// the name and whose table is label/value rows: 年月日 "YYYY/MM/DD", 時刻
// "HH:MM" (JST; one current value, refreshed every minute). Dam blocks carry
// ダム水位 or 調整池水位; 発電所 blocks (出力 / 使用水量) are skipped.
//
// Stored per dam:
//   inflow  ← 10分間流入量 (m³/s)
//   outflow ← ゲート放流量 (m³/s) — the release to the river below the dam.
//             Water taken into the headrace appears only as the downstream
//             plant's 使用水量 and is not added in. 三朝調整池 publishes no
//             release (制水門流入量 is an intake) → NULL.
// Not stored: ダム水位 / 調整池水位 are gauge heights, not EL — 菅沢 read
// 3.28 m at 21:39 JST 2026-09-27 while tottori-bousai / cgr-mlit-dam had it at
// EL 356.37 m — so they would sit on a different datum from every other
// source's water_level_m. The same page's 菅沢 ゲート放流量 (0.12) matched both
// sources' 全放流量 (0.12), which is what makes it the stored outflow. No
// volume or rate is published.
//
// Priority 301 — the lowest real-time tier. 菅沢 is also covered by
// tottori-bousai (312), kasenbosai (310), tottori-dam (307) and cgr-mlit-dam
// (304), all of which publish EL level and volume; this source must never
// outrank them there. The other three dams have no other live source.
// Cron hourly at :32.

import { cellState } from '../ingest/cells.ts';
import { ingestTask } from '../ingest/run.ts';
import type { Entry, Reading } from '../ingest/types.ts';

const DATA_URL = process.env.MC_TOTTORI_HYDRO_URL ?? 'https://mchp-k.co.jp/business/list.php';

const PREF_CODE = '31';
const SOURCE_ID = 'mc-tottori-hydro';

// --- parsing ----------------------------------------------------------------

export interface ParsedRow {
  /** <h1> name as published ("中津ダム"); also the stamp and universe key. */
  name: string;
  observedAt: Date | null;
  inflowM3s: number | null;
  outflowM3s: number | null;
}

function cellText(html: string): string {
  return html
    .replace(/<[^>]*>/g, '')
    .replace(/&[a-z]+;/g, '')
    .trim();
}

/**
 * Every dam block on the page, whatever it currently reports: a station with
 * no parsable time still belongs to the published universe.
 */
export function parseMcTottoriHydro(html: string): ParsedRow[] {
  const rows: ParsedRow[] = [];
  const blocks = html.split(/<div id="myModal[^"]*" class="reveal-modal">/).slice(1);
  for (const block of blocks) {
    const name = cellText(block.match(/<h1>([\s\S]*?)<\/h1>/)?.[1] ?? '');
    const values = new Map<string, string>();
    for (const tr of block.matchAll(
      /<td class="th">([\s\S]*?)<\/td>\s*<td[^>]*>([\s\S]*?)<\/td>/g,
    )) {
      values.set(cellText(tr[1] ?? ''), cellText(tr[2] ?? ''));
    }
    if (!name || !(values.has('ダム水位(m)') || values.has('調整池水位(m)'))) continue;

    const num = (label: string): number | null => {
      const text = values.get(label) ?? '';
      const n = Number(text);
      return text !== '' && Number.isFinite(n) ? n : null;
    };
    const d = (values.get('年月日') ?? '').match(/^(\d{4})\/(\d{1,2})\/(\d{1,2})$/);
    const t = (values.get('時刻') ?? '').match(/^(\d{1,2}):(\d{2})$/);
    rows.push({
      name,
      observedAt:
        d && t
          ? new Date(
              Date.UTC(
                Number(d[1]),
                Number(d[2]) - 1,
                Number(d[3]),
                Number(t[1]) - 9,
                Number(t[2]),
              ),
            )
          : null,
      inflowM3s: num('10分間流入量(m3/s)'),
      outflowM3s: num('ゲート放流量(m3/s)'),
    });
  }
  return rows;
}

// --- entries ----------------------------------------------------------------

export function mcTottoriReading(r: ParsedRow): Reading {
  if (cellState([r.inflowM3s, r.outflowM3s]) !== 'values') {
    return { state: 'unreadable', why: 'no inflow or release' };
  }
  if (!r.observedAt) return { state: 'unreadable', why: 'no 年月日 / 時刻' };
  return {
    state: 'values',
    observations: [{ observedAt: r.observedAt, inflowM3s: r.inflowM3s, outflowM3s: r.outflowM3s }],
  };
}

/**
 * Every dam block, keyed by its <h1>. Only exact stems bind ("中津ダム" /
 * "三朝調整池" → 中津 / 三朝) — the names are short enough that a prefix or
 * substring hit (中津 → 中津川) would be a different dam.
 */
export function mcTottoriEntries(html: string): Entry[] {
  return parseMcTottoriHydro(html).map((r) => ({
    key: r.name,
    name: r.name,
    pref: PREF_CODE,
    bind: { name: r.name.replace(/調整池$/, ''), exact: true },
    reading: mcTottoriReading(r),
  }));
}

// --- task -------------------------------------------------------------------

export default ingestTask(SOURCE_ID, async ({ log, upstream }) => {
  // No dam block on the page lists nothing, and the run fails the job.
  const entries = mcTottoriEntries((await upstream.fetch(DATA_URL)).text());
  log(`${SOURCE_ID}: ${entries.length} dams`);
  return { entries };
});
