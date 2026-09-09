// apps/worker/src/tasks/ingest_hrr_mlit.ts
//
// Twelfth real-observation source. 国土交通省 北陸地方整備局 publishes a
// consolidated dam dashboard at:
//   https://www.hrr.mlit.go.jp/river/dam-bousai/
// The map layer fetches `data/tmDam.txt` — a CSV-like file with one row
// per dam carrying the current 流入/放流/貯水位 values:
//
//   大川ダム,21527,00001,37.3463...,139.9119...,2026/05/19,05:00,12.87,20.06,372.52,-,-,1,0
//
// Columns: name, area_cd, dam_cd, lat, lng, date, time, inflow_m3s,
//          outflow_m3s, water_level_m, ?, ?, icon_cd, status
//
// 7 dams across 6 prefectures (福島/山形/新潟/長野/富山/石川):
//   大川 / 大石 / 横川 / 三国川 / 大町 / 宇奈月 / 手取川

import { sql } from '@dam/db/client';
import { upsertObservations } from '@dam/db/repo/observations';
import { type UniverseRow, recordUniverse } from '@dam/db/repo/source_universe';
import type { Task } from 'graphile-worker';

const CSV_URL =
  process.env.HRR_MLIT_DAM_URL ?? 'https://www.hrr.mlit.go.jp/river/dam-bousai/data/tmDam.txt';

interface DamCfg {
  /** Substring used to LIKE-match against master `dams.name`. */
  masterName: string;
  prefCode: string;
}

const DAMS: Record<string, DamCfg> = {
  大川ダム: { masterName: '大川', prefCode: '07' },
  大石ダム: { masterName: '大石', prefCode: '15' },
  横川ダム: { masterName: '横川', prefCode: '06' },
  三国川ダム: { masterName: '三国川', prefCode: '15' },
  大町ダム: { masterName: '大町', prefCode: '20' },
  宇奈月ダム: { masterName: '宇奈月', prefCode: '16' },
  手取川ダム: { masterName: '手取川', prefCode: '17' },
};

const SOURCE_ID = 'hrr-mlit-dam';

interface ParsedRow {
  name: string;
  observedAt: Date;
  inflowM3s: number | null;
  outflowM3s: number | null;
  waterLevelM: number | null;
}

function parseNum(s: string | undefined): number | null {
  if (!s) return null;
  const t = s.replace(/[,\s　]/g, '');
  if (!t || t === '-' || t === '−' || t === '欠測') return null;
  const n = Number(t);
  return Number.isFinite(n) ? n : null;
}

/** Parse a single CSV line. Skip blank lines. Returns null if shape is unexpected. */
export function parseHrrLine(line: string): ParsedRow | null {
  const cols = line.split(',').map((c) => c.trim());
  if (cols.length < 10) return null;
  const name = cols[0] ?? '';
  const date = cols[5] ?? '';
  const time = cols[6] ?? '';
  if (!name.endsWith('ダム') || !date || !time) return null;
  const dMatch = date.match(/(\d{4})\/(\d{1,2})\/(\d{1,2})/);
  const tMatch = time.match(/(\d{1,2}):(\d{1,2})/);
  if (!dMatch || !tMatch) return null;
  const observedAt = new Date(
    Date.UTC(
      Number(dMatch[1]),
      Number(dMatch[2]) - 1,
      Number(dMatch[3]),
      Number(tMatch[1]) - 9,
      Number(tMatch[2]),
      0,
      0,
    ),
  );
  return {
    name,
    observedAt,
    inflowM3s: parseNum(cols[7]),
    outflowM3s: parseNum(cols[8]),
    waterLevelM: parseNum(cols[9]),
  };
}

async function ensureSourcePriority(): Promise<void> {
  await sql`
    INSERT INTO source_priorities (source_id, priority, description, active)
    VALUES (${SOURCE_ID}, 302,
            '国土交通省 北陸地方整備局 ダム防災情報 — hourly, 7 dams (大川/大石/横川/三国川/大町/宇奈月/手取川)',
            true)
    ON CONFLICT (source_id) DO UPDATE
      SET priority    = EXCLUDED.priority,
          description = EXCLUDED.description,
          active      = EXCLUDED.active
  `;
}

