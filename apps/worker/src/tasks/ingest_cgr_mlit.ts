// apps/worker/src/tasks/ingest_cgr_mlit.ts
//
// Tenth real-observation source. 国土交通省 中国地方整備局 publishes a
// consolidated dam dashboard for its 11 国管理 dams at:
//   www.cgr.mlit.go.jp/cginfo/syokai/busyo/kasen/dam_bousai/
//
// The dashboard's data API is a single POST returning one JSON blob with
// current values for every dam:
//   cgi-bin/index_table.php
//
// Coverage (11 dams across 5 prefectures):
//   岡山(33): 苫田
//   広島(34): 土師, 弥栄, 八田原, 温井, 灰塚
//   山口(35): 島地川
//   鳥取(31): 菅沢, 殿
//   島根(32): 志津見, 尾原
//
// Response shape:
//   { time: "YYYY年MM月DD日 HH時MM分",
//     status: { "<id>": { name, param }, ... },
//     table:  { header, kind,
//               data: { ryunyu, houryu, chosuii, risui, chisui, uryou, ruika } } }
// Each `data.<metric>.<id>` is a string (numeric) or "ー" for missing; "ー"
// (or 欠測) in every stored column is provider-marked empty. The 11 dams are
// known in advance, so a failed fetch leaves all 11 unreadable rather than
// unlisted.

import { type Cell, cellState, MARKED, numberIn } from '../ingest/cells.ts';
import { ingestTask } from '../ingest/run.ts';
import type { Entry, Reading } from '../ingest/types.ts';

const API_URL =
  process.env.CGR_MLIT_DAM_URL ??
  'http://www.cgr.mlit.go.jp/cginfo/syokai/busyo/kasen/dam_bousai/cgi-bin/index_table.php';

interface DamCfg {
  /** API id (1..11). */
  apiId: string;
  /** Name as it appears in the JSON `status.<id>.name`. */
  apiName: string;
  /** Prefecture (JIS code). */
  prefCode: string;
}

const DAMS: DamCfg[] = [
  { apiId: '1', apiName: '菅沢ダム', prefCode: '31' },
  { apiId: '2', apiName: '土師ダム', prefCode: '34' },
  { apiId: '3', apiName: '島地川ダム', prefCode: '35' },
  { apiId: '4', apiName: '弥栄ダム', prefCode: '34' },
  { apiId: '5', apiName: '八田原ダム', prefCode: '34' },
  { apiId: '6', apiName: '温井ダム', prefCode: '34' },
  { apiId: '7', apiName: '苫田ダム', prefCode: '33' },
  { apiId: '8', apiName: '灰塚ダム', prefCode: '34' },
  { apiId: '9', apiName: '志津見ダム', prefCode: '32' },
  { apiId: '10', apiName: '尾原ダム', prefCode: '32' },
  { apiId: '11', apiName: '殿ダム', prefCode: '31' },
];
/** Where a dam the dashboard adds would be: the five prefectures it covers. */
const PREF_CODES = [...new Set(DAMS.map((d) => d.prefCode))];

const SOURCE_ID = 'cgr-mlit-dam';

interface ApiData {
  ryunyu: Record<string, string>;
  houryu: Record<string, string>;
  chosuii: Record<string, string>;
  risui: Record<string, string>;
  chisui: Record<string, string>;
  uryou: Record<string, string>;
  ruika: Record<string, string>;
}
export interface ApiResponse {
  time?: string;
  status?: Record<string, { name: string; param: number }>;
  table?: { data: ApiData };
}

/** "ー" is the dashboard's own "no value"; anything else non-numeric is unread. */
function parseCell(s: string | undefined): Cell {
  if (s == null) return null;
  const t = s.replace(/[,\s　]/g, '');
  if (t === 'ー' || t === '−' || t === '欠測' || t === '-') return MARKED;
  if (!t) return null;
  const n = Number(t);
  return Number.isFinite(n) ? n : null;
}

/** Parse "2026年05月18日 14時30分" (JST) → UTC Date. */
export function parseCgrTimestamp(raw: string): Date | null {
  const m = raw.match(/(\d{4})年(\d{1,2})月(\d{1,2})日\s*(\d{1,2})時(\d{1,2})分/);
  if (!m) return null;
  return new Date(
    Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3]), Number(m[4]) - 9, Number(m[5]), 0, 0),
  );
}

