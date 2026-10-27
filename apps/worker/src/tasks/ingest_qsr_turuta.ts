// apps/worker/src/tasks/ingest_qsr_turuta.ts
//
// 国土交通省 九州地方整備局 鶴田ダム管理所 — 1 国管理ダム (川内川水系).
//
//   鶴田ダム (Kagoshima/46)
//
// Source:
//   https://www.qsr.mlit.go.jp/turuta/cgi-bin/ajax_gethtml.cgi?type=2
//   EUC-JP HTML table, 10分更新; rows in descending time order.
//
// Format: 7 columns per <TR>:
//   [0] date "YYYY/MM/DD"
//   [1] time "HH:MM"
//   [2] rainfall mm
//   [3] storage 千m³  (× 1000 → m³)
//   [4] inflow  m³/s
//   [5] outflow m³/s
//   [6] storage rate % (→ / 100 = ratio)
//
// The newest row carrying a storage or flow value is the reading; a table
// whose every dated row is marked (欠測, 閉局…) in those columns is
// provider-marked empty.
//
// Priority 303 (MLIT-managed dam). Cron hourly at :22.

import { type Cell, cellState, MARKED, numberIn } from '../ingest/cells.ts';
import { ingestTask } from '../ingest/run.ts';
import type { Entry, Reading } from '../ingest/types.ts';
import type { Upstream } from '../ingest/upstream.ts';

const DATA_URL =
  process.env.QSR_TURUTA_URL ?? 'https://www.qsr.mlit.go.jp/turuta/cgi-bin/ajax_gethtml.cgi?type=2';

const PREF_CODE = '46';
const SOURCE_ID = 'qsr-turuta-dam';
/** The only dam this office publishes; the feed carries no station id. */
const DAM_NAME = '鶴田ダム';

// --- parsing ----------------------------------------------------------------

function stripTags(raw: string): string {
  return raw
    .replace(/<[^>]+>/g, '')
    .replace(/&nbsp;/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/** 欠測 / 閉局 / 未受信 / a dash run are the table's own "no value" marks. */
function parseCell(s: string): Cell {
  const t = s.trim();
  if (/^(?:欠測|閉局|未受信|調整中|[-－―ー−*＊]+)$/.test(t)) return MARKED;
  const m = t.match(/-?\d+(?:\.\d+)?/);
  if (!m) return null;
  const n = Number(m[0]);
  return Number.isFinite(n) ? n : null;
}

/** "YYYY/MM/DD HH:MM" JST → UTC. */
export function parseTurutaTimestamp(date: string, time: string): Date | null {
  const dm = date.trim().match(/^(\d{4})\/(\d{2})\/(\d{2})$/);
  const tm = time.trim().match(/^(\d{2}):(\d{2})$/);
  if (!dm || !tm) return null;
  const d = new Date(
    Date.UTC(
      Number(dm[1]),
      Number(dm[2]) - 1,
      Number(dm[3]),
      Number(tm[1]) - 9,
      Number(tm[2]),
      0,
      0,
    ),
  );
  return Number.isNaN(d.getTime()) ? null : d;
}

/** The first (most recent) row carrying a stored value; rows run newest first. */
export function turutaReading(html: string): Reading {
  let marked = false;
  for (const tr of html.matchAll(/<TR[^>]*>([\s\S]*?)<\/TR>/gi)) {
    const tds = Array.from((tr[1] ?? '').matchAll(/<TD[^>]*>([\s\S]*?)<\/TD>/gi)).map((m) =>
      stripTags(m[1] ?? ''),
    );
    if (tds.length < 7) continue;

    const observedAt = parseTurutaTimestamp(tds[0] ?? '', tds[1] ?? '');
    if (!observedAt) continue;

    const rain = parseCell(tds[2] ?? '');
    const storageThou = parseCell(tds[3] ?? '');
    const inflow = parseCell(tds[4] ?? '');
    const outflow = parseCell(tds[5] ?? '');
    const ratePct = numberIn(parseCell(tds[6] ?? ''));

    const state = cellState([storageThou, inflow, outflow]);
    if (state === 'empty') marked = true;
    if (state !== 'values') continue;

    const thou = numberIn(storageThou);
    return {
      state: 'values',
      observations: [
        {
          observedAt,
          rainfallMm: numberIn(rain),
          storageVolumeM3: thou !== null ? thou * 1000 : null,
          inflowM3s: numberIn(inflow),
          outflowM3s: numberIn(outflow),
          storageRate: ratePct !== null ? Math.max(0, Math.min(1, ratePct / 100)) : null,
        },
      ],
    };
  }
  return marked
    ? { state: 'empty', mark: '欠測 in every stored column of every row' }
    : { state: 'unreadable', why: 'no row with a stored value' };
}

/** The one dam, read once the run reaches it: a failed fetch leaves it unreadable. */
export function turutaEntries(upstream: Upstream): Entry[] {
  return [
    {
      key: DAM_NAME,
      name: DAM_NAME,
      pref: PREF_CODE,
      reading: async () => turutaReading((await upstream.fetch(DATA_URL)).text('euc-jp')),
    },
  ];
}

export default ingestTask(SOURCE_ID, async ({ upstream }) => ({
  entries: turutaEntries(upstream),
}));
