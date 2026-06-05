// apps/worker/src/tasks/ingest_yamagata_bousai.ts
//
// 山形県河川・砂防情報 — 防災Web JSON feed (dk=4), hourly.
//
//   ~17 dams (13 county + 4 MLIT Tohoku): 蔵王/前川/白水川/留山川/高坂/神室/
//   最上小国川/木地山/綱木川/月光川/荒沢/温海川/田沢川 (県管理 mng=1) +
//   長井/寒河江/白川/月山 (国管理 mng=11).
//
// Source: http://www.kasen.pref.yamagata.jp/map/servlet/bousaiweb.servletBousaiMap?dk=4
// Format: Shift_JIS JSON; `date` = "YYYYMMDDHHMMSS" JST; numbered dam keys
//         (1…N, some gaps); data1=貯水位(EL.m), data2=貯水量(千m³),
//         data3=流入量(m³/s), data4=放流量(m³/s), data5=貯水率(%);
//         "0" stored as literal "0", missing values as "" or absent.
// License: 山形県 published; public site with no stated restriction.
//
// Priority 308, matching other 防災Web prefectural sources (niigata-bousai).

import { sql } from '@dam/db/client';
import { upsertObservations } from '@dam/db/repo/observations';
import type { Task } from 'graphile-worker';

const DATA_URL =
  process.env.YAMAGATA_BOUSAI_URL ??
  'http://www.kasen.pref.yamagata.jp/map/servlet/bousaiweb.servletBousaiMap?dk=4';

const PREF_CODE = '06';
const SOURCE_ID = 'yamagata-bousai';

// --- types ------------------------------------------------------------------

interface DamEntry {
  an: string; // dam name
  data1: string; // water level EL.m
  data2: string; // storage 千m³
  data3: string; // inflow m³/s
  data4: string; // outflow m³/s
  data5: string; // storage rate %
  time: string; // per-dam timestamp YYYYMMDDHHMMSS
  [key: string]: string;
}

interface YamagataJson {
  date: string; // feed timestamp YYYYMMDDHHMMSS
  [key: string]: DamEntry | string;
}

export interface ParsedRow {
  yamagataName: string;
  observedAt: Date | null;
  waterLevelM: number | null;
  storageVolumeM3: number | null;
  storageRate: number | null;
  inflowM3s: number | null;
  outflowM3s: number | null;
}

// --- parsing ----------------------------------------------------------------

function parseNum(s: string): number | null {
  if (!s) return null;
  const cleaned = s.replace(/[,\s　]/g, '');
  if (!cleaned || cleaned === '---' || cleaned === '-' || cleaned === '―') return null;
  const n = Number(cleaned);
  return Number.isFinite(n) ? n : null;
}

/** "YYYYMMDDHHMMSS" JST → UTC Date */
export function parseYamagataTimestamp(s: string): Date | null {
  const m = s.match(/^(\d{4})(\d{2})(\d{2})(\d{2})(\d{2})(\d{2})$/);
  if (!m) return null;
  const [, yr, mo, dy, hr, mi] = m.map(Number);
  const d = new Date(Date.UTC(yr, mo - 1, dy, hr - 9, mi, 0, 0));
  return Number.isNaN(d.getTime()) ? null : d;
}

export function parseYamagataJson(json: YamagataJson): ParsedRow[] {
  const rows: ParsedRow[] = [];

  for (const [key, val] of Object.entries(json)) {
    if (key === 'date') continue;
    if (typeof val !== 'object') continue;
    const entry = val as DamEntry;
    const name = entry.an?.trim();
    if (!name) continue;

    // Use per-dam timestamp when available, fall back to feed-level date.
    const tsStr = entry.time?.trim() || json.date;
    const observedAt = parseYamagataTimestamp(tsStr);

    const waterLevelM = parseNum(entry.data1);
    const storageThou = parseNum(entry.data2);
    const rateRaw = parseNum(entry.data5);
    const inflowM3s = parseNum(entry.data3);
    const outflowM3s = parseNum(entry.data4);

    rows.push({
      yamagataName: name,
      observedAt,
      waterLevelM,
      storageVolumeM3: storageThou !== null ? storageThou * 1_000 : null,
      storageRate: rateRaw !== null ? rateRaw / 100 : null,
      inflowM3s,
      outflowM3s,
    });
  }

  return rows;
}

// --- DB helpers -------------------------------------------------------------