function damReading(data: ApiData, id: string, observedAt: Date): Reading {
  const inflow = parseCell(data.ryunyu?.[id]);
  const outflow = parseCell(data.houryu?.[id]);
  const level = parseCell(data.chosuii?.[id]);
  // risui is 貯水率(利水容量) — matches this site's own 貯水率 definition
  // (storage_volume_m3 / active_capacity_m3, 利水容量). Falls back to chisui
  // (貯水率(有効容量)) only for dams that don't report a 利水容量 figure.
  // Previously this always read chisui, which understates dams whose
  // 利水容量 is much smaller than their 有効貯水容量 during flood season
  // (e.g. 八田原ダム: chisui≈39%, risui≈97% — see issue #17).
  const risui = parseCell(data.risui?.[id]);
  const chisui = parseCell(data.chisui?.[id]);
  const rate: Cell =
    typeof risui === 'number'
      ? risui
      : typeof chisui === 'number'
        ? chisui
        : risui === MARKED && chisui === MARKED
          ? MARKED
          : null;
  const rain = parseCell(data.uryou?.[id]);

  const state = cellState([inflow, outflow, level, rate]);
  if (state === 'empty') return { state, mark: 'ー in every column' };
  if (state === 'unreadable') return { state, why: 'no numeric column' };
  const ratePct = numberIn(rate);
  return {
    state: 'values',
    observations: [
      {
        observedAt,
        storageRate: ratePct != null ? ratePct / 100 : null,
        inflowM3s: numberIn(inflow),
        outflowM3s: numberIn(outflow),
        waterLevelM: numberIn(level),
        rainfallMm: numberIn(rain),
      },
    ],
  };
}

/**
 * The 11 configured dams plus any id the dashboard's `status` adds; with no
 * payload (a failed fetch, a non-JSON body) every configured dam is
 * unreadable with the reason.
 */
export function cgrEntries(payload: ApiResponse | { error: string }): Entry[] {
  let read: (id: string) => Reading;
  let status: NonNullable<ApiResponse['status']> = {};
  if ('error' in payload) {
    read = () => ({ state: 'unreadable', why: payload.error });
  } else {
    const observedAt = parseCgrTimestamp(payload.time ?? '');
    const data = payload.table?.data;
    status = payload.status ?? {};
    if (!observedAt) {
      read = () => ({ state: 'unreadable', why: `could not parse time '${payload.time}'` });
    } else if (!data) {
      read = () => ({ state: 'unreadable', why: 'missing table.data' });
    } else {
      read = (id) => damReading(data, id, observedAt);
    }
  }

  const entries: Entry[] = DAMS.map((c) => ({
    key: c.apiId,
    name: c.apiName,
    pref: c.prefCode,
    reading: read(c.apiId),
  }));
  for (const [id, s] of Object.entries(status)) {
    if (DAMS.some((c) => c.apiId === id)) continue;
    entries.push({ key: id, name: s.name || id, pref: PREF_CODES, reading: read(id) });
  }
  return entries;
}

async function fetchPayload(): Promise<ApiResponse | { error: string }> {
  try {
    const r = await fetch(API_URL, {
      method: 'POST',
      headers: {
        'user-agent':
          process.env.HTTP_USER_AGENT ??
          'DamDataPlatform/0.1 (+https://dam.teraren.com/legal/terms; contact: https://discord.gg/UbWqspWbAk)',
        'content-type': 'application/json',
        'content-length': '0',
        referer: 'http://www.cgr.mlit.go.jp/cginfo/syokai/busyo/kasen/dam_bousai/index.php',
      },
      body: '',
      signal: AbortSignal.timeout(12_000),
    });
    if (r.status !== 200) return { error: `HTTP ${r.status}` };
    const text = await r.text();
    try {
      return JSON.parse(text) as ApiResponse;
    } catch {
      return { error: `JSON parse failed (got ${text.slice(0, 80)})` };
    }
  } catch (err) {
    return { error: err instanceof Error ? err.message : String(err) };
  }
}

export default ingestTask(SOURCE_ID, async () => ({ entries: cgrEntries(await fetchPayload()) }));
