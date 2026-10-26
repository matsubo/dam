// apps/worker/src/tasks/ingest_hyogo_kigyo.ts
//
// 兵庫県企業庁 水道課「貯水状況」 — the 10 水源 of 県営水道 / 県営工業用水道, weekly.
//
// Source: https://web.pref.hyogo.lg.jp/kc02/ea02_000000005.html
// Static UTF-8 HTML. 「2026年9月24日現在の、兵庫県営水道及び県営工業用水道の水源の
// 貯水状況です。」 over one table
//   ダム名称 | 水系 | ダム管理者 | 利水容量（千m³） | 現在の貯水量（千m³） | 貯水率（%) | 備考
// with 「（貯水率=現在の貯水量/利水容量）」 under it, then a 洪水期制限水量 table
// that is not read. The page says it carries 「毎週月曜日（祝日の際はその翌日）の
// 情報を、取りまとめ次第更新」; no time of day is given, so the date is stamped
// 00:00 JST.
//
// Only 神谷 is written. Its 利水容量 16,100 千m³ is the master's 有効貯水容量 and
// the dam is 水道専用, so 13,989 / 16,100 = 86.9 % is the site's own static
// denominator: volume and rate are stored, and the source is not trusted
// (0048's okinawa-eb reasoning). Every other row is recorded in the universe
// only:
// - 黒川 is 関西電力's pumped-storage upper reservoir (有効 21,360 千m³). The
//   page prints the 企業庁's 3,980 千m³ share, full at 100.0 % while the
//   reservoir itself swings daily with generation, so neither its volume nor
//   its rate describes the dam: nothing is stored, and the row is recorded
//   unresolved and unstamped (NOT_THE_DAM); 0135 marks it not_dam_reason.
//   Resolving it would list 黒川 as published_not_ingested, a gap we do not
//   intend to close.
// - 平荘 / 権現 are reservoir totals over several dam bodies (平荘第1/2/3,
//   権現第1/3), so their stem matches no single row. The master gives 平荘第1
//   and 権現第1 the reservoir's whole 有効 (9,000 / 11,000) and kasenbosai
//   stores both reservoirs on those rows, so 0135 stamps them there.
// - 一庫 / 青野 / 呑吐 / 大川瀬 / 生野 / 引原 have live 10-minute feeds, and
//   several print a 利水 volume and pool (青野 9,300 against 有効 14,100)
//   that the site would divide by the annual capacity.
//
// Priority 289: nothing else publishes 神谷. Cron daily 03:40 UTC (12:40 JST);
// a weekly page is polled daily so a Tuesday update after a holiday, or an
// urgent 「随時更新」, lands the same day.

import { ingestTask } from '../ingest/run.ts';
import type { Entry, Reading } from '../ingest/types.ts';

const PAGE_URL =
  process.env.HYOGO_KIGYO_URL ?? 'https://web.pref.hyogo.lg.jp/kc02/ea02_000000005.html';

const PREF_CODE = '28';
const SOURCE_ID = 'hyogo-kigyo';

/** The one row whose volume and rate are on the master's basis; see the header. */
const STORED_NAME = '神谷ダム';

/** Rows whose figures are an allocation, not the named dam's; see the header. */
const NOT_THE_DAM = '黒川ダム';

// --- parsing ----------------------------------------------------------------

export interface ParsedRow {
  /** ダム名称 without notes or reading ("呑吐ダム"); also the stamp and universe key. */
  name: string;
  storageVolumeM3: number | null;
  /** 貯水率 as a 0..1 fraction. */
  storageRate: number | null;
}

/** Tag-free, NFKC-folded (full-width digits → ASCII), whitespace-free text. */
function flat(cell: string): string {
  return cell
    .replace(/<[^>]*>/g, '')
    .replace(/&nbsp;/g, '')
    .normalize('NFKC')
    .replace(/\s+/g, '');
}

/** 「13,989」 (千m³ or %) → 13989; blank or 「－」 → null. */
function num(cell: string | undefined): number | null {
  const t = flat(cell ?? '').replace(/,/g, '');
  if (!/^\d+(?:\.\d+)?$/.test(t)) return null;
  return Number(t);
}

/** 「2026年9月24日現在」 (JST, no time) → 00:00 JST in UTC. */
function parseAsOf(html: string): Date | null {
  const m = flat(html).match(/(\d{4})年(\d{1,2})月(\d{1,2})日現在/);
  if (!m) return null;
  const d = new Date(Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3]), -9));
  return Number.isNaN(d.getTime()) ? null : d;
}

export function parseHyogoKigyoChosui(html: string): {
  observedAt: Date | null;
  rows: ParsedRow[];
} {
  const rows: ParsedRow[] = [];
  for (const table of html.matchAll(/<table[^>]*>([\s\S]*?)<\/table>/g)) {
    const body = table[1] ?? '';
    const headers = [...body.matchAll(/<th[^>]*>([\s\S]*?)<\/th>/g)].map((th) => flat(th[1] ?? ''));
    const col = (label: string): number => headers.findIndex((h) => h.startsWith(label));
    const nameAt = col('ダム名称');
    const volumeAt = col('現在の貯水量');
    const rateAt = col('貯水率');
    if (nameAt < 0 || volumeAt < 0 || rateAt < 0) continue;

    for (const tr of body.matchAll(/<tr[^>]*>([\s\S]*?)<\/tr>/g)) {
      const cells = [...(tr[1] ?? '').matchAll(/<td[^>]*>([\s\S]*?)<\/td>/g)].map((c) => c[1]);
      // 「一庫ダム（洪水期制限水量適用中）」, 「呑吐（どんど）ダム」 → the bare name.
      const name = flat(cells[nameAt] ?? '').replace(/\([^)]*\)/g, '');
      if (!name.endsWith('ダム')) continue;
      const volume = num(cells[volumeAt]);
      const rate = num(cells[rateAt]);
      rows.push({
        name,
        storageVolumeM3: volume === null ? null : Math.round(volume * 1000),
        storageRate: rate === null ? null : rate / 100,
      });
    }
  }
  return { observedAt: parseAsOf(html), rows };
}

/** A row's reading: a volume or a rate is a value; blank cells we leave unread. */
export function hyogoKigyoReading(observedAt: Date, row: ParsedRow): Reading {
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

/**
 * Every 水源 row. 神谷 is written; the rest are recorded only (see the
 * header). 平荘 / 権現 bind by their 0135 stamps (the ladder reaches several
 * dam bodies and stays unbound); 黒川 is the 企業庁 share, never the dam.
 */
export function hyogoKigyoEntries(observedAt: Date, rows: ParsedRow[]): Entry[] {
  return rows.map((row): Entry => {
    const reading = hyogoKigyoReading(observedAt, row);
    const base = { key: row.name, name: row.name, pref: PREF_CODE, reading };
    if (row.name === NOT_THE_DAM) return { ...base, bind: 'never' };
    if (row.name === STORED_NAME) return base;
    return { ...base, dontWrite: 'not on the master basis, or a live feed covers it' };
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

  const { observedAt, rows } = parseHyogoKigyoChosui(await r.text());
  if (!observedAt || !rows.some((row) => row.name === STORED_NAME)) {
    throw new Error(
      `${SOURCE_ID}: date=${observedAt?.toISOString() ?? 'none'} rows=${rows.length}, no ${STORED_NAME} on ${PAGE_URL} — layout change?`,
    );
  }
  log(`${SOURCE_ID}: parsed ${rows.length} 水源 as of ${observedAt.toISOString()}`);
  return { entries: hyogoKigyoEntries(observedAt, rows) };
});
