// apps/worker/src/tasks/ingest_kitakyushu_suido.ts
//
// 北九州市上下水道局「北九州市の水源状況」 — the city's 10 water sources, daily.
//
//   油木 / ます渕 / 耶馬渓 (大分) / 力丸 / 頓田 / 畑 / 白木 / 道原 / 松ヶ江 /
//   遠賀川河口堰
//
// Source: https://www.city.kitakyushu.lg.jp/suidou/s00900011.html
// Static UTF-8 HTML. One table captioned 「2026年9月25日　午前9時現在」 (JST);
// rows are <th>場所</th> 水位「61.47メートル」 | 貯水量（万立方メートル） | 貯水率「34.9％」,
// followed by 本日貯水量合計 / 同日貯水量合計平年値, which are not facilities.
// 畑 prints the whole reservoir with 「（うち北九州分 284）」 under it; the
// first figure is the reservoir's, and that is the one stored. The page says
// it is refreshed on weekdays around 16:00 (not on weekends / holidays).
//
// Rate: 貯水率 is the city's own 利水 basis. Back-solved from the 2026-09-25
// table against the master's 有効貯水容量:
//   own dams   道原 40/87.8 % = 45.6 (有効 45.0) 万m³, 松ヶ江 52/34.9 % = 149
//              (150), 白木 16/49.7 % = 32.2 (32.4), 畑 376/54.4 % = 691 (691)
//   多目的     油木 589/40.8 % = 1,444 (有効 1,745), ます渕 726/64.0 % = 1,134
//              (1,344), 力丸 462/42.8 % = 1,079 (1,250)
// so the multipurpose dams divide by their 利水 pool, below the annual
// capacity the site would otherwise use (trusted in 0098).
//
// 頓田貯水池 is one figure (890 万m³ / 97.3 % → 915) for what the master holds
// as two dams, 頓田第1（再） 440 + 頓田第2（再） 475 万m³. Writing it to either
// would show a volume the dam cannot hold, so it never binds; it is recorded
// unresolved.
//
// Priority 300: kasenbosai (310) keeps 油木/ます渕/力丸/畑/耶馬溪, which it
// publishes every 10 minutes; this feed is the only one for 白木 / 道原 /
// 松ヶ江 / 遠賀川河口堰, and sits above kyushu-nousei (279) and oita-nourin
// (282) on 油木 / 耶馬溪. Cron daily 08:50 UTC (17:50 JST).

import { ingestTask } from '../ingest/run.ts';
import type { Entry, Reading } from '../ingest/types.ts';

const PAGE_URL =
  process.env.KITAKYUSHU_SUIDO_URL ?? 'https://www.city.kitakyushu.lg.jp/suidou/s00900011.html';

const SOURCE_ID = 'kitakyushu-suido';

/** One figure for two master dams; see the header. */
const COMBINED = '頓田貯水池';

// --- parsing ----------------------------------------------------------------

export interface ParsedRow {
  /** 場所 as published ("松ヶ江貯水池"); also the stamp and universe key. */
  name: string;
  waterLevelM: number | null;
  storageVolumeM3: number | null;
  /** 貯水率 as a 0..1 fraction. */
  storageRate: number | null;
}

function cellText(cell: string): string {
  return cell
    .replace(/<[^>]*>/g, ' ')
    .replace(/&nbsp;/g, ' ')
    .replace(/[０-９．，]/g, (c) => String.fromCharCode(c.charCodeAt(0) - 0xfee0))
    .trim();
}

/** First number in the cell ("376 （うち北九州分 284）" → 376); none → null. */
function firstNumber(cell: string): number | null {
  const m = cellText(cell).match(/-?\d[\d,]*(?:\.\d+)?/);
  if (!m) return null;
  const n = Number(m[0].replace(/,/g, ''));
  return Number.isFinite(n) ? n : null;
}

