// apps/worker/src/tasks/ingest_miyagi_nousei.ts
//
// 宮城県 農政部 農村振興課「農業用水の状況」— 県内主要ダム 17 基 + 主要ため池 9 か所。
//
// Source:
//   https://www.pref.miyagi.jp/soshiki/nosonshin/yousui.html
// The index lists one page per survey (「令和8年9月15日現在」→ yousui08-0915.html,
// but the slug is not reliable: 令和8年2月2日 is yousui07-0202.html), and each
// page links one PDF under /documents/. Both hops are discovered, never pinned.
//
// Distinct from `miyagi-kasen` (土木部・河川, hourly): that feed carries the
// 県管理 river dams; this one adds the agricultural set it does not publish —
// 菅生/宿の沢/村田 and the ため池 table (牛野/愛子/嘉太神/川原子/孫沢) — plus
// 東北農政局's 岩堂沢/二ツ石, which #13 had filed as unreachable.
//
// Format: PDF, 2 pages. unpdf's reading-order text scatters the dam table
// (names and figures come out hundreds of lines apart), so the text items are
// rebuilt into lines by their y position — the same thing `pdftotext -layout`
// does — and parsed per line:
//   dam table (page 1), two lines per dam:
//     栗駒ダム 三迫川 EL 190.00m EL 188.67m … EL 185.16m    ← 満水位 / 現在 / 平年
//     (S37.3) 3,079 3,655 3,152 86.2% ↓ 5.85 4.16 2,003 157.3%
//             かんがい面積 利水容量 現貯水量 貯水率 傾向 流入 放流 平年 平年比
//   ため池 table (page 2), one line each:
//     愛子ダム 広瀬川（斉勝川） 仙台市 536 1,080.0 824.0 76.3% 52.0% 146.9% ↓
//              河川 市町村 受益面積 満水貯水量 現在貯水量 貯水率 平年率 平年比
// Volumes are 千m³. The survey is 午前9時 on the 現在 date (JST).
//
// Rate: printed as 現在貯水量 / 利水容量 (ため池: / 満水貯水量) from the same row
// and clamped at 100 % (「貯水率が100%を超えるときは、100%として表記」), so every
// row carries its own denominator. A row that fails that identity is a misread
// and is unreadable. trusted_rate_basis is set by migration 0097 on that evidence.
//
// Cadence: 1日・15日 in かんがい期, monthly otherwise. Priority 286 — below
// miyagi-kasen (308) and kasenbosai (310), which carry 14 of the 17 dams hourly
// and must keep winning them; above fukushima-nourin (285) only by
// convention — no dam is shared with it.

import { getDocumentProxy } from 'unpdf';
import { ingestTask } from '../ingest/run.ts';
import type { Entry, Observed, Reading } from '../ingest/types.ts';

const INDEX_URL =
  process.env.MIYAGI_NOUSEI_URL ?? 'https://www.pref.miyagi.jp/soshiki/nosonshin/yousui.html';

const ORIGIN = 'https://www.pref.miyagi.jp';
const PREF_CODE = '04';
const SOURCE_ID = 'miyagi-nousei';

/** Rate tolerance between the printed 貯水率 and volume / capacity, in points. */
const RATE_TOLERANCE_PCT = 1.5;

// --- PDF → lines --------------------------------------------------------------

/**
 * The PDF's text rebuilt into visual lines: items sharing a baseline (within
 * 2 pt) joined left to right with a space, top to bottom, page by page.
 */
export async function pdfToLines(bytes: Uint8Array): Promise<string[]> {
  const pdf = await getDocumentProxy(bytes);
  const out: string[] = [];
  for (let p = 1; p <= pdf.numPages; p++) {
    const content = await (await pdf.getPage(p)).getTextContent();
    const lines: { y: number; items: { x: number; s: string }[] }[] = [];
    for (const item of content.items) {
      if (!('str' in item) || !item.str.trim()) continue;
      const x = item.transform[4] as number;
      const y = item.transform[5] as number;
      const line = lines.find((l) => Math.abs(l.y - y) <= 2);
      if (line) line.items.push({ x, s: item.str });
      else lines.push({ y, items: [{ x, s: item.str }] });
    }
    lines.sort((a, b) => b.y - a.y);
    for (const l of lines) {
      out.push(
        l.items
          .sort((a, b) => a.x - b.x)
          .map((i) => i.s.trim())
          .join(' '),
      );
    }
  }
  return out;
}

