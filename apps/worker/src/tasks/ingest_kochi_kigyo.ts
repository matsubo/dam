// apps/worker/src/tasks/ingest_kochi_kigyo.ts
//
// 高知県公営企業局 発電所集中監視制御Webシステム ダム水文量表 — 2 発電専用ダム
// on the 物部川: 吉野ダム and 杉田ダム. Neither is in kochi-bousai's ダム諸量
// or any other feed; the bureau publishes them under the 物部川水系治水協定
// (https://www.pref.kochi.lg.jp/doc/denki_dam_info/).
//
// Source:
//   http://210.155.220.59/web/crt17/01/01
//   (UTF-8 HTML; plain GET, no session needed. Default view is 本日 / 1時間:
//   the last 48 hourly rows, oldest first.)
//
// Table: header row 1 names each dam (<th colspan="5">), header row 2 labels
// its columns 貯水位(EL.m) | 流入量(m3/s) | 放流量(m3/s) | 雨量(mm) | 累計雨量(mm).
// Each data row carries td.col_time "YYYY-MM-DD HH:MM:SS.0" (JST) and then
// td.info values for every dam in header order. No volume or rate is
// published. The site calls the values 瞬時値 that may differ from the
// official record, so they are stored as published; 流入量 can be slightly
// negative (-0.8) when the back-calculated inflow dips. Any non-numeric cell
// is read as null, and an hour with no level, inflow or outflow for a dam is
// dropped: the page re-serves 48 hours every run, so an outage row would
// otherwise overwrite an hour already stored with values.
//
// Priority 308, the prefectural tier; no other source covers either dam.
// Cron hourly at :44.

import { ingestTask } from '../ingest/run.ts';
import type { Entry } from '../ingest/types.ts';

const DATA_URL = process.env.KOCHI_KIGYO_DAM_URL ?? 'http://210.155.220.59/web/crt17/01/01';

const PREF_CODE = '39';
const SOURCE_ID = 'kochi-kigyo';

// --- parsing ----------------------------------------------------------------

export interface KochiKigyoReading {
  /** Dam name as published ("杉田ダム"); also the stamp and universe key. */
  name: string;
  observedAt: Date;
  waterLevelM: number | null;
  inflowM3s: number | null;
  outflowM3s: number | null;
  /** That hour's 雨量, not the 累計雨量 column. */
  rainfallMm: number | null;
}

export interface KochiKigyoTable {
  /** Every dam the table publishes, in column order. */
  dams: string[];
  readings: KochiKigyoReading[];
}

function cellText(cell: string): string {
  return cell
    .replace(/<[^>]*>/g, '')
    .replace(/&[a-z]+;/g, '')
    .trim();
}

function cellValue(cell: string | undefined): number | null {
  const text = cellText(cell ?? '');
  if (text === '') return null;
  const n = Number(text);
  return Number.isFinite(n) ? n : null;
}

export function parseKochiKigyoTable(html: string): KochiKigyoTable {
  const start = html.indexOf('<table class="OddEven">');
  if (start < 0) return { dams: [], readings: [] };
  const end = html.indexOf('</table>', start);
  const table = html.slice(start, end < 0 ? undefined : end);

  const dams: { name: string; span: number }[] = [];
  const labels: string[] = [];
  const rows: { observedAt: Date; values: string[] }[] = [];
  for (const tr of table.matchAll(/<tr[^>]*>([\s\S]*?)<\/tr>/g)) {
    const body = tr[1] ?? '';
    const time = body.match(
      /<td[^>]*class="col_time"[^>]*>\s*(\d{4})-(\d{2})-(\d{2}) (\d{2}):(\d{2})/,
    );
    if (time) {
      const observedAt = new Date(
        Date.UTC(
          Number(time[1]),
          Number(time[2]) - 1,
          Number(time[3]),
          Number(time[4]) - 9,
          Number(time[5]),
        ),
      );
      const values = [...body.matchAll(/<td[^>]*class="info"[^>]*>([\s\S]*?)<\/td>/g)].map(
        (c) => c[1] ?? '',
      );
      rows.push({ observedAt, values });
      continue;
    }
    for (const th of body.matchAll(/<th([^>]*)>([\s\S]*?)<\/th>/g)) {
      const attrs = th[1] ?? '';
      const text = cellText(th[2] ?? '');
      const span = attrs.match(/colspan="(\d+)"/i);
      if (span) dams.push({ name: text, span: Number(span[1]) });
      else if (!/rowspan/i.test(attrs)) labels.push(text);
    }
  }

  const readings: KochiKigyoReading[] = [];
  let offset = 0;
  for (const dam of dams) {
    const block = labels.slice(offset, offset + dam.span);
    const col = (re: RegExp): number => {
      const i = block.findIndex((l) => re.test(l));
      return i < 0 ? -1 : offset + i;
    };
    const level = col(/^貯水位/);
    const inflow = col(/^流入量/);
    const outflow = col(/^放流量/);
    const rain = col(/^雨量/);
    for (const r of rows) {
      const waterLevelM = cellValue(r.values[level]);
      const inflowM3s = cellValue(r.values[inflow]);
      const outflowM3s = cellValue(r.values[outflow]);
      if (waterLevelM === null && inflowM3s === null && outflowM3s === null) continue;
      readings.push({
        name: dam.name,
        observedAt: r.observedAt,
        waterLevelM,
        inflowM3s,
        outflowM3s,
        rainfallMm: cellValue(r.values[rain]),
      });
    }
    offset += dam.span;
  }
  return { dams: dams.map((d) => d.name), readings };
}

// --- entries ----------------------------------------------------------------

/**
 * Every dam the table heads, keyed by its published name. Matched exactly,
 * never by prefix: 吉野 would otherwise land on the agricultural 吉野溜池.
 */
export function kochiKigyoEntries(html: string): Entry[] {
  const { dams, readings } = parseKochiKigyoTable(html);
  return dams.map((name): Entry => {
    const observations = readings.filter((r) => r.name === name).map(({ name: _, ...o }) => o);
    return {
      key: name,
      name,
      pref: PREF_CODE,
      bind: { exact: true },
      reading:
        observations.length > 0
          ? { state: 'values', observations }
          : { state: 'unreadable', why: 'no hour with a level, inflow or outflow' },
    };
  });
}

// --- task -------------------------------------------------------------------

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

  const entries = kochiKigyoEntries(await r.text());
  log(`${SOURCE_ID}: ${entries.length} dams`);
  return { entries };
});
