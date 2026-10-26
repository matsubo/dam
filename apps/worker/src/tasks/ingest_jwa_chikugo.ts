// apps/worker/src/tasks/ingest_jwa_chikugo.ts
//
// Fourth real-observation source. 水資源機構 筑後川ダム統合管理事務所
// publishes a 0時 reading for the 筑後川 system dams once per business day:
//
//   松原 (国交省), 下筌 (国交省), 大山 (JWA), 合所 (福岡県),
//   江川 (JWA), 寺内 (JWA), 小石原川 (JWA) — 7 dams total.
//
// 大山 / 江川 / 寺内 / 小石原川 overlap with jwa-junpo but here we get
// DAILY cadence (vs 10-day). 松原 / 下筌 / 合所 are NEW vs all prior
// sources.
//
// Source: https://www.water.go.jp/chikugo/chikugo/water-source.html
// Format: static HTML, dated in its heading: 水源情報【令和8年9月25日】 — the
// day whose 0時 the blocks below report. Rows are stamped with that date, not
// the fetch date: the page is "閉庁日を除き毎日更新", so on weekends and
// holidays it keeps the last business day's edition, and on business days it
// is often not out yet at the 10:00 JST run. Two block patterns:
//   (A) <div class="ws_title">{name}ダム</div>
//       <div class="storage_rate">■貯水率　<span>NN.N%</span></div>
//       <div class="ws_data"><table>...<td>NN千m³</td>...</table></div>
//   (B) Inside the 「3ダム合計」 box, three <div class="sandam_title">
//       blocks with a single-row <table> carrying 貯水率 / 貯水位 / 貯水量.
// License: 水資源機構 published; 出典明示で再配布可.

import { ingestTask } from '../ingest/run.ts';
import type { Entry, Reading } from '../ingest/types.ts';

const PAGE_URL =
  process.env.JWA_CHIKUGO_URL ?? 'https://www.water.go.jp/chikugo/chikugo/water-source.html';

const SOURCE_ID = 'jwa-chikugo';

// The page's whole dam list. A multi-code entry (下筌 is on the 熊本/大分
// border) is a lookup scope, not an attribution.
const NAME_MAP: ReadonlyArray<{ chikugoName: string; pref: string | readonly string[] }> = [
  // Pattern-A blocks (top-level ws_box):
  { chikugoName: '松原ダム', pref: '44' }, // 大分
  { chikugoName: '下筌ダム', pref: ['43', '44'] }, // 熊本/大分
  { chikugoName: '大山ダム', pref: '44' },
  { chikugoName: '合所ダム', pref: '40' }, // 福岡
  // Pattern-B blocks (inside 3ダム合計):
  { chikugoName: '江川ダム', pref: '40' },
  { chikugoName: '寺内ダム', pref: '40' },
  { chikugoName: '小石原川ダム', pref: '40' },
];

export interface ParsedRow {
  chikugoName: string;
  storageRatePct: number;
  storageVolumeThouM3: number;
}

function textOf(s: string): string {
  return s
    .replace(/<[^>]*>/g, '')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&nbsp;/g, ' ')
    .replace(/　/g, ' ')
    .trim();
}

function parseNum(s: string): number | null {
  const cleaned = s.replace(/[,\s　%千m³]/g, '');
  if (!cleaned || cleaned === '―' || cleaned === '-') return null;
  const n = Number(cleaned);
  return Number.isFinite(n) ? n : null;
}

export interface ParsedPage {
  /** 0時 JST of the date in the page heading. */
  observedAt: Date;
  rows: ParsedRow[];
}

