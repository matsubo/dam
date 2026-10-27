// apps/worker/src/tasks/ingest_qsr_ryumon.ts
//
// 国土交通省 九州地方整備局 竜門ダム管理所 — 1 国管理ダム (佐田川水系).
//
//   竜門ダム (Fukuoka/40)
//
// Source: individual PHP key-value endpoints:
//   https://www.qsr.mlit.go.jp/ryumon/bousai/kkc_out/ryumon/data.php?key=<key>
//
// Keys and response format (plain text, e.g. "5.83m3/s", "265.10m"):
//   dam_ryunyu     → 全流入量 m³/s       ("N.NNm3/s")
//   dam_houryu     → 全放流量 m³/s       ("N.NNm3/s")
//   dam_chosuiryo  → 貯水量 千m³         ("N,NNN.NNm3" → × 1000 = m³)
//   dam_chosuii    → 貯水位 m            ("NNN.NNm")
//   dam_chosuiritsu→ 貯水率 %            ("NN.NN％" → / 100)
//   time_kansoku   → 観測時刻 JST        ("YYYY/MM/DD HH:MM")
//
// The endpoint exposes metric keys rather than a station id, so the published
// name is the stable identity. A key answering 欠測 or a dash is the office's
// own mark; the dam is provider-marked empty when every stored key does.
//
// Priority 303 (MLIT-managed dam). Cron hourly at :24.

import { type Cell, cellState, MARKED, numberIn } from '../ingest/cells.ts';
import { ingestTask } from '../ingest/run.ts';
import type { Entry, Reading } from '../ingest/types.ts';
import type { Upstream } from '../ingest/upstream.ts';

const BASE_URL =
  process.env.QSR_RYUMON_BASE_URL ??
  'https://www.qsr.mlit.go.jp/ryumon/bousai/kkc_out/ryumon/data.php';

const SOURCE_ID = 'qsr-ryumon-dam';
const PREF_CODE = '40';
const DAM_NAME = '竜門ダム';

const KEYS = [
  'time_kansoku',
  'dam_ryunyu',
  'dam_houryu',
  'dam_chosuiryo',
  'dam_chosuii',
  'dam_chosuiritsu',
] as const;
export type RyumonKey = (typeof KEYS)[number];

// --- parsing ----------------------------------------------------------------

function parseCell(s: string): Cell {
  const t = (s ?? '').trim();
  // 欠測 or a bare dash (a unit may follow), never a negative figure.
  if (/^(?:欠測|[-－―ー−]+(?![\d.]))/.test(t)) return MARKED;
  const m = t.replace(/,/g, '').match(/-?\d+(?:\.\d+)?/);
  if (!m) return null;
  const n = Number(m[0]);
  return Number.isFinite(n) ? n : null;
}

/** "YYYY/MM/DD HH:MM" JST → UTC. */
export function parseRyumonTimestamp(s: string): Date | null {
  const m = s.trim().match(/^(\d{4})\/(\d{2})\/(\d{2})\s+(\d{2}):(\d{2})$/);
  if (!m) return null;
  const d = new Date(
    Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3]), Number(m[4]) - 9, Number(m[5]), 0, 0),
  );
  return Number.isNaN(d.getTime()) ? null : d;
}

/** The dam's reading from the six key answers. */
export function ryumonReading(v: Record<RyumonKey, string>): Reading {
  const observedAt = parseRyumonTimestamp(v.time_kansoku);
  if (!observedAt) return { state: 'unreadable', why: `time_kansoku "${v.time_kansoku}"` };

  const inflow = parseCell(v.dam_ryunyu);
  const outflow = parseCell(v.dam_houryu);
  const storageThou = parseCell(v.dam_chosuiryo);
  const level = parseCell(v.dam_chosuii);
  const ratePct = numberIn(parseCell(v.dam_chosuiritsu));
  const state = cellState([level, inflow, outflow, storageThou]);
  if (state === 'empty') return { state, mark: '欠測 on every key' };
  if (state === 'unreadable') return { state, why: 'no numeric key' };
  const thou = numberIn(storageThou);
  return {
    state: 'values',
    observations: [
      {
        observedAt,
        storageVolumeM3: thou !== null ? thou * 1000 : null,
        storageRate: ratePct !== null ? Math.max(0, Math.min(1, ratePct / 100)) : null,
        inflowM3s: numberIn(inflow),
        outflowM3s: numberIn(outflow),
        waterLevelM: numberIn(level),
      },
    ],
  };
}

/** One key's endpoint. */
export const keyUrl = (key: RyumonKey): string => `${BASE_URL}?key=${key}`;

/** The one dam, read once the run reaches it; a failed key makes it unreadable. */
export function ryumonEntries(upstream: Upstream): Entry[] {
  return [
    {
      key: DAM_NAME,
      name: DAM_NAME,
      pref: PREF_CODE,
      reading: async () => {
        // Fetch all keys in parallel
        const answers = await Promise.all(
          KEYS.map(async (k) =>
            (await upstream.fetch(keyUrl(k), { timeoutMs: 12_000 })).text().trim(),
          ),
        );
        return ryumonReading(
          Object.fromEntries(KEYS.map((k, i) => [k, answers[i] ?? ''])) as Record<
            RyumonKey,
            string
          >,
        );
      },
    },
  ];
}

export default ingestTask(SOURCE_ID, async ({ upstream }) => ({
  entries: ryumonEntries(upstream),
}));
