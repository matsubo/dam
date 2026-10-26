// apps/worker/src/tasks/ingest_qsr_toukan.ts
//
// 国土交通省 九州地方整備局 筑後川ダム統合管理事務所 — 2 国管理ダム (筑後川水系).
//
//   松原ダム / 下筌ダム (both in Oita/44)
//
// Source:
//   https://www.qsr.mlit.go.jp/toukan/bousaijouhou.php
//   UTF-8 HTML; two tables, each with one data row (latest reading).
//   Updated on the hour (毎時00分更新).
//
// Table structure (2 header rows + 1 data row per dam):
//   [0] 観測時刻  "YYYY/MM/DD HH:MM" (JST)
//   [1] 貯水位[m]
//   [2] 流入量[m3/s]
//   [3] ゲート放流量[m3/s]
//   [4] 発電使用水量[m3/s]
//   [5] 全放流量[m3/s]   ← preferred outflow
//   [6] 時間雨量[mm]
//   [7] 累加雨量[mm]
//   [8] 流域時間雨量[mm]
//   [9] 流域累加雨量[mm]
//
// 欠測 or a dash in the three stored columns is the office's own mark. The two
// dams are known in advance, so a failed fetch leaves both unreadable rather
// than unlisted.
//
// Priority 303 (MLIT-managed dams). Cron hourly at :26.

import { type Cell, cellState, MARKED, numberIn } from '../ingest/cells.ts';
import { ingestTask } from '../ingest/run.ts';
import type { Entry, Reading } from '../ingest/types.ts';

const DATA_URL = process.env.QSR_TOUKAN_URL ?? 'https://www.qsr.mlit.go.jp/toukan/bousaijouhou.php';

const SOURCE_ID = 'qsr-toukan-dam';

// --- dam config -------------------------------------------------------------

interface DamCfg {
  pageName: string;
  prefCode: string;
}

// In page order: the two data tables are table[1] and table[2] of the page.
const DAMS: DamCfg[] = [
  { pageName: '松原ダム', prefCode: '44' },
  { pageName: '下筌ダム', prefCode: '44' },
];

// --- parsing ----------------------------------------------------------------

function stripTags(raw: string): string {
  return raw
    .replace(/<[^>]+>/g, '')
    .replace(/&nbsp;/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function parseCell(s: string): Cell {
  const t = (s ?? '').trim();
  if (/^(?:欠測|[-－―ー−]+)$/.test(t)) return MARKED;
  const m = t.match(/-?\d+(?:\.\d+)?/);
  if (!m) return null;
  const n = Number(m[0]);
  return Number.isFinite(n) ? n : null;
}

/** "YYYY/MM/DD HH:MM" JST → UTC. */
export function parseToukantimestamp(s: string): Date | null {
  const m = s.trim().match(/^(\d{4})\/(\d{2})\/(\d{2})\s+(\d{2}):(\d{2})$/);
  if (!m) return null;
  const d = new Date(
    Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3]), Number(m[4]) - 9, Number(m[5]), 0, 0),
  );
  return Number.isNaN(d.getTime()) ? null : d;
}

/** Extract the Nth data table from the HTML (1-indexed, skips the first decorative table). */
function extractTable(html: string, tableIdx: number): string[][] {
  const tableMatches = Array.from(html.matchAll(/<table[^>]*>([\s\S]*?)<\/table>/gi));
  const table = tableMatches[tableIdx];
  if (!table) return [];
  const rows: string[][] = [];
  for (const trMatch of (table[1] ?? '').matchAll(/<tr[^>]*>([\s\S]*?)<\/tr>/gi)) {
    const cells = Array.from((trMatch[1] ?? '').matchAll(/<t[dh][^>]*>([\s\S]*?)<\/t[dh]>/gi)).map(
      (m) => stripTags(m[1] ?? ''),
    );
    rows.push(cells);
  }
  return rows;
}

/** Read a two-header-row table: row[0]=header1, row[1]=header2, row[2]=data. */
export function toukanReading(html: string, tableIdx: number): Reading {
  const rows = extractTable(html, tableIdx);
  // rows[0] and rows[1] are headers; rows[2] is the first (latest) data row
  const data = rows[2];
  if (!data || data.length < 6)
    return { state: 'unreadable', why: `no data row in table ${tableIdx}` };

  const observedAt = parseToukantimestamp(data[0] ?? '');
  if (!observedAt) return { state: 'unreadable', why: `観測時刻 "${data[0]}"` };

  const level = parseCell(data[1] ?? '');
  const inflow = parseCell(data[2] ?? '');
  const outflow = parseCell(data[5] ?? ''); // 全放流量 = gate + power discharge
  const rain = parseCell(data[6] ?? '');

  const state = cellState([level, inflow, outflow]);
  if (state === 'empty') return { state, mark: '欠測 in every stored column' };
  if (state === 'unreadable') return { state, why: 'no numeric column' };
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
}

/** Both dams; with no page (a failed fetch) each is unreadable with the reason. */
export function toukanEntries(page: { html: string } | { error: string }): Entry[] {
  // Tables in the page: index 0 is a decorative header table; indices 1 and 2 are dam data
  return DAMS.map((cfg, i) => ({
    key: cfg.pageName,
    name: cfg.pageName,
    pref: cfg.prefCode,
    reading:
      'html' in page ? toukanReading(page.html, i + 1) : { state: 'unreadable', why: page.error },
  }));
}

async function fetchPage(): Promise<{ html: string } | { error: string }> {
  try {
    const r = await fetch(DATA_URL, {
      headers: {
        'user-agent':
          process.env.HTTP_USER_AGENT ??
          'DamDataPlatform/0.1 (+https://dam.teraren.com/legal/terms; contact: https://discord.gg/UbWqspWbAk)',
      },
      signal: AbortSignal.timeout(20_000),
    });
    if (r.status !== 200) return { error: `HTTP ${r.status}` };
    return { html: await r.text() };
  } catch (err) {
    return { error: err instanceof Error ? err.message : String(err) };
  }
}

export default ingestTask(SOURCE_ID, async () => ({ entries: toukanEntries(await fetchPage()) }));
