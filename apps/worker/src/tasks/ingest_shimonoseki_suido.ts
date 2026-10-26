// apps/worker/src/tasks/ingest_shimonoseki_suido.ts
//
// 下関市上下水道局「水源状況についてお知らせします」 — the city's three
// reservoirs, updated a few times a week.
//
// Source: https://www.city.shimonoseki.lg.jp/site/water/5617.html
// Static UTF-8 HTML. A line 「令和8年9月25日現在の下関市の水源状況…」 (the
// date is split across <strong> tags) above one table captioned 水源の貯水量:
//   施設名 | 満水量「2,050,000立方メートル」 | 貯水量「507,000立方メートル」 | 貯水率「24.7%」
// for 木屋川ダム / 湯の原ダム / 内日貯水池, then a 合計 row. The notes say the
// figures are 「当日午前0時現在」, so rows are stamped 00:00 JST of that date.
// The 降水量 table below it is not read.
//
//   湯の原ダム  written. The printed 満水量 follows the season and the rate
//               divides by it: out of the 洪水期 2,050,000 (the master's
//               有効貯水容量, NDI 2024; 507,000 / 24.7 % on 2026-09-25), in the
//               洪水期 (6/15–9/15) the 1,620,000 cap (699,000 / 43.1 % on
//               2025-07-14, which the static capacity would show as 34.1 %).
//               Trusted as a season-aware native rate in 0107.
//   木屋川ダム  universe only. kasenbosai and yamaguchi-bousai publish it every
//               10 minutes, and this page's 満水量 (19,440,000; 17,332,000 in
//               the 洪水期) sits below the master's 有効 21,080,000, so its rate
//               is on another basis and a once-a-day volume adds nothing.
//   内日貯水池  universe only, unresolved. 1,900,000 is 内日第1 (有効 1,000,000)
//               + 内日第2 (900,000) as one figure; writing it to either would show
//               a volume the dam cannot hold. The stem 内日 also names the 県's
//               内日ダム (NDI 2028), a different dam, so it is refused by name.
//
// Licence: 著作権・リンク (/site/userguide/51553.html) allows 複製・引用・転載 with
// 出所の明示. robots.txt disallows only /site/iju-project/.
//
// Priority 293. Cron daily 07:46 UTC (16:46 JST): the page is edited during the
// day with that morning's 0時 figures.

import { ingestTask } from '../ingest/run.ts';
import type { Entry, Reading } from '../ingest/types.ts';

const PAGE_URL =
  process.env.SHIMONOSEKI_SUIDO_URL ?? 'https://www.city.shimonoseki.lg.jp/site/water/5617.html';

const PREF_CODE = '35';
const SOURCE_ID = 'shimonoseki-suido';

/** One figure for several master dams (内日第1 + 内日第2); binds to none. */
const COMBINED: Readonly<Record<string, true>> = { 内日貯水池: true };
/** Recorded in the universe, not written: a 10-minute source covers it. */
const UNIVERSE_ONLY: Readonly<Record<string, true>> = { 木屋川ダム: true };

// --- parsing ----------------------------------------------------------------

export interface ParsedRow {
  /** 施設名 as published ("湯の原ダム"); also the stamp and universe key. */
  name: string;
  storageVolumeM3: number | null;
  /** 貯水率 as a 0..1 fraction. */
  storageRate: number | null;
}

function cellText(cell: string): string {
  return cell
    .replace(/<[^>]*>/g, ' ')
    .replace(/&nbsp;/g, ' ')
    .replace(/[０-９．，]/g, (c) => String.fromCharCode(c.charCodeAt(0) - 0xfee0))
    .replace(/\s+/g, ' ')
    .trim();
}

function firstNumber(cell: string): number | null {
  const m = cellText(cell).match(/-?\d[\d,]*(?:\.\d+)?/);
  if (!m) return null;
  const n = Number(m[0].replace(/,/g, ''));
  return Number.isFinite(n) ? n : null;
}

