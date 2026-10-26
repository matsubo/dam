// apps/worker/src/tasks/ingest_sue_suido.ts
//
// 須恵町上下水道課「貯水率」 — 貯水率 of the town's four 水道 sources, monthly.
//
// Source: https://www.town.sue.fukuoka.jp/soshiki/jogesuido/jogesuido/josuido/1394.html
// Two UTF-8 tables: 「現在の貯水率の詳細」 (a row of names — 須恵ダム / 中柱田貯水池 /
// 旧男鳥溜池 / 新男鳥溜池 — over a row of whole-percent rates) and 「過去1年間の
// 月別貯水率の詳細」 (one row per month, no day). Only the 現在 table is read:
// the month rows carry no survey day. The page prints no date of its own for
// the 現在 figures either; it is dated by the CMS 「更新日：2026年09月01日」 at
// 00:00 JST, the day the town published them (the 月別 table's newest row, 8月,
// repeats them, so the page is re-issued about monthly).
//
// Rate only: the page prints neither volumes nor the capacity it divides by,
// so no volume is stored or derived and the rate is left untrusted — the
// site's dam page shows no 貯水率 without a volume (#60), but the dam's
// published series and its /coverage status are real.
//
// 須恵ダム → 須恵 (NDI 2441, 須恵町, 水道): the only 須恵 in pref 40. The other
// three are not in the NDI master (not_dam_reason in migration 0219).
//
// Priority 293: nothing else publishes 須恵. Cron daily 06:17 UTC (15:17 JST).

import { ingestTask } from '../ingest/run.ts';
import type { Entry } from '../ingest/types.ts';

const PAGE_URL =
  process.env.SUE_SUIDO_URL ??
  'https://www.town.sue.fukuoka.jp/soshiki/jogesuido/jogesuido/josuido/1394.html';

const PREF_CODE = '40';
const SOURCE_ID = 'sue-suido';

// --- parsing ----------------------------------------------------------------

export interface ParsedRow {
  /** Name as printed ("須恵ダム"); also the stamp and universe key. */
  name: string;
  /** 貯水率 as a 0..1 fraction. */
  storageRate: number | null;
}

export interface ParsedPage {
  /** 更新日 at 00:00 JST, or null if it is missing. */
  observedAt: Date | null;
  rows: ParsedRow[];
}

/** Tag-free, NFKC-folded, whitespace-free text. */
function flat(cell: string): string {
  return cell
    .replace(/<[^>]*>/g, '')
    .replace(/&nbsp;/g, '')
    .normalize('NFKC')
    .replace(/\s+/g, '');
}

export function parseSueRates(html: string): ParsedPage {
  const d = flat(html).match(/更新日:(\d{4})年(\d{1,2})月(\d{1,2})日/);
  const observedAt = d
    ? new Date(Date.UTC(Number(d[1]), Number(d[2]) - 1, Number(d[3]), -9))
    : null;

  const start = html.indexOf('<caption>現在の貯水率の詳細</caption>');
  const body = start >= 0 ? html.slice(start) : '';
  const table = body.slice(0, body.indexOf('</table>'));
  const [names, rates] = [...table.matchAll(/<tr[^>]*>([\s\S]*?)<\/tr>/g)].map((tr) =>
    [...(tr[1] ?? '').matchAll(/<td[^>]*>([\s\S]*?)<\/td>/g)].map((c) => flat(c[1] ?? '')),
  );

  const rows: ParsedRow[] = (names ?? []).map((name, i) => {
    const m = (rates?.[i] ?? '').match(/^(\d+(?:\.\d+)?)%$/);
    return { name, storageRate: m ? Number(m[1]) / 100 : null };
  });
  return { observedAt, rows: rows.filter((r) => r.name) };
}

/**
 * Every name of the 現在 table, bound by exact name (the page's ダム名 is the
 * master name plus ダム); the three 溜池/貯水池 stay unresolved.
 */
export function sueEntries(observedAt: Date, rows: ParsedRow[]): Entry[] {
  return rows.map(
    (row): Entry => ({
      key: row.name,
      name: row.name,
      pref: PREF_CODE,
      bind: { exact: true },
      reading:
        row.storageRate === null
          ? { state: 'unreadable', why: 'no 貯水率' }
          : { state: 'values', observations: [{ observedAt, storageRate: row.storageRate }] },
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
  if (r.status !== 200) throw new Error(`${SOURCE_ID}: HTTP ${r.status} from ${PAGE_URL}`);

  const { observedAt, rows } = parseSueRates(await r.text());
  log(`${SOURCE_ID}: parsed ${rows.length} rows, 更新日 ${observedAt?.toISOString() ?? 'missing'}`);
  if (!observedAt || rows.length === 0) {
    throw new Error(
      `${SOURCE_ID}: ${rows.length} rows / date ${observedAt ? 'found' : 'missing'} on ${PAGE_URL} — layout change?`,
    );
  }
  // The 更新日 is the newest value the town publishes, about monthly: holding
  // it keeps the dam covered between issues.
  return { entries: sueEntries(observedAt, rows), dated: true };
});