/** 「2026年9月25日　午前9時現在」 (JST) → UTC. */
function parseCaption(html: string): Date | null {
  const caption = html.match(/<caption[^>]*>([\s\S]*?)<\/caption>/)?.[1];
  if (!caption) return null;
  const m = cellText(caption).match(
    /(\d{4})年\s*(\d{1,2})月\s*(\d{1,2})日\s*(午前|午後)?\s*(\d{1,2})時(?:\s*(\d{1,2})分)?/,
  );
  if (!m) return null;
  const hour = Number(m[5]) + (m[4] === '午後' && Number(m[5]) < 12 ? 12 : 0);
  const d = new Date(
    Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3]), hour - 9, Number(m[6] ?? 0)),
  );
  return Number.isNaN(d.getTime()) ? null : d;
}

export function parseKitakyushuSuigen(html: string): {
  observedAt: Date | null;
  rows: ParsedRow[];
} {
  const rows: ParsedRow[] = [];
  for (const tr of html.matchAll(/<tr[^>]*>([\s\S]*?)<\/tr>/g)) {
    const body = tr[1] ?? '';
    const name = cellText(body.match(/<th[^>]*>([\s\S]*?)<\/th>/)?.[1] ?? '');
    const cells = [...body.matchAll(/<td[^>]*>([\s\S]*?)<\/td>/g)].map((c) => c[1] ?? '');
    if (!name || cells.length !== 3 || /合計|平年/.test(name)) continue;
    const volume = firstNumber(cells[1] ?? '');
    const rate = firstNumber(cells[2] ?? '');
    rows.push({
      name,
      waterLevelM: firstNumber(cells[0] ?? ''),
      storageVolumeM3: volume === null ? null : Math.round(volume * 10_000),
      storageRate: rate === null ? null : rate / 100,
    });
  }
  return { observedAt: parseCaption(html), rows };
}

/**
 * The master's name for a published 場所: without 貯水池, and 耶馬渓 (page) in
 * the master's old kanji 耶馬溪.
 */
function masterName(name: string): string {
  return name.replace(/貯水池$/, '').replace(/渓/g, '溪');
}

/** A row's reading: a level, a volume or a rate is a value; blank cells we leave unread. */
export function kitakyushuReading(observedAt: Date, row: ParsedRow): Reading {
  if (row.waterLevelM === null && row.storageVolumeM3 === null && row.storageRate === null) {
    return { state: 'unreadable', why: 'no 水位, 貯水量 or 貯水率' };
  }
  return {
    state: 'values',
    observations: [
      {
        observedAt,
        waterLevelM: row.waterLevelM,
        storageVolumeM3: row.storageVolumeM3,
        storageRate: row.storageRate,
      },
    ],
  };
}

/** Every facility of the table; 耶馬渓 is in 大分, every other in 福岡. */
export function kitakyushuEntries(observedAt: Date, rows: ParsedRow[]): Entry[] {
  return rows.map((row): Entry => {
    const name = masterName(row.name);
    return {
      key: row.name,
      name: row.name,
      pref: row.name.startsWith('耶馬渓') ? '44' : '40',
      ...(row.name === COMBINED
        ? { bind: 'never' as const }
        : name !== row.name
          ? { bind: { name } }
          : {}),
      reading: kitakyushuReading(observedAt, row),
    };
  });
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
  if (r.status !== 200) throw new Error(`${SOURCE_ID}: HTTP ${r.status} from ${PAGE_URL}`);

  const { observedAt, rows } = parseKitakyushuSuigen(await r.text());
  if (!observedAt) {
    throw new Error(`${SOURCE_ID}: no 「…時現在」 caption on ${PAGE_URL} — layout change?`);
  }
  log(`${SOURCE_ID}: parsed ${rows.length} facilities at ${observedAt.toISOString()}`);
  if (rows.length === 0) {
    throw new Error(`${SOURCE_ID}: caption found but no facility rows — layout change?`);
  }
  return { entries: kitakyushuEntries(observedAt, rows) };
});
