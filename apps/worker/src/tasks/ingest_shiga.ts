// apps/worker/src/tasks/ingest_shiga.ts
//
// 滋賀県土木防災情報システム ダム観測情報 — hourly + latest 10-minute values.
//
// Source (Shift_JIS HTML, the site's mobile pages):
//   https://shiga-bousai.jp/mobile/dam/dam_select.php         観測局一覧 (11 stations)
//   https://shiga-bousai.jp/mobile/dam/dam_data.php?ID={id}   one station
// shiga-bousai.jp/robots.txt disallows /dam/ (the desktop dam_table.php this
// task used to read) and explicitly allows /mobile/, so only /mobile/ is read.
//
// 観測局一覧: "◆<a href="dam_data.php?ID=34191&datetime=…">青土ダム</a>" per
// station. Published 2026-09-27: 青土 / 日野川 / 永源寺 / 野洲川 / 蔵王 / 犬上川 /
// 宇曽川 / 姉川 / 余呉湖 / 石田川 / 天川. 余呉湖 and 天川 have no master dam;
// 犬上川 is listed with a 0.00 placeholder and a page with no rows at all.
//
// dam_data.php: the latest 10-minute row then six hourly rows, newest first:
//   <p>MM/DD HH:MM<br>［貯水位］369.23<br>［流入量］1.67<br>［放流量］2.19<br>
//      ［60分間雨量］0<br>［累加雨量］12</p>
// Units per the page legend: 貯水位 m (EL), 流入量 / 放流量 m³/s; rainfall mm.
// "*" 欠測 and "-" 未観測 → null. Rows carry no year: it is the reference
// time's JST year, or the previous one for a row that would lie in the future
// (12/31 rows read just after New Year). A row with level and both flows
// missing is dropped rather than written empty.
//
// Only stations bound to a master dam have their page read, so an unbound one
// stays unreadable — it has no dam for /coverage to classify anyway. Names
// bind exactly (published name, stem, …ダム, either twin of a redeveloped
// dam): no prefix or substring match, so 日野川 never falls through to 日野川脇.
//
// No 貯水量 / 貯水率 is published. Priority 308. Cron hourly at :07; each run
// re-upserts the six-hour window so short outages self-heal.

import { ingestTask } from '../ingest/run.ts';
import type { Entry, Reading } from '../ingest/types.ts';

const BASE_URL = process.env.SHIGA_BOUSAI_BASE ?? 'https://shiga-bousai.jp';

const SOURCE_ID = 'shiga-bousai';
const PREF_CODE = '25';

const USER_AGENT =
  process.env.HTTP_USER_AGENT ??
  'DamDataPlatform/0.1 (+https://dam.teraren.com/legal/terms; contact: https://discord.gg/UbWqspWbAk)';

export interface Station {
  id: string;
  /** Name as the 観測局一覧 prints it — the universe key and the stamp. */
  name: string;
}

export interface ParsedRow {
  observedAt: Date;
  waterLevelM: number | null;
  inflowM3s: number | null;
  outflowM3s: number | null;
  rainfallMm: number | null;
}

/** Every station on the 観測局一覧, in page order. */
export function parseShigaStationList(html: string): Station[] {
  return [...html.matchAll(/◆<a href="dam_data\.php\?ID=(\d+)[^"]*">([^<]+)<\/a>/g)].flatMap((m) =>
    m[1] && m[2] ? [{ id: m[1], name: m[2].trim() }] : [],
  );
}

/** "［label］value" cell → number; "*" 欠測, "-" 未観測 and blanks → null. */
function field(block: string, label: string): number | null {
  const raw = block.match(new RegExp(`［${label}］([^<]*)`))?.[1]?.trim() ?? '';
  if (raw === '') return null;
  const n = Number(raw);
  return Number.isFinite(n) ? n : null;
}

const JST_OFFSET_MS = 9 * 3600 * 1000;

