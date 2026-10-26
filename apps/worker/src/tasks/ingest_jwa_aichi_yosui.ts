// apps/worker/src/tasks/ingest_jwa_aichi_yosui.ts
//
// 水資源機構 愛知用水総合管理所 水情報 — 牧尾ダム + 東郷調整池 (愛知池) + 前山池,
// daily 0時 JST 貯水位 / 貯水量 / 貯水率 (page updated ~10:00 JST).
//
// Source: https://www.water.go.jp/chubu/aityosui/b(jyouhou-main)/02(mizu)/00(top)/b-02.html
// Format: UTF-8 HTML (ホームページビルダー nested tables). One header
//         "YYYY年M月D日（曜）H時現在の状況をお知らせします" for the page;
//           牧尾ダム:  水位(標高) [m], 貯水量 [千m³], 貯水率 [%], 流入量, 放流量 [m³/s]
//                      — the two flows are the previous day's daily means, not
//                      0時 readings (放流量 6.42 on 9/27 = the 9/26 mean while
//                      every hourly feed read 0 at 0時), so they are not stored.
//           調整池表:  東郷調整池 | 前山池 columns of 貯水位 [m], 貯水量 [千m³],
//                      貯水率 [%]
//         貯水率 is 貯水量 / 有効貯水量 (page footnote: 東郷 9,000 / 前山 972
//         千m³; 牧尾 68,000), i.e. the static capacity — not a trusted basis.
//         The page is outside the 中部支社 リアルタイム system (/mizu/chubu/),
//         whose description.pdf asks users not to collect with tools.
// License: 愛知用水総合管理所 サイトポリシー「著作権について」— 私的使用または
//         引用等、著作権法上認められた行為を除き無断転載不可; 引用時は出所明示.
//         水資源機構「著作権・リンク等について」(honsya/policy/copyright): 数値データ、
//         簡単な表・グラフ等は著作権の対象ではなく自由に利用できる. Only the
//         observed numbers are stored, with the source named.
//
// 東郷調整池 and 前山 have no other live source. 牧尾 is here because the page
// publishes it; priority 294 keeps it below every other 牧尾 feed (aitoyo 295,
// jwa-chubu 296, jwa-kiso-rt 297, kasenbosai 310) and above jwa-junpo 290.

import { type Cell, cell, cellState, MARKED, numberIn } from '../ingest/cells.ts';
import { ingestTask } from '../ingest/run.ts';
import type { Bind, Entry, Reading } from '../ingest/types.ts';

const PAGE_URL =
  process.env.JWA_AICHI_YOSUI_URL ??
  'https://www.water.go.jp/chubu/aityosui/b(jyouhou-main)/02(mizu)/00(top)/b-02.html';

const SOURCE_ID = 'jwa-aichi-yosui';

// The page's whole station list. 前山池 is ダム便覧's 前山 (常滑市, ダム湖名
// 前山池, 目的「愛知用水の調整池」, 有効 972 千m³ — the page's own footnote).
const STATIONS: ReadonlyArray<{ name: string; prefCode: string; bind?: Bind }> = [
  { name: '牧尾ダム', prefCode: '20' }, // 長野 (木曽郡王滝村)
  { name: '東郷調整池', prefCode: '23' },
  { name: '前山池', prefCode: '23', bind: { name: '前山' } },
];

export interface ParsedRow {
  name: string;
  waterLevelM: Cell;
  storageVolumeM3: Cell;
  storageRate: Cell;
}

/** Cell text → number; 欠測 is the page's own mark; blank / other text → null. */
function readCell(s: string | undefined, unit: (n: number) => number = (n) => n): Cell {
  const cleaned = (s ?? '').replace(/,/g, '');
  if (cleaned === '欠測') return MARKED;
  if (!cleaned) return null;
  return cell(unit(Number(cleaned)), false);
}

const thousandM3 = (n: number): number => n * 1000;
const percent = (n: number): number => n / 100;