// --- parsing ----------------------------------------------------------------

/** 「3,655」→ 3655; markers (－, #REF!) and prose → null. */
function parseNum(s: string | undefined): number | null {
  const t = (s ?? '').replace(/,/g, '');
  if (!/^-?\d+(?:\.\d+)?$/.test(t)) return null;
  return Number(t);
}

/**
 * capacity / volume / rate read around the first 「NN.N%」 token, which is
 * 貯水率 in both tables (the dam table's stray 「(82.1%)」 cell is on the
 * other line and parenthesised). A string saying why unless the three agree.
 */
function readStorage(
  tokens: string[],
): { storageVolumeM3: number; storageRate: number; at: number } | string {
  const at = tokens.findIndex((t) => /^\d+(?:\.\d+)?%$/.test(t));
  if (at < 2) return 'no 貯水率 after two figures';
  const capacity = parseNum(tokens[at - 2]);
  const volume = parseNum(tokens[at - 1]);
  const pct = Number(tokens[at]?.slice(0, -1));
  if (capacity == null || volume == null || capacity <= 0) {
    return `capacity 「${tokens[at - 2]}」 volume 「${tokens[at - 1]}」`;
  }
  // A 0 % agricultural reservoir is drained or out of survey — storing it
  // would recreate the phantom zeros migrations 0038/0039 had to undo.
  if (!(pct > 0 && pct <= 100)) return `貯水率 ${pct} % is not an operating reading`;
  const implied = (100 * volume) / capacity;
  const clamped = pct === 100 && implied >= 100;
  if (!clamped && Math.abs(implied - pct) > RATE_TOLERANCE_PCT) {
    return `printed ${pct} % is not ${volume}/${capacity}`;
  }
  return { storageVolumeM3: volume * 1000, storageRate: pct / 100, at };
}

const FULLWIDTH_DIGIT = /[０-９]/g;

/** 「（令和８年９月１５日現在）」 → 09:00 JST that day, the PDF's survey time. */
export function parseMiyagiNouseiDate(text: string): Date | null {
  const normalized = text.replace(FULLWIDTH_DIGIT, (c) =>
    String.fromCharCode(c.charCodeAt(0) - 0xfee0),
  );
  const m = normalized.match(/令和\s*(\d+)\s*年\s*(\d+)\s*月\s*(\d+)\s*日\s*現在/);
  if (!m) return null;
  const d = new Date(Date.UTC(2018 + Number(m[1]), Number(m[2]) - 1, Number(m[3]), 0, 0, 0));
  return Number.isNaN(d.getTime()) ? null : d;
}

const DAM_NAME_RE = /^(\S+(?:ダム|溜池|ため池))$/;
const ERA_RE = /^\([SHR]\d+\.\d+\)$/;

/** One dam or ため池 the PDF lists, and what we read from it. */
export interface MiyagiRow {
  /** Name exactly as the PDF prints it — also the stamp and universe key. */
  name: string;
  reading: Reading;
}

export function parseMiyagiNouseiLines(lines: string[]): {
  reportDate: Date | null;
  rows: MiyagiRow[];
} {
  const reportDate = parseMiyagiNouseiDate(lines.join('\n'));
  const rows: MiyagiRow[] = [];
  const read = (
    storage: ReturnType<typeof readStorage>,
    extra: Omit<Observed, 'observedAt' | 'storageVolumeM3' | 'storageRate'>,
  ): Reading => {
    if (typeof storage === 'string') return { state: 'unreadable', why: storage };
    if (!reportDate) return { state: 'unreadable', why: 'no 「…現在」 survey date in the PDF' };
    return {
      state: 'values',
      observations: [
        {
          observedAt: reportDate,
          storageVolumeM3: storage.storageVolumeM3,
          storageRate: storage.storageRate,
          ...extra,
        },
      ],
    };
  };

  // A dam's first line (name + levels) waits here for its figures line.
  let pending: { row: MiyagiRow; level: number | null } | null = null;
  let section: 'none' | 'dam' | 'pond' = 'none';

  for (const line of lines) {
    if (/県内主要ダムの貯水状況/.test(line) && !line.startsWith('◆')) section = 'dam';
    else if (/県内主要ため池の貯水状況/.test(line) && !line.startsWith('◆')) section = 'pond';
    else if (/^計\s*\(\d+\)|施設\s*計/.test(line)) section = 'none';
    if (section === 'none') continue;

    const tokens = line.split(/\s+/);
    const name = tokens[0]?.match(DAM_NAME_RE)?.[1];

    if (section === 'dam') {
      if (name && /EL\s*[\d.]+m/.test(line)) {
        // 満水位, 現在の水位, 平年の水位 — in column order.
        const levels = [...line.matchAll(/EL\s*([\d.]+)m/g)].map((m) => Number(m[1]));
        const row: MiyagiRow = {
          name,
          reading: { state: 'unreadable', why: 'no figures line under the name' },
        };
        rows.push(row);
        pending = { row, level: levels[1] ?? null };
        continue;
      }
      if (pending && ERA_RE.test(tokens[0] ?? '')) {
        const storage = readStorage(tokens);
        // After 貯水率: an optional 傾向 arrow, then 流入量 and 放流量.
        const after =
          typeof storage === 'string'
            ? []
            : tokens.slice(storage.at + 1).filter((t) => !/^[↑↓→]$/.test(t));
        pending.row.reading = read(storage, {
          waterLevelM: pending.level,
          inflowM3s: parseNum(after[0]),
          outflowM3s: parseNum(after[1]),
        });
        pending = null;
      }
      continue;
    }

    // ため池 table: everything is on the name's own line.
    if (!name || !line.includes('%')) continue;
    rows.push({ name, reading: read(readStorage(tokens), {}) });
  }

  return { reportDate, rows };
}

