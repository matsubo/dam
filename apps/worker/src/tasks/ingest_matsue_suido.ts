// apps/worker/src/tasks/ingest_matsue_suido.ts
//
// 松江市上下水道局「千本ダム・大谷ダム貯水量・貯水率」 — 2 水道専用ダム, daily.
//
// Source: https://www.water.matsue.shimane.jp/shiryo/chosui-list.html
// (linked from 島根県's own ダム貯水状況 page as the city's data). Static UTF-8
// HTML, one table per month, newest first — the current month and the one
// before it. Caption 「２０２６年９ 月」 is hand-typeset (full-width digits split
// across spans), header columns are
//   日付 | 千本ダム貯水量(m³) | 千本ダム貯水率(％) | 大谷ダム貯水量(m³) | 大谷ダム貯水率(％)
// and each row is one day 「25日」. The page publishes no time of day, so a
// day's reading is stamped 00:00 JST. It is edited on weekdays (Last-Modified
// Fri 2026-09-25 11:57 JST carried the 25日 row), and every run re-reads both
// tables, so a late correction to an earlier day is picked up too.
//
// Rate: 貯水率 / 貯水量 back-solve to the master's static 有効貯水容量 on every
// day checked (千本 280,269 / 74.0 % = 378.7 千m³, 有効 379; 大谷 970,296 /
// 73.1 % = 1,327 千m³, 有効 1,328), i.e. the same denominator the site already
// uses, so it is not marked trusted (0048's okinawa-eb reasoning).
//
// Priority 300: nothing else publishes 千本 / 大谷. Cron daily 04:58 UTC
// (13:58 JST), after the late-morning update.

import { ingestTask } from '../ingest/run.ts';
import type { Entry } from '../ingest/types.ts';

const PAGE_URL =
  process.env.MATSUE_SUIDO_URL ?? 'https://www.water.matsue.shimane.jp/shiryo/chosui-list.html';

const PREF_CODE = '32';
const SOURCE_ID = 'matsue-suido';

// --- parsing ----------------------------------------------------------------

export interface ParsedRow {
  /** Dam name from the column header ("千本ダム"); also the stamp and universe key. */
  name: string;
  observedAt: Date;
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

function num(cell: string | undefined): number | null {
  const t = flat(cell ?? '').replace(/,/g, '');
  if (!/^\d+(?:\.\d+)?$/.test(t)) return null;
  return Number(t);
}

export function parseMatsueChosuiList(html: string): ParsedRow[] {
  const rows: ParsedRow[] = [];
  for (const table of html.matchAll(/<table[^>]*>([\s\S]*?)<\/table>/g)) {
    const body = table[1] ?? '';
    const ym = flat(body.match(/<caption[^>]*>([\s\S]*?)<\/caption>/)?.[1] ?? '').match(
      /(\d{4})年(\d{1,2})月/,
    );
    if (!ym) continue;

    // Column index → which dam and which reading, from the header text.
    const columns = [...body.matchAll(/<th[^>]*>([\s\S]*?)<\/th>/g)].map((th) => {
      const m = flat(th[1] ?? '').match(/^(.+?ダム)(貯水量|貯水率)/);
      return m ? { name: m[1] as string, field: m[2] as string } : null;
    });

    for (const tr of body.matchAll(/<tr[^>]*>([\s\S]*?)<\/tr>/g)) {
      const cells = [...(tr[1] ?? '').matchAll(/<td[^>]*>([\s\S]*?)<\/td>/g)].map((c) => c[1]);
      const day = flat(cells[0] ?? '').match(/^(\d{1,2})日$/)?.[1];
      if (!day) continue;
      const observedAt = new Date(Date.UTC(Number(ym[1]), Number(ym[2]) - 1, Number(day), -9));
      const byDam = new Map<string, ParsedRow>();
      columns.forEach((col, i) => {
        if (!col) return;
        const row = byDam.get(col.name) ?? {
          name: col.name,
          observedAt,
          storageVolumeM3: null,
          storageRate: null,
        };
        const value = num(cells[i]);
        byDam.set(
          col.name,
          col.field === '貯水量'
            ? { ...row, storageVolumeM3: value }
            : { ...row, storageRate: value === null ? null : value / 100 },
        );
      });
      for (const r of byDam.values()) {
        if (r.storageVolumeM3 !== null || r.storageRate !== null) rows.push(r);
      }
    }
  }
  return rows;
}

/** Every dam named in a column header, readings or not. */
function publishedNames(html: string): string[] {
  const names = new Set<string>();
  for (const th of html.matchAll(/<th[^>]*>([\s\S]*?)<\/th>/g)) {
    const m = flat(th[1] ?? '').match(/^(.+?ダム)貯水量/);
    if (m?.[1]) names.add(m[1]);
  }
  return [...names];
}

/**
 * One entry per dam named in a column header, carrying every day of both
 * tables; a dam with no filled-in day is unreadable. The master name is the
 * header name without ダム, so binding stops at the exact rungs.
 */
export function matsueEntries(html: string): Entry[] {
  const rows = parseMatsueChosuiList(html);
  return publishedNames(html).map((name): Entry => {
    const days = rows.filter((r) => r.name === name);
    return {
      key: name,
      name,
      pref: PREF_CODE,
      bind: { exact: true },
      reading:
        days.length === 0
          ? { state: 'unreadable', why: 'no day with a 貯水量 or 貯水率' }
          : {
              state: 'values',
              observations: days.map((d) => ({
                observedAt: d.observedAt,
                storageVolumeM3: d.storageVolumeM3,
                storageRate: d.storageRate,
              })),
            },
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

  const entries = matsueEntries(await r.text());
  log(`${SOURCE_ID}: ${entries.length} dams`);
  if (entries.length === 0) {
    throw new Error(`${SOURCE_ID}: no dam column on ${PAGE_URL} — layout change?`);
  }
  return { entries };
});