async function ensureSourcePriority(): Promise<void> {
  await sql`
    INSERT INTO source_priorities (source_id, priority, description, active)
    VALUES (${SOURCE_ID}, 308,
            '山形県河川・砂防情報 — 防災Web JSON dk=4, hourly (~17 ダム)',
            true)
    ON CONFLICT (source_id) DO UPDATE
      SET priority    = EXCLUDED.priority,
          description = EXCLUDED.description,
          active      = EXCLUDED.active
  `;
}

function normalizeName(s: string): string {
  return s
    .replace(/[（(][^）)]*[）)]/g, '')
    .replace(/ダム$/, '')
    .replace(/貯水池$/, '')
    .trim();
}

interface DamMatch {
  yamagataName: string;
  damId: bigint;
}

async function matchMaster(rows: ParsedRow[], log: (s: string) => void): Promise<DamMatch[]> {
  const masters = await sql<{ id: bigint; name: string }[]>`
    SELECT id, name FROM dams WHERE pref_code = ${PREF_CODE} ORDER BY id
  `;
  const out: DamMatch[] = [];

  for (const r of rows) {
    const stem = normalizeName(r.yamagataName);
    if (!stem) continue;

    let best: { id: bigint; rank: number } | null = null;
    for (const m of masters) {
      const mStem = normalizeName(m.name);
      let rank: number;
      if (mStem === stem) rank = 0;
      else if (m.name === `${stem}ダム`) rank = 1;
      else if (mStem.startsWith(stem)) rank = 2;
      else if (mStem.includes(stem)) rank = 3;
      else continue;
      if (!best || rank < best.rank || (rank === best.rank && m.id < best.id)) {
        best = { id: m.id, rank };
      }
    }

    if (!best) {
      log(`${SOURCE_ID}: no master match for "${r.yamagataName}"`);
      continue;
    }

    out.push({ yamagataName: r.yamagataName, damId: best.id });
    await sql`
      UPDATE dams
      SET external_ids = COALESCE(external_ids, '{}'::jsonb)
                       || jsonb_build_object(${SOURCE_ID}::text, ${r.yamagataName}::text)
      WHERE id = ${best.id}
        AND COALESCE(external_ids->>${SOURCE_ID}, '') <> ${r.yamagataName}
    `;
  }

  return out;
}

// --- task -------------------------------------------------------------------

const task: Task = async (_payload, helpers) => {
  const log = (s: string): void => helpers.logger.info(s);
  await ensureSourcePriority();

  const r = await fetch(DATA_URL, {
    headers: {
      'user-agent':
        process.env.HTTP_USER_AGENT ??
        'DamDataPlatform/0.1 (+https://dam.teraren.com/legal/terms; contact: https://discord.gg/UbWqspWbAk)',
    },
    signal: AbortSignal.timeout(20_000),
  });

  if (r.status !== 200) {
    log(`${SOURCE_ID}: HTTP ${r.status}; aborting`);
    return;
  }

  const raw = await r.arrayBuffer();
  const text = new TextDecoder('shift_jis').decode(raw);
  const json = JSON.parse(text) as YamagataJson;

  const rows = parseYamagataJson(json);
  log(`${SOURCE_ID}: parsed ${rows.length} dam entries`);

  const matches = await matchMaster(rows, log);
  const damByName = new Map(matches.map((m) => [m.yamagataName, m.damId]));

  const inputs = [] as Parameters<typeof upsertObservations>[0];
  for (const p of rows) {
    const damId = damByName.get(p.yamagataName);
    if (!damId) continue;
    if (!p.observedAt) {
      log(`${SOURCE_ID}: missing timestamp for "${p.yamagataName}"; skipping`);
      continue;
    }
    if (p.waterLevelM === null && p.storageVolumeM3 === null && p.storageRate === null) continue;

    inputs.push({
      observedAt: p.observedAt,
      damId,
      sourceId: SOURCE_ID,
      storageVolumeM3: p.storageVolumeM3,
      storageRate: p.storageRate,
      inflowM3s: p.inflowM3s,
      outflowM3s: p.outflowM3s,
      waterLevelM: p.waterLevelM,
      rainfallMm: null,
      rawSnapshotId: null,
      qualityFlag: 0,
    });
  }

  const written = await upsertObservations(inputs);
  log(`${SOURCE_ID} done: parsed=${rows.length} matched=${matches.length} written=${written}`);
};

export default task;
