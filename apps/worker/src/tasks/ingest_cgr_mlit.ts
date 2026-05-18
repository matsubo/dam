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
// Each `data.<metric>.<id>` is a string (numeric) or "ー" for missing.

import { sql } from '@dam/db/client';
import { upsertObservations } from '@dam/db/repo/observations';
import type { Task } from 'graphile-worker';

const API_URL =
  process.env.CGR_MLIT_DAM_URL ??
  'http://www.cgr.mlit.go.jp/cginfo/syokai/busyo/kasen/dam_bousai/cgi-bin/index_table.php';

interface DamCfg {
  /** API id (1..11). */
  apiId: string;
  /** Name as it appears in the JSON `status.<id>.name`. */
  apiName: string;
  /** Substring used to LIKE-match against master `dams.name`. */
  masterName: string;
  /** Prefecture (JIS code). */
  prefCode: string;
}

const DAMS: DamCfg[] = [
  { apiId: '1', apiName: '菅沢ダム', masterName: '菅沢', prefCode: '31' },
  { apiId: '2', apiName: '土師ダム', masterName: '土師', prefCode: '34' },
  { apiId: '3', apiName: '島地川ダム', masterName: '島地川', prefCode: '35' },
  { apiId: '4', apiName: '弥栄ダム', masterName: '弥栄', prefCode: '34' },
  { apiId: '5', apiName: '八田原ダム', masterName: '八田原', prefCode: '34' },
  { apiId: '6', apiName: '温井ダム', masterName: '温井', prefCode: '34' },
  { apiId: '7', apiName: '苫田ダム', masterName: '苫田', prefCode: '33' },
  { apiId: '8', apiName: '灰塚ダム', masterName: '灰塚', prefCode: '34' },
  { apiId: '9', apiName: '志津見ダム', masterName: '志津見', prefCode: '32' },
  { apiId: '10', apiName: '尾原ダム', masterName: '尾原', prefCode: '32' },
  { apiId: '11', apiName: '殿ダム', masterName: '殿', prefCode: '31' },
];

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
interface ApiResponse {
  time?: string;
  status?: Record<string, { name: string; param: number }>;
  table?: { data: ApiData };
}

function parseNum(s: string | undefined): number | null {
  if (!s) return null;
  const t = s.replace(/[,\s　]/g, '');
  if (!t || t === 'ー' || t === '−' || t === '欠測' || t === '-') return null;
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

async function ensureSourcePriority(): Promise<void> {
  await sql`
    INSERT INTO source_priorities (source_id, priority, description, active)
    VALUES (${SOURCE_ID}, 304,
            '国土交通省 中国地方整備局 ダム防災情報システム — hourly, 11 dams (苫田/土師/弥栄/八田原/温井/灰塚/島地川/菅沢/殿/志津見/尾原)',
            true)
    ON CONFLICT (source_id) DO UPDATE
      SET priority    = EXCLUDED.priority,
          description = EXCLUDED.description,
          active      = EXCLUDED.active
  `;
}

interface DamMatch {
  cfg: DamCfg;
  damId: bigint;
}

async function matchMaster(log: (s: string) => void): Promise<DamMatch[]> {
  const matches: DamMatch[] = [];
  for (const c of DAMS) {
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
      log(`${SOURCE_ID}: no master match for ${c.apiName} (pref ${c.prefCode})`);
      continue;
    }
    matches.push({ cfg: c, damId: r.id });
    await sql`
      UPDATE dams
      SET external_ids = COALESCE(external_ids, '{}'::jsonb)
                       || jsonb_build_object(${SOURCE_ID}, ${c.apiId}::text)
      WHERE id = ${r.id}
        AND COALESCE(external_ids->>${SOURCE_ID}, '') <> ${c.apiId}
    `;
  }
  return matches;
}

const task: Task = async (_payload, helpers) => {
  const log = (s: string): void => helpers.logger.info(s);
  await ensureSourcePriority();
  const matches = await matchMaster(log);
  log(`${SOURCE_ID}: matched ${matches.length}/${DAMS.length} master dams`);

  const userAgent =
    process.env.HTTP_USER_AGENT ??
    'DamDataPlatform/0.1 (+https://dam.teraren.com/legal/terms; contact: https://discord.gg/UbWqspWbAk)';

  const r = await fetch(API_URL, {
    method: 'POST',
    headers: {
      'user-agent': userAgent,
      'content-type': 'application/json',
      'content-length': '0',
      referer: 'http://www.cgr.mlit.go.jp/cginfo/syokai/busyo/kasen/dam_bousai/index.php',
    },
    body: '',
    signal: AbortSignal.timeout(12_000),
  });
  if (r.status !== 200) {
    log(`${SOURCE_ID}: HTTP ${r.status}; abort`);
    return;
  }
  const text = await r.text();
  let payload: ApiResponse;
  try {
    payload = JSON.parse(text) as ApiResponse;
  } catch {
    log(`${SOURCE_ID}: JSON parse failed (got ${text.slice(0, 80)})`);
    return;
  }
  const observedAt = parseCgrTimestamp(payload.time ?? '');
  if (!observedAt) {
    log(`${SOURCE_ID}: could not parse time '${payload.time}'`);
    return;
  }
  const data = payload.table?.data;
  if (!data) {
    log(`${SOURCE_ID}: missing table.data`);
    return;
  }

  const inputs = [] as Parameters<typeof upsertObservations>[0];
  for (const m of matches) {
    const id = m.cfg.apiId;
    const inflowM3s = parseNum(data.ryunyu[id]);
    const outflowM3s = parseNum(data.houryu[id]);
    const waterLevelM = parseNum(data.chosuii[id]);
    // chisui is 有効容量 (effective) — closest analogue to standard "貯水率".
    const rate = parseNum(data.chisui[id]);
    const storageRate = rate != null ? rate / 100 : null;
    const rainfallMm = parseNum(data.uryou[id]);
    if (inflowM3s == null && outflowM3s == null && waterLevelM == null && storageRate == null) {
      continue;
    }
    inputs.push({
      observedAt,
      damId: m.damId,
      sourceId: SOURCE_ID,
      storageVolumeM3: null,
      storageRate,
      inflowM3s,
      outflowM3s,
      waterLevelM,
      rainfallMm,
      rawSnapshotId: null,
      qualityFlag: 0,
    });
  }
  const written = await upsertObservations(inputs);
  log(`${SOURCE_ID} done: matched=${matches.length} parsed=${inputs.length} written=${written}`);
};

export default task;