/** Null when the page carries no dated 水源情報 heading. */
export function parseJwaChikugoHtml(html: string): ParsedPage | null {
  const date = html.match(/水源情報【令和(元|\d+)年(\d{1,2})月(\d{1,2})日】/);
  if (!date) return null;
  const year = 2018 + (date[1] === '元' ? 1 : Number(date[1]));
  // JST → UTC
  const observedAt = new Date(Date.UTC(year, Number(date[2]) - 1, Number(date[3]), -9));

  const out: ParsedRow[] = [];
  const knownNames = new Set(NAME_MAP.map((m) => m.chikugoName));

  // Pattern A: each ws_box that has ws_title + storage_rate + ws_data.
  // The regex captures the title, the rate div, and the data table block;
  // we then pluck dam name from title (strip everything after the first
  // 「ダム」, then add 「ダム」 back) and pull the numbers out.
  const aRe =
    /<div class="ws_title">([^<]+)<[\s\S]*?<div class="storage_rate">[\s\S]*?<span[^>]*><!--\([^)]*\)-->\s*([\d.]+)%[\s\S]*?<div class="ws_data">([\s\S]*?)<\/div>/g;
  let m: RegExpExecArray | null;
  // biome-ignore lint/suspicious/noAssignInExpressions: idiomatic regex iteration
  while ((m = aRe.exec(html)) !== null) {
    const rawTitle = textOf(m[1] ?? '');
    const ratePct = Number(m[2]);
    const dataBlock = m[3] ?? '';
    // Title is e.g. "松原ダム（国交省）０時" — extract up to ダム inclusive.
    const nameMatch = rawTitle.match(/^[^（(\s]+ダム/);
    const name = nameMatch?.[0];
    if (!name || !knownNames.has(name)) continue;
    if (!Number.isFinite(ratePct)) continue;
    // 貯水量 from the data block — first 千m³ number inside a <td>.
    const volMatch = dataBlock.match(/<td[^>]*>[\s\S]*?<!--\([^)]*\)-->\s*([\d,]+)千m/);
    const vol = volMatch ? parseNum(volMatch[1] ?? '') : null;
    if (vol == null) continue;
    out.push({ chikugoName: name, storageRatePct: ratePct, storageVolumeThouM3: vol });
  }

  // Pattern B: each sandam_title followed by a <table> with one tbody row
  // of three <td>s (rate / level / volume).
  const bRe =
    /<div class="sandam_title">([^<]+)<\/div>[\s\S]*?<tbody>[\s\S]*?<tr>\s*<td[^>]*>[\s\S]*?<!--\([^)]*\)-->\s*([\d.]+)%[\s\S]*?<td[^>]*>[\s\S]*?<\/td>\s*<td[^>]*>[\s\S]*?<!--\([^)]*\)-->\s*([\d,]+)千m/g;
  // biome-ignore lint/suspicious/noAssignInExpressions: idiomatic regex iteration
  while ((m = bRe.exec(html)) !== null) {
    const rawTitle = textOf(m[1] ?? '');
    const ratePct = Number(m[2]);
    const vol = parseNum(m[3] ?? '');
    const nameMatch = rawTitle.match(/^[^（(\s]+ダム/);
    const name = nameMatch?.[0];
    if (!name || !knownNames.has(name)) continue;
    if (!Number.isFinite(ratePct) || vol == null) continue;
    // Skip if pattern-A already produced this row (shouldn't happen, but be safe).
    if (out.some((r) => r.chikugoName === name)) continue;
    out.push({ chikugoName: name, storageRatePct: ratePct, storageVolumeThouM3: vol });
  }

  return { observedAt, rows: out };
}

type Page = { html: string } | { failed: string };

function pageReadings(page: Page): (chikugoName: string) => Reading {
  if ('failed' in page) return () => ({ state: 'unreadable', why: page.failed });
  const parsed = parseJwaChikugoHtml(page.html);
  if (!parsed) return () => ({ state: 'unreadable', why: 'no dated 水源情報 heading on the page' });
  const { observedAt, rows } = parsed;
  return (chikugoName) => {
    const row = rows.find((r) => r.chikugoName === chikugoName);
    if (!row)
      return { state: 'unreadable', why: `no 貯水率/貯水量 block parsed for ${chikugoName}` };
    return {
      state: 'values',
      observations: [
        {
          observedAt,
          storageVolumeM3: row.storageVolumeThouM3 * 1_000,
          storageRate: Math.max(0, Math.min(1, row.storageRatePct / 100)),
        },
      ],
    };
  };
}

/** Every dam on the page, known in advance: a page that failed leaves them unreadable, never unlisted. */
export function jwaChikugoEntries(page: Page): Entry[] {
  const readingOf = pageReadings(page);
  return NAME_MAP.map((m) => ({
    key: m.chikugoName,
    name: m.chikugoName,
    pref: m.pref,
    reading: readingOf(m.chikugoName),
  }));
}

async function fetchPage(): Promise<Page> {
  try {
    const r = await fetch(PAGE_URL, {
      headers: {
        'user-agent':
          process.env.HTTP_USER_AGENT ??
          'DamDataPlatform/0.1 (+https://dam.teraren.com/legal/terms; contact: https://discord.gg/UbWqspWbAk)',
      },
      signal: AbortSignal.timeout(20_000),
    });
    if (r.status !== 200) return { failed: `HTTP ${r.status} for ${PAGE_URL}` };
    return { html: await r.text() };
  } catch (err) {
    return { failed: err instanceof Error ? err.message : String(err) };
  }
}

export default ingestTask(SOURCE_ID, async (log) => {
  const page = await fetchPage();
  if ('failed' in page) log(`${SOURCE_ID}: ${page.failed}`);
  return { entries: jwaChikugoEntries(page) };
});
