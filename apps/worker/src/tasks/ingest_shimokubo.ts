// apps/worker/src/tasks/ingest_shimokubo.ts
//
// 水資源機構 利根川上流総合管理所 下久保ダム — real-time data every 10 minutes.
// Fetched hourly.
//
//   下久保ダム (群馬/埼玉) — JWA-managed; utilization capacity 12,000 万m³
//
// Source: http://shimokubo.kannet.ne.jp/data/table.json
// Format: JSON with UTF-8-BOM; `update_time` in JST; `records[].datas[-1].data10`
//         holds the latest 10-min reading.  Storage in 千m³ → stored as m³ (×1000).
//         "―" / "-" is the feed's own "no value"; with it on both 貯水位 and
//         貯水量 the dam is provider-marked empty.
//
// Upgrades jwa-toneara (daily, priority 296) → hourly for 下久保ダム.
// Priority 297 > 296.

import { type Cell, cellState, MARKED, numberIn } from '../ingest/cells.ts';
import { ingestTask } from '../ingest/run.ts';
import type { Entry, Reading } from '../ingest/types.ts';

const DATA_URL = process.env.SHIMOKUBO_DATA_URL ?? 'http://shimokubo.kannet.ne.jp/data/table.json';

const SOURCE_ID = 'shimokubo';
/** The only dam this feed publishes; it carries no station id. */
const DAM_NAME = '下久保ダム';
/** 下久保 straddles 群馬/埼玉; ダム便覧 files it under 群馬, so search both. */
const PREF_CODES = ['10', '11'];

// --- types ------------------------------------------------------------------

interface Record10 {
  data10: string;
  data60: string;
}

interface DamRecord {
  name: string;
  datas: Record10[];
}

export interface ShimokuboJson {
  update_time: string;
  times: Array<{ time60: string; time10: string }>;
  records: DamRecord[];
}

// --- parsing ----------------------------------------------------------------

function parseCell(s: string | null): Cell {
  if (s == null) return null;
  const cleaned = s.replace(/[,\s　]/g, '');
  if (cleaned === '―' || cleaned === '-' || cleaned === '—') return MARKED;
  if (!cleaned) return null;
  const n = Number(cleaned);
  return Number.isFinite(n) ? n : null;
}

/** "YYYY/MM/DD HH:MM" JST → UTC Date */
export function parseShimokuboTimestamp(s: string): Date | null {
  const m = s.match(/^(\d{4})\/(\d{2})\/(\d{2})\s+(\d{1,2}):(\d{2})$/);
  if (!m) return null;
  const [yr, mo, dy, hr, mi] = m.slice(1, 6).map(Number) as [
    number,
    number,
    number,
    number,
    number,
  ];
  const d = new Date(Date.UTC(yr, mo - 1, dy, hr - 9, mi, 0, 0));
  return Number.isNaN(d.getTime()) ? null : d;
}

function latestData10(records: DamRecord[], name: string): string | null {
  const rec = records.find((r) => r.name === name);
  if (!rec || rec.datas.length === 0) return null;
  return rec.datas[rec.datas.length - 1]?.data10 ?? null;
}

export function shimokuboReading(json: ShimokuboJson): Reading {
  const observedAt = parseShimokuboTimestamp(json.update_time);
  if (!observedAt) return { state: 'unreadable', why: `update_time "${json.update_time}"` };

  const level = parseCell(latestData10(json.records, '下久保ダム貯水位'));
  const storageThou = parseCell(latestData10(json.records, '下久保ダム有効容量内貯水量'));
  const ratePct = numberIn(parseCell(latestData10(json.records, '下久保ダム有効容量内貯水率')));
  const inflow = parseCell(latestData10(json.records, '下久保ダム全流入量'));
  const outflow = parseCell(latestData10(json.records, '下久保ダム全放流量'));

  const state = cellState([level, storageThou]);
  if (state === 'empty') return { state, mark: '― on 貯水位 and 貯水量' };
  if (state === 'unreadable') return { state, why: 'no 貯水位 or 貯水量 figure' };
  const thou = numberIn(storageThou);
  return {
    state: 'values',
    observations: [
      {
        observedAt,
        waterLevelM: numberIn(level),
        storageVolumeM3: thou !== null ? thou * 1_000 : null,
        storageRate: ratePct !== null ? ratePct / 100 : null,
        inflowM3s: numberIn(inflow),
        outflowM3s: numberIn(outflow),
      },
    ],
  };
}

/** The one dam, read once the run reaches it: a failed fetch leaves it unreadable. */
export function shimokuboEntries(fetchJson: () => Promise<ShimokuboJson>): Entry[] {
  return [
    {
      key: DAM_NAME,
      name: DAM_NAME,
      pref: PREF_CODES,
      reading: async () => shimokuboReading(await fetchJson()),
    },
  ];
}

async function fetchJson(): Promise<ShimokuboJson> {
  const r = await fetch(DATA_URL, {
    headers: {
      'user-agent':
        process.env.HTTP_USER_AGENT ??
        'DamDataPlatform/0.1 (+https://dam.teraren.com/legal/terms; contact: https://discord.gg/UbWqspWbAk)',
    },
    signal: AbortSignal.timeout(20_000),
  });
  if (r.status !== 200) throw new Error(`HTTP ${r.status}`);
  // The file uses a UTF-8 BOM; strip it before parsing.
  const text = new TextDecoder('utf-8').decode(await r.arrayBuffer()).replace(/^\uFEFF/, '');
  return JSON.parse(text) as ShimokuboJson;
}

export default ingestTask(SOURCE_ID, async () => ({ entries: shimokuboEntries(fetchJson) }));
