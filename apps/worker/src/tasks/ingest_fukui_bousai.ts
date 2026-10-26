// apps/worker/src/tasks/ingest_fukui_bousai.ts
//
// 福井県 河川・砂防総合情報システム ダム諸量現況表 — 13 ダム, hourly.
//
//   Prefectural: 永平寺/二ツ屋/浄土寺川/龍ヶ鼻/笹生川/桝谷/広野/河内川/大津呂/開谷/滝波
//   National (KKR-managed, also appear here): 真名川/九頭竜
//
// Source:
//   https://sabo.pref.fukui.lg.jp/bousai/servlet/bousaiweb.servletBousaiTableStatus?dk=4
// Format: Shift_JIS HTML. Single GET, no session. Standard 防災Web table.
// Columns per dam row:
//   局名 | 所在地 | 最新観測時刻 | 貯水率(利水容量)[%] | 貯水位[m] |
//   有効貯水量[10³m³] | 流入量[m³/s] | 放流量[m³/s] | 管理者名
// Timestamp per dam: "YYYY&nbsp;MM/DD&nbsp;HH:MM" JST.
// Missing: "---" or "&nbsp;" — the page's own blank; a dam blank in every
// value column (滝波) is provider-marked empty. Storage in 10³m³ (千m³).
// Priority 308. Upgrades kkr-mlit-dam (priority 302, daily) for 真名川/九頭竜.

import { type Cell, cell, cellState, MARKED, numberIn } from '../ingest/cells.ts';
import { ingestTask } from '../ingest/run.ts';
import type { Entry, Reading } from '../ingest/types.ts';

const DATA_URL =
  process.env.FUKUI_BOUSAI_DAM_URL ??
  'https://sabo.pref.fukui.lg.jp/bousai/servlet/bousaiweb.servletBousaiTableStatus?dk=4';

const PREF_CODE = '18';
const SOURCE_ID = 'fukui-bousai';

// --- parsing ----------------------------------------------------------------

/** "YYYY&nbsp;MM/DD&nbsp;HH:MM" or "YYYY MM/DD HH:MM" JST → UTC Date */
export function parseFukuiTimestamp(s: string): Date | null {
  const clean = s.replace(/&nbsp;/g, ' ').trim();
  const m = clean.match(/(\d{4})\s+(\d{2})\/(\d{2})\s+(\d{2}):(\d{2})/);
  if (!m) return null;
  const d = new Date(
    Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3]), Number(m[4]) - 9, Number(m[5]), 0),
  );
  return Number.isNaN(d.getTime()) ? null : d;
}

/** A value cell the page leaves empty: "---" or nothing but entities. */
function isBlank(s: string): boolean {
  const clean = s.replace(/&[a-z]+;/g, '').trim();
  return clean === '---' || clean === '';
}

/** A value cell: "---" or blank is the page's mark, else the number after the arrows. */
function valueCell(s: string): Cell {
  if (isBlank(s)) return MARKED;
  return cell(Number(s.replace(/&[a-z]+;/g, '').trim()), false);
}

// Each dam row is on one line; columns: name | location | timestamp |
// storageRate | waterLevel | storage | inflow | outflow | manager.
const ROW_RE =
  /<td[^>]+class="normal[01]">[^<]*<a[^>]+>([^<]+)<\/a>[^<]*<\/td><td[^>]+class="normal[01]">[^<]*<\/td><td[^>]+class="normal[01]">([^<]*)<\/td><td[^>]+class="normal[01]">([^<]*)<\/td><td[^>]+class="normal[01]">([^<]*)<\/td><td[^>]+class="normal[01]">([^<]*)<\/td><td[^>]+class="normal[01]">([^<]*)<\/td><td[^>]+class="normal[01]">([^<]*)<\/td><td[^>]+class="normal[01]">[^<]*<\/td>/g;

/**
 * One row's reading. Every dam the 現況表 lists is an entry, whatever it
 * currently reports: an offline dam is still a dam this source publishes,
 * and /coverage would otherwise report it as 提供元なし.
 */
function rowReading(m: RegExpMatchArray): Reading {
  const [rate, level, storage, inflow, outflow] = [m[3], m[4], m[5], m[6], m[7]].map((c) =>
    valueCell(c ?? ''),
  ) as [Cell, Cell, Cell, Cell, Cell];
  const state = cellState([rate, level, storage, inflow, outflow]);
  // Every value column "---" or blank (滝波).
  if (state === 'empty') return { state, mark: '"---" / blank in every value column' };
  // Garbage where a number belongs is more likely our parser than the
  // provider publishing nothing.
  if (state === 'unreadable')
    return { state, why: 'a value cell that is neither number nor blank' };
  const observedAt = parseFukuiTimestamp(m[2] ?? '');
  if (!observedAt) return { state: 'unreadable', why: `最新観測時刻 "${m[2]}"` };
  const ratePct = numberIn(rate);
  const thou = numberIn(storage);
  return {
    state,
    observations: [
      {
        observedAt,
        storageRate: ratePct !== null ? ratePct / 100 : null,
        waterLevelM: numberIn(level),
        storageVolumeM3: thou !== null ? thou * 1_000 : null,
        inflowM3s: numberIn(inflow),
        outflowM3s: numberIn(outflow),
      },
    ],
  };
}

/** Every dam row of the 現況表, keyed by its name. */
export function fukuiEntries(html: string): Entry[] {
  const entries: Entry[] = [];
  for (const m of html.matchAll(ROW_RE)) {
    const name = m[1]?.trim() ?? '';
    if (!name) continue;
    entries.push({ key: name, name, pref: PREF_CODE, reading: rowReading(m) });
  }
  return entries;
}

export default ingestTask(SOURCE_ID, async (log) => {
  const r = await fetch(DATA_URL, {
    headers: {
      'user-agent':
        process.env.HTTP_USER_AGENT ??
        'DamDataPlatform/0.1 (+https://dam.teraren.com/legal/terms; contact: https://discord.gg/UbWqspWbAk)',
    },
    signal: AbortSignal.timeout(20_000),
  });
  if (r.status !== 200) throw new Error(`${SOURCE_ID}: HTTP ${r.status}`);
  const html = new TextDecoder('shift_jis').decode(await r.arrayBuffer());
  const entries = fukuiEntries(html);
  log(`${SOURCE_ID}: ${entries.length} dams listed`);
  return { entries };
});
