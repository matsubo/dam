// apps/worker/src/tasks/ingest_hirado_suido.ts
//
// 平戸市水道局「市内水道用ダムの貯水状況について」 — the city's 8 水道 sources,
// about every ten days.
//
// Source: https://www.city.hirado.nagasaki.jp/kurashi/life/water/cyosuiritsu.html
// One UTF-8 table captioned 市内水道用ダム貯水率:
//   ダム名称 | 満水量 (㎥) | 貯水量 (㎥) | 貯水率 (％)
// with a 「８か所計」 total row, dated by a note under it, 「（注）令和８年９月24日現在」
// (full-width digits, no time: stamped 00:00 JST). The linked detail PDF
// (files/damutyosui.0924.pdf) prints this edition beside the previous one,
// R8.9.14, so the table is re-issued roughly every ten days.
//
// Rows: 神曽根 / 箕坪 / 阿奈田 / 神の川 / 桜川 are master dams no other source
// publishes (all 平戸市 水道; 神の川 and 桜川 came from 生月町 in the 2005
// merger). 平床の池 (3,000 m³) and the 轟川 / 東流川 砂防ダム are not in the NDI
// master; they are recorded unresolved and migration 0219 gives them a
// not_dam_reason.
//
// 神曽根ダム → 神曽根第2 (NDI 2639) by pin: the master has no other 神曽根, but
// the page drops the 「第2」, so a name rule would need a prefix match. The
// pin's evidence: the 「神曽根ダム」 point on mapion (L0680168, 33.35285 N
// 129.51438 E) lies 57 m from the master's 神曽根第2 (33.35234 N 129.51434 E),
// ダム便覧 3683 has 神曽根第2 (平戸市下中野町) as the only 神曽根 dam, and the
// page's 満水量 100,000 fits inside its 有効 120,000.
//
// Rate: 貯水量 / 満水量 as printed (89,000 / 100,000 = 89.0 %). The 満水量 is the
// city's 水道 pool and differs from the master's 有効 for three dams (阿奈田
// 130,000 vs 160,000; 神の川 160,000 vs 223,000; 神曽根 100,000 vs 120,000);
// trusted in 0219, as sasebo-suido's 川谷 share was in 0098.
//
// Priority 293: nothing else publishes these dams. Cron daily 06:44 UTC
// (15:44 JST); a re-run of an unchanged edition re-upserts the same rows.

import { ingestTask } from '../ingest/run.ts';
import type { Entry, Reading } from '../ingest/types.ts';

const PAGE_URL =
  process.env.HIRADO_SUIDO_URL ??
  'https://www.city.hirado.nagasaki.jp/kurashi/life/water/cyosuiritsu.html';

const PREF_CODE = '42';
const SOURCE_ID = 'hirado-suido';

/** Page names whose master row the name rule cannot reach, pinned by NDI (see header). */
const NDI_PINS: Readonly<Record<string, string>> = {
  神曽根ダム: '2639',
};

// --- parsing ----------------------------------------------------------------

export interface ParsedRow {
  /** ダム名称 as printed ("神の川ダム"); also the stamp and universe key. */
  name: string;
  /** 満水量 (m³), the figure the rate divides by. */
  capacityM3: number | null;
  storageVolumeM3: number | null;
  /** 貯水率 as a 0..1 fraction. */
  storageRate: number | null;
}

export interface ParsedPage {
  /** The 「…現在」 date at 00:00 JST, or null if the note is missing. */
  observedAt: Date | null;
  rows: ParsedRow[];
}

/** Tag-free, NFKC-folded (full-width digits → ASCII), whitespace-free text. */
function flat(cell: string): string {
  return cell
    .replace(/<[^>]*>/g, '')
    .replace(/&nbsp;/g, '')
    .normalize('NFKC')
    .replace(/\s+/g, '');
}

/** "383,760㎥" / "73.8％" → number; anything else ("－", blank) → null. */
function num(cell: string | undefined): number | null {
  const m = flat(cell ?? '')
    .replace(/,/g, '')
    .match(/^(\d+(?:\.\d+)?)(?:m3|%)?$/);
  return m ? Number(m[1]) : null;
}

export function parseHiradoDams(html: string): ParsedPage {
  const start = html.indexOf('市内水道用ダム貯水率</caption>');
  const body = start >= 0 ? html.slice(start) : '';
  const table = body.slice(0, body.indexOf('</table>'));

  const rows: ParsedRow[] = [];
  for (const tr of table.matchAll(/<tr[^>]*>([\s\S]*?)<\/tr>/g)) {
    const cells = [...(tr[1] ?? '').matchAll(/<td[^>]*>([\s\S]*?)<\/td>/g)].map((c) => c[1]);
    if (cells.length !== 4) continue;
    const name = flat(cells[0] ?? '');
    if (!name || name === 'ダム名称' || /計$/.test(name)) continue;
    const rate = num(cells[3]);
    rows.push({
      name,
      capacityM3: num(cells[1]),
      storageVolumeM3: num(cells[2]),
      storageRate: rate === null ? null : rate / 100,
    });
  }

  // The note follows the table: 「（注）令和８年９月24日現在」.
  const d = flat(body.slice(body.indexOf('</table>'), body.indexOf('</table>') + 400)).match(
    /令和(元|\d+)年(\d{1,2})月(\d{1,2})日現在/,
  );
  const observedAt = d
    ? new Date(
        Date.UTC(2018 + (d[1] === '元' ? 1 : Number(d[1])), Number(d[2]) - 1, Number(d[3]), -9),
      )
    : null;
  return { observedAt, rows };
}

/** A row's reading: a volume or a rate is a value; blank cells we leave unread. */
export function hiradoReading(observedAt: Date, row: ParsedRow): Reading {
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
 * Every table row. 神曽根 binds by its NDI pin; the rest by exact name only
 * (the page's ダム名称 is the master name plus ダム), so 平床の池 and the 砂防
 * dams stay unresolved.
 */
export function hiradoEntries(observedAt: Date, rows: ParsedRow[]): Entry[] {
  return rows.map((row): Entry => {
    const pin = NDI_PINS[row.name];
    return {
      key: row.name,
      name: row.name,
      pref: PREF_CODE,
      bind: pin ? { ndi: pin } : { exact: true },
      reading: hiradoReading(observedAt, row),
    };
  });
}

export default ingestTask(SOURCE_ID, async ({ log, upstream }) => {
  const { observedAt, rows } = parseHiradoDams((await upstream.fetch(PAGE_URL)).text());
  log(`${SOURCE_ID}: parsed ${rows.length} rows, 現在 ${observedAt?.toISOString() ?? 'missing'}`);
  if (!observedAt || rows.length === 0) {
    throw new Error(
      `${SOURCE_ID}: ${rows.length} rows / date ${observedAt ? 'found' : 'missing'} on ${PAGE_URL} — layout change?`,
    );
  }
  return { entries: hiradoEntries(observedAt, rows) };
});