export function parseShigaDamData(html: string, reference: Date): ParsedRow[] {
  const refYear = new Date(reference.getTime() + JST_OFFSET_MS).getUTCFullYear();
  const out: ParsedRow[] = [];
  for (const m of html.matchAll(/<p>(\d{2})\/(\d{2}) (\d{2}):(\d{2})<br>([\s\S]*?)<\/p>/g)) {
    const [, mo, dy, hh, mi, block = ''] = m;
    const at = (year: number) =>
      new Date(Date.UTC(year, Number(mo) - 1, Number(dy), Number(hh), Number(mi)) - JST_OFFSET_MS);
    const thisYear = at(refYear);
    const observedAt =
      thisYear.getTime() > reference.getTime() + 24 * 3600 * 1000 ? at(refYear - 1) : thisYear;
    const row = {
      observedAt,
      waterLevelM: field(block, '貯水位'),
      inflowM3s: field(block, '流入量'),
      outflowM3s: field(block, '放流量'),
      rainfallMm: field(block, '60分間雨量'),
    };
    if (row.waterLevelM === null && row.inflowM3s === null && row.outflowM3s === null) continue;
    out.push(row);
  }
  return out;
}

/**
 * Whether a station page carries any reading: true = rows we store; false =
 * a recognised station page whose every level / flow is "*" 欠測 or "-"
 * 未観測, or 犬上川's exact shape (the 現在 header straight into the legend
 * <hr>, no rows at all); null = anything else, which may be an error page or
 * a redesign rather than the provider publishing nothing.
 */
export function shigaPageHasData(html: string): boolean | null {
  if (!/\d{2}月\d{2}日 \d{2}時\d{2}分現在/.test(html)) return null;
  if (parseShigaDamData(html, new Date()).length > 0) return true;
  const cells = [...html.matchAll(/［(?:貯水位|流入量|放流量)］([^<]*)/g)].map((m) =>
    (m[1] ?? '').trim(),
  );
  if (cells.length === 0) return /分現在<br>\s*<hr>/.test(html) ? false : null;
  return cells.every((c) => c === '' || c === '*' || c === '-') ? false : null;
}

/** A station page's reading, its rows read against `now`. */
export function shigaReading(html: string, now: Date): Reading {
  const hasData = shigaPageHasData(html);
  if (hasData === null) return { state: 'unreadable', why: 'unrecognised station page' };
  if (!hasData) return { state: 'empty', mark: 'no rows, or 欠測 / 未観測 on every row' };
  return { state: 'values', observations: parseShigaDamData(html, now) };
}

/** Every listed station; its page is read through `fetchPage` once it is bound. */
export function shigaEntries(
  stations: Station[],
  fetchPage: (id: string) => Promise<string>,
  now: Date,
): Entry[] {
  return stations.map(
    (s): Entry => ({
      key: s.name,
      name: s.name,
      pref: PREF_CODE,
      bind: { exact: true },
      reading: async (dam) =>
        dam
          ? shigaReading(await fetchPage(s.id), now)
          : { state: 'unreadable', why: 'no master dam; page not read' },
    }),
  );
}

async function fetchShiftJis(url: string): Promise<string> {
  const r = await fetch(url, {
    headers: { 'user-agent': USER_AGENT },
    signal: AbortSignal.timeout(15_000),
  });
  if (r.status !== 200) throw new Error(`HTTP ${r.status} for ${url}`);
  return new TextDecoder('shift_jis').decode(await r.arrayBuffer());
}

export default ingestTask(SOURCE_ID, async (log) => {
  const stations = parseShigaStationList(
    await fetchShiftJis(`${BASE_URL}/mobile/dam/dam_select.php`),
  );
  log(`${SOURCE_ID}: ${stations.length} stations listed`);
  return {
    entries: shigaEntries(
      stations,
      (id) => fetchShiftJis(`${BASE_URL}/mobile/dam/dam_data.php?ID=${id}`),
      new Date(),
    ),
  };
});
