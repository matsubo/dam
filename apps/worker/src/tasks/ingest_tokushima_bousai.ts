// apps/worker/src/tasks/ingest_tokushima_bousai.ts
//
// 徳島県河川砂防水位観測所 ダム諸量情報 — 7 ダム, 10分更新.
//
//   7 dams: 長安口/福井/川口/正木/宮川内/棚野/池田(水)
//
// Source:
//   https://www.kasen.pref.tokushima.lg.jp/sp/status/dam_status.html
// Format: Shift_JIS HTML, no session. 3 columns per dam: 貯水位(m) / 流入量(m³/s) / 放流量(m³/s).
// Individual per-dam timestamps: "MM/DD HH:MM" JST (no year).
// "***" and a blank cell are the page's own marks; a dam marked in all three
// value columns is provider-marked empty.
// Priority 308.

import { type Cell, cell, cellState, numberIn } from '../ingest/cells.ts';
import { ingestTask } from '../ingest/run.ts';
import type { Entry, Reading } from '../ingest/types.ts';

const DATA_URL =
  process.env.TOKUSHIMA_BOUSAI_URL ??
  'https://www.kasen.pref.tokushima.lg.jp/sp/status/dam_status.html';

const PREF_CODE = '36';
const SOURCE_ID = 'tokushima-bousai';

// --- parsing ----------------------------------------------------------------

/**
 * "MM/DD HH:MM" JST → UTC Date.
 * Year is supplied by caller; handles Dec→Jan crossover for real-time data.
 */
export function parseTokushimaTimestamp(s: string, currentYear: number): Date | null {
  const m = s.match(/(\d{2})\/(\d{2})\s+(\d{2}):(\d{2})/);
  if (!m) return null;
  const mo = Number(m[1]);
  const dy = Number(m[2]);
  const hr = Number(m[3]);
  const mi = Number(m[4]);
  if (mo < 1 || mo > 12 || dy < 1 || dy > 31) return null;
  const d = new Date(Date.UTC(currentYear, mo - 1, dy, hr - 9, mi, 0, 0));
  return Number.isNaN(d.getTime()) ? null : d;
}

function parseNum(s: string): Cell {
  if (s === '' || s === '***') return cell(null, true);
  const clean = s.replace(/[^\d.-]/g, '').trim();
  return cell(clean ? Number(clean) : null, false);
}

/** Strip HTML tags and &nbsp; from a cell value string */
function extractText(s: string): string {
  return s
    .replace(/<[^>]+>/g, '')
    .replace(/&nbsp;/g, ' ')
    .trim();
}

function sectionReading(section: string, currentYear: number): Reading {
  // Find the observation data row: a line with 3-4 <td class="ui-bar-g..."> cells
  // First td is timestamp, next 3 are water level / inflow / outflow
  const tdRe = /<td[^>]*class="ui-bar-g[^"]*"[^>]*>([\s\S]*?)<\/td>/g;
  const tds = [...section.matchAll(tdRe)];
  if (tds.length < 4) return { state: 'unreadable', why: 'no observation row' };

  const level = parseNum(extractText(tds[1]?.[1] ?? ''));
  const inflow = parseNum(extractText(tds[2]?.[1] ?? ''));
  const outflow = parseNum(extractText(tds[3]?.[1] ?? ''));
  const state = cellState([level, inflow, outflow]);
  if (state === 'empty') return { state, mark: '*** or blank in every value column' };
  if (state === 'unreadable') return { state, why: 'no numeric cell' };

  const tsText = extractText(tds[0]?.[1] ?? '');
  const observedAt = parseTokushimaTimestamp(tsText, currentYear);
  if (!observedAt) return { state: 'unreadable', why: `時刻 "${tsText}"` };
  return {
    state: 'values',
    observations: [
      {
        observedAt,
        waterLevelM: numberIn(level),
        inflowM3s: numberIn(inflow),
        outflowM3s: numberIn(outflow),
      },
    ],
  };
}

/** One entry per dam section, keyed by its printed name. */
export function tokushimaEntries(html: string, currentYear: number): Entry[] {
  // Split on dam sections: each dam starts at <span class="sitename">
  const sectionRe = /<span class="sitename">([^<]+)<\/span>/g;
  const sectionMatches = [...html.matchAll(sectionRe)];

  const out: Entry[] = [];
  for (let i = 0; i < sectionMatches.length; i++) {
    const match = sectionMatches[i];
    if (!match) continue;
    const name = match[1]?.trim() ?? '';
    if (!name) continue;
    const sectionStart = match.index ?? 0;
    const sectionEnd =
      i + 1 < sectionMatches.length
        ? (sectionMatches[i + 1]?.index ?? sectionStart + 3000)
        : sectionStart + 3000;
    const section = html.slice(sectionStart, sectionEnd);
    out.push({ key: name, name, pref: PREF_CODE, reading: sectionReading(section, currentYear) });
  }
  return out;
}

// --- task -------------------------------------------------------------------

export default ingestTask(SOURCE_ID, async ({ log, upstream }) => {
  const html = (await upstream.fetch(DATA_URL)).text('shift_jis');
  const entries = tokushimaEntries(html, new Date().getUTCFullYear());
  log(`${SOURCE_ID}: ${entries.length} dams`);
  return { entries };
});