// --- discovery --------------------------------------------------------------

/**
 * The newest survey page on the index, chosen by the 令和 date in its link
 * text — the slugs are not dependable (令和8年2月2日 lives at yousui07-0202)
 * and the list order is the CMS's, not a contract.
 */
export function findLatestReportUrl(html: string): string | null {
  let best: { href: string; date: Date } | null = null;
  for (const m of html.matchAll(
    /<a[^>]+href="([^"]*\/nosonshin\/[^"]+\.html)"[^>]*>([^<]*)<\/a>/g,
  )) {
    const date = parseMiyagiNouseiDate(m[2] ?? '');
    if (date && (!best || date > best.date)) best = { href: m[1] as string, date };
  }
  if (!best) return null;
  return best.href.startsWith('http') ? best.href : `${ORIGIN}${best.href}`;
}

/** The report PDF linked from a survey page. */
export function findReportPdfUrl(html: string): string | null {
  const m = html.match(/href="([^"]*\/documents\/[^"]+\.pdf)"/);
  if (!m?.[1]) return null;
  return m[1].startsWith('http') ? m[1] : `${ORIGIN}${m[1]}`;
}

// --- entries ----------------------------------------------------------------

/** Every dam and ため池 the PDF lists, in print order. */
export function miyagiNouseiEntries(lines: string[]): Entry[] {
  return parseMiyagiNouseiLines(lines).rows.map((r) => ({
    key: r.name,
    name: r.name,
    pref: PREF_CODE,
    reading: r.reading,
  }));
}

async function fetchOk(url: string, timeoutMs: number): Promise<Response> {
  const res = await fetch(url, {
    headers: {
      'user-agent':
        process.env.HTTP_USER_AGENT ??
        'DamDataPlatform/0.1 (+https://dam.teraren.com/legal/terms; contact: https://discord.gg/UbWqspWbAk)',
    },
    signal: AbortSignal.timeout(timeoutMs),
  });
  if (res.status !== 200) throw new Error(`${SOURCE_ID}: HTTP ${res.status} for ${url}`);
  return res;
}

// Positional line rebuilding is what a layout change breaks first; a run that
// finds names but no figures reads every entry as unreadable, and the run
// fails the job instead of exiting green.
export default ingestTask(SOURCE_ID, async (log) => {
  const reportUrl = findLatestReportUrl(await (await fetchOk(INDEX_URL, 20_000)).text());
  if (!reportUrl) throw new Error(`${SOURCE_ID}: no survey page linked from ${INDEX_URL}`);
  const pdfUrl = findReportPdfUrl(await (await fetchOk(reportUrl, 20_000)).text());
  if (!pdfUrl) throw new Error(`${SOURCE_ID}: no PDF on ${reportUrl}`);
  const pdf = await fetchOk(pdfUrl, 30_000);
  const entries = miyagiNouseiEntries(await pdfToLines(new Uint8Array(await pdf.arrayBuffer())));
  log(`${SOURCE_ID}: ${entries.length} rows in ${pdfUrl}`);
  return { entries, dated: true };
});
