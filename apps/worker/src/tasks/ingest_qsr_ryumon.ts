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
// Priority 303 (MLIT-managed dam). Cron hourly at :24.

import { sql } from '@dam/db/client';
import { upsertObservations } from '@dam/db/repo/observations';
import type { Task } from 'graphile-worker';

const BASE_URL =
  process.env.QSR_RYUMON_BASE_URL ??
  'https://www.qsr.mlit.go.jp/ryumon/bousai/kkc_out/ryumon/data.php';

const SOURCE_ID = 'qsr-ryumon-dam';
const PREF_CODE = '40';

// --- parsing ----------------------------------------------------------------

function parseNum(s: string): number | null {
  const m = (s ?? '').replace(/,/g, '').match(/-?\d+(?:\.\d+)?/);
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

async function fetchKey(key: string, ua: string): Promise<string> {
  const r = await fetch(`${BASE_URL}?key=${key}`, {
    headers: { 'user-agent': ua },
    signal: AbortSignal.timeout(12_000),
  });
  if (r.status !== 200) return '';
  return (await r.text()).trim();
}

// --- DB helpers -------------------------------------------------------------

async function ensureSourcePriority(): Promise<void> {
  await sql`
    INSERT INTO source_priorities (source_id, priority, description, active)
    VALUES (${SOURCE_ID}, 303,
            '国土交通省 九州地方整備局 竜門ダム管理所 — 竜門ダム (佐田川水系, Fukuoka)',
            true)
    ON CONFLICT (source_id) DO UPDATE
      SET priority    = EXCLUDED.priority,
          description = EXCLUDED.description,
          active      = EXCLUDED.active
  `;
}

async function findDamId(log: (s: string) => void): Promise<bigint | null> {
  const rows = await sql<{ id: bigint }[]>`
    SELECT id FROM dams
    WHERE pref_code = ${PREF_CODE}
      AND name LIKE '%竜門%'
    ORDER BY
      CASE
        WHEN name = '竜門ダム' THEN 0
        WHEN name LIKE '%竜門%' THEN 1
        ELSE 5
      END, id
    LIMIT 1
  `;
  if (!rows[0]) {
    log(`${SOURCE_ID}: no master match for 竜門ダム (pref ${PREF_CODE})`);
    return null;
  }
  await sql`
    UPDATE dams
    SET external_ids = COALESCE(external_ids, '{}'::jsonb)
                     || jsonb_build_object(${SOURCE_ID}::text, ${'竜門ダム'}::text)
    WHERE id = ${rows[0].id}
      AND COALESCE(external_ids->>${SOURCE_ID}, '') <> ${'竜門ダム'}
  `;
  return rows[0].id;
}

// --- task -------------------------------------------------------------------

const task: Task = async (_payload, helpers) => {
  const log = (s: string): void => helpers.logger.info(s);
  await ensureSourcePriority();

  const ua =
    process.env.HTTP_USER_AGENT ??
    'DamDataPlatform/0.1 (+https://dam.teraren.com/legal/terms; contact: https://discord.gg/UbWqspWbAk)';

  // Fetch all keys in parallel
  const [timeStr, ryunyuStr, houryuStr, chosuiryoStr, chosuiiStr, chosuiritsuStr] =
    await Promise.all([
      fetchKey('time_kansoku', ua),
      fetchKey('dam_ryunyu', ua),
      fetchKey('dam_houryu', ua),
      fetchKey('dam_chosuiryo', ua),
      fetchKey('dam_chosuii', ua),
      fetchKey('dam_chosuiritsu', ua),
    ]);

  const observedAt = parseRyumonTimestamp(timeStr);
  if (!observedAt) {
    log(`${SOURCE_ID}: failed to parse time: "${timeStr}"`);
    return;
  }
  log(`${SOURCE_ID}: data at ${observedAt.toISOString()}`);

  const inflowM3s = parseNum(ryunyuStr);
  const outflowM3s = parseNum(houryuStr);
  const storageThousandM3 = parseNum(chosuiryoStr);
  const storageVolumeM3 = storageThousandM3 !== null ? storageThousandM3 * 1000 : null;
  const waterLevelM = parseNum(chosuiiStr);
  const ratePct = parseNum(chosuiritsuStr);
  const storageRate = ratePct !== null ? Math.max(0, Math.min(1, ratePct / 100)) : null;

  if (
    waterLevelM === null &&
    inflowM3s === null &&
    outflowM3s === null &&
    storageVolumeM3 === null
  ) {
    log(`${SOURCE_ID}: all values null; skipping`);
    return;
  }

  const damId = await findDamId(log);
  if (!damId) return;

  const written = await upsertObservations([
    {
      observedAt,
      damId,
      sourceId: SOURCE_ID,
      storageVolumeM3,
      storageRate,
      inflowM3s,
      outflowM3s,
      waterLevelM,
      rainfallMm: null,
      rawSnapshotId: null,
      qualityFlag: 0,
    },
  ]);
  log(`${SOURCE_ID} done: written=${written}`);
};

export default task;