// Every cell value is one whitespace-free token once tags are flattened.
const V = '(\\S+)';
const THOUSAND_M3 = '千 ?m ?3';
const MAKIO_RE = new RegExp(
  `牧尾ダム .*?水位 \\(標高\\) ${V} m 貯水量 ${V} ${THOUSAND_M3} 貯水率 ${V} [％%]`,
);
const PONDS_RE = new RegExp(
  `東郷調整池 前 ?山 ?池 貯水位 ${V} m ${V} m 貯水量 ${V} ${THOUSAND_M3} ${V} ${THOUSAND_M3} ` +
    `貯水率 ${V} [％%] ${V} [％%]`,
);

export function parseAichiYosuiPage(html: string): {
  observedAt: Date | null;
  rows: ParsedRow[];
} {
  const text = html
    .replace(/<(script|style)[\s\S]*?<\/\1>/gi, ' ')
    .replace(/<!--[\s\S]*?-->/g, ' ')
    .replace(/<[^>]*>/g, ' ')
    .replace(/&nbsp;/g, ' ')
    .replace(/[\s　]+/g, ' ');

  // "2026 年 9 月 27 日 日 0 時現在" — the token after 日 is the weekday.
  const t = text.match(/(\d{4}) 年 (\d{1,2}) 月 (\d{1,2}) 日 (?:\S )?(\d{1,2}) 時現在/);
  if (!t) return { observedAt: null, rows: [] };
  // JST → UTC; Date.UTC normalises the negative hour into the previous day.
  const observedAt = new Date(
    Date.UTC(Number(t[1]), Number(t[2]) - 1, Number(t[3]), Number(t[4]) - 9),
  );

  const rows: ParsedRow[] = [];
  const makio = text.match(MAKIO_RE);
  if (makio) {
    rows.push({
      name: '牧尾ダム',
      waterLevelM: readCell(makio[1]),
      storageVolumeM3: readCell(makio[2], thousandM3),
      storageRate: readCell(makio[3], percent),
    });
  }
  const ponds = text.match(PONDS_RE);
  if (ponds) {
    rows.push(
      {
        name: '東郷調整池',
        waterLevelM: readCell(ponds[1]),
        storageVolumeM3: readCell(ponds[3], thousandM3),
        storageRate: readCell(ponds[5], percent),
      },
      {
        name: '前山池',
        waterLevelM: readCell(ponds[2]),
        storageVolumeM3: readCell(ponds[4], thousandM3),
        storageRate: readCell(ponds[6], percent),
      },
    );
  }
  return { observedAt, rows };
}

function rowReading(row: ParsedRow, observedAt: Date): Reading {
  const state = cellState([row.waterLevelM, row.storageVolumeM3, row.storageRate]);
  if (state === 'empty') return { state, mark: '欠測 in every column' };
  if (state === 'unreadable') return { state, why: `no value parsed for ${row.name}` };
  return {
    state: 'values',
    observations: [
      {
        observedAt,
        waterLevelM: numberIn(row.waterLevelM),
        storageVolumeM3: numberIn(row.storageVolumeM3),
        storageRate: numberIn(row.storageRate),
        // 牧尾's printed flows are previous-day means, not 0時 values: not stored.
      },
    ],
  };
}

type Page = { html: string } | { failed: string };

function pageReadings(page: Page): (name: string) => Reading {
  if ('failed' in page) return () => ({ state: 'unreadable', why: page.failed });
  const { observedAt, rows } = parseAichiYosuiPage(page.html);
  if (!observedAt) return () => ({ state: 'unreadable', why: 'no 「…時現在」 header' });
  return (name) => {
    const row = rows.find((r) => r.name === name);
    return row
      ? rowReading(row, observedAt)
      : { state: 'unreadable', why: `no ${name} table on the page` };
  };
}

/**
 * Every station on the page, known in advance: a page that failed to load or
 * parse leaves them unreadable, never unlisted.
 */
export function aichiYosuiEntries(page: Page): Entry[] {
  const readingOf = pageReadings(page);
  return STATIONS.map((s) => ({
    key: s.name,
    name: s.name,
    pref: s.prefCode,
    ...(s.bind && { bind: s.bind }),
    reading: readingOf(s.name),
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
  return { entries: aichiYosuiEntries(page) };
});