interface DamMatch {
  pageName: string;
  damId: bigint;
}

async function matchMaster(log: (s: string) => void): Promise<Map<string, bigint>> {
  const result = new Map<string, bigint>();
  for (const [pageName, c] of Object.entries(DAMS)) {
    const rows = await sql<{ id: bigint }[]>`
      SELECT id FROM dams
      WHERE pref_code = ${c.prefCode}
        AND name LIKE ${`%${c.masterName}%`}
      ORDER BY
        CASE
          WHEN name = ${c.masterName} THEN 0
          WHEN name = ${`${c.masterName}ダム`} THEN 1
          WHEN name LIKE ${`${c.masterName}（再）%`} THEN 2
          ELSE 5
        END,
        id
      LIMIT 1
    `;
    const r = rows[0];
    if (!r) {
      log(`${SOURCE_ID}: no master match for ${pageName} (pref ${c.prefCode})`);
      continue;
    }
    result.set(pageName, r.id);
    await sql`
      UPDATE dams
      SET external_ids = COALESCE(external_ids, '{}'::jsonb)
                       || jsonb_build_object(${SOURCE_ID}::text, ${pageName}::text)
      WHERE id = ${r.id}
        AND COALESCE(external_ids->>${SOURCE_ID}, '') <> ${pageName}
    `;
  }
  return result;
}

const task: Task = async (_payload, helpers) => {
  const log = (s: string): void => helpers.logger.info(s);
  await ensureSourcePriority();
  const matches = await matchMaster(log);
  log(`${SOURCE_ID}: matched ${matches.size}/${Object.keys(DAMS).length} master dams`);

  const userAgent =
    process.env.HTTP_USER_AGENT ??
    'DamDataPlatform/0.1 (+https://dam.teraren.com/legal/terms; contact: https://discord.gg/UbWqspWbAk)';

  const r = await fetch(CSV_URL, {
    headers: { 'user-agent': userAgent },
    signal: AbortSignal.timeout(12_000),
  });
  if (r.status !== 200) {
    log(`${SOURCE_ID}: HTTP ${r.status}; abort`);
    return;
  }
  const text = await r.text();
  // What this source publishes, matched or not — recorded so /coverage can say
  // "they publish it, we failed to link it" instead of guessing. Built from the
  // CSV rather than from `DAMS`, because the CSV is the published list and
  // `DAMS` is only the subset we have configured: a dam 北陸地整 adds shows up
  // here as an unmatched row instead of vanishing. Keyed by name so a repeated
  // row can't break the upsert.
  const universe = new Map<string, UniverseRow>();
  const inputs = [] as Parameters<typeof upsertObservations>[0];
  for (const raw of text.split(/\r?\n/)) {
    const p = parseHrrLine(raw);
    if (!p) continue;
    const damId = matches.get(p.name);
    universe.set(p.name, {
      externalId: p.name,
      name: p.name,
      prefCode: DAMS[p.name]?.prefCode ?? null,
      resolvedDamId: damId ?? null,
    });
    if (!damId) continue;
    if (p.waterLevelM == null && p.inflowM3s == null && p.outflowM3s == null) continue;
    inputs.push({
      observedAt: p.observedAt,
      damId,
      sourceId: SOURCE_ID,
      storageVolumeM3: null,
      storageRate: null,
      inflowM3s: p.inflowM3s,
      outflowM3s: p.outflowM3s,
      waterLevelM: p.waterLevelM,
      rainfallMm: null,
      rawSnapshotId: null,
      qualityFlag: 0,
    });
  }
  await recordUniverse(SOURCE_ID, [...universe.values()]);
  const written = await upsertObservations(inputs);
  log(`${SOURCE_ID} done: matched=${matches.size} parsed=${inputs.length} written=${written}`);
};

export default task;