/** 「令和8年9月25日現在」 → 00:00 JST of that date, as UTC. */
function parseAsOf(html: string): Date | null {
  const m = cellText(html)
    .replace(/\s+/g, '')
    .match(/令和(元|\d{1,2})年(\d{1,2})月(\d{1,2})日現在/);
  if (!m) return null;
  const year = 2018 + (m[1] === '元' ? 1 : Number(m[1]));
  const d = new Date(Date.UTC(year, Number(m[2]) - 1, Number(m[3]), -9));
  return Number.isNaN(d.getTime()) ? null : d;
}

export function parseShimonosekiSuigen(html: string): {
  observedAt: Date | null;
  rows: ParsedRow[];
} {
  const table = [...html.matchAll(/<table[^>]*>([\s\S]*?)<\/table>/g)]
    .map((t) => t[1] ?? '')
    .find((t) => /<th[^>]*>[^<]*貯水率/.test(t));
  const rows: ParsedRow[] = [];
  for (const tr of (table ?? '').matchAll(/<tr[^>]*>([\s\S]*?)<\/tr>/g)) {
    const cells = [...(tr[1] ?? '').matchAll(/<td[^>]*>([\s\S]*?)<\/td>/g)].map((c) => c[1] ?? '');
    const name = cellText(cells[0] ?? '').replace(/\s/g, '');
    if (cells.length !== 4 || !name || /合計/.test(name)) continue;
    const rate = firstNumber(cells[3] ?? '');
    rows.push({
      name,
      storageVolumeM3: firstNumber(cells[2] ?? ''),
      storageRate: rate === null ? null : rate / 100,
    });
  }
  return { observedAt: parseAsOf(html), rows };
}

/** A row's reading: a volume or a rate is a value; blank cells we leave unread. */
export function shimonosekiReading(observedAt: Date, row: ParsedRow): Reading {
  if (row.storageVolumeM3 === null && row.storageRate === null) {
    return { state: 'unreadable', why: 'no 貯水量 or 貯水率' };
  }
  return {
    state: 'values',
    observations: [
      { observedAt, storageVolumeM3: row.storageVolumeM3, storageRate: row.storageRate },
    ],
  };
}

/** Every 施設 row: 内日貯水池 never binds, 木屋川ダム is recorded, never written. */
export function shimonosekiEntries(observedAt: Date, rows: ParsedRow[]): Entry[] {
  return rows.map(
    (row): Entry => ({
      key: row.name,
      name: row.name,
      pref: PREF_CODE,
      ...(COMBINED[row.name] ? { bind: 'never' as const } : {}),
      ...(UNIVERSE_ONLY[row.name]
        ? { dontWrite: 'kasenbosai and yamaguchi-bousai carry it every 10 minutes' }
        : {}),
      reading: shimonosekiReading(observedAt, row),
    }),
  );
}

export default ingestTask(SOURCE_ID, async (log) => {
  const r = await fetch(PAGE_URL, {
    headers: {
      'user-agent':
        process.env.HTTP_USER_AGENT ??
        'DamDataPlatform/0.1 (+https://dam.teraren.com/legal/terms; contact: https://discord.gg/UbWqspWbAk)',
    },
    signal: AbortSignal.timeout(20_000),
  });
  // The page is a 渇水 notice, taken down when the drought ends: nothing listed.
  if (r.status === 404) {
    log(`${SOURCE_ID}: HTTP 404 from ${PAGE_URL} (no drought notice)`);
    return { entries: [] };
  }
  if (r.status !== 200) throw new Error(`${SOURCE_ID}: HTTP ${r.status} from ${PAGE_URL}`);

  const { observedAt, rows } = parseShimonosekiSuigen(await r.text());
  if (!observedAt) {
    throw new Error(`${SOURCE_ID}: no 「令和…日現在」 line on ${PAGE_URL} — layout change?`);
  }
  log(`${SOURCE_ID}: parsed ${rows.length} facilities at ${observedAt.toISOString()}`);
  if (rows.length === 0) {
    throw new Error(`${SOURCE_ID}: date found but no 貯水量 table rows — layout change?`);
  }
  return { entries: shimonosekiEntries(observedAt, rows) };
});
