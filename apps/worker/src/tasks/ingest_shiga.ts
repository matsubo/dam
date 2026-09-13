// apps/worker/src/tasks/ingest_shiga.ts
//
// Sixth real-observation source. 滋賀県土木防災情報システム publishes
// hourly observations per dam at clean static HTML tables. The dam list:
//
//   id2=2 日野川, id2=3 石田川, id2=4 宇曽川, id2=5 青土,
//   id2=6 姉川,   id2=8 永源寺 — 6 prefectural dams matched to master.
//   (id2=1 余呉湖 and id2=7 天川 don't have master matches; skipped.
//    野洲川 / 蔵王 / 犬上川 link out to river.go.jp — policy-blocked, also skipped.)
//
// Source URL per dam:
//   http://shiga-bousai.jp/dam/dam_table.php?day=YYYY-MM-DD&time=HH:MM
//     &id1=8&id2={N}&id3=0&id4=0&sid={SID}
//
// The page returns a 23-row hourly table (newest first) with columns:
//   月/日, 時刻, 60分雨量, 累加雨量, 貯水位, 流入量, 放流量, 調節量,
//   空容量(千m³), 下流水位, 上流流量
//
// We harvest all 23 hourly rows per fetch — running the cron at :05 catches
// the latest hour's observation plus a 22-hour rolling backfill window so
// brief outages self-heal.

import { sql } from '@dam/db/client';
import { upsertObservations } from '@dam/db/repo/observations';
import { recordUniverse, type UniverseRow } from '@dam/db/repo/source_universe';
import type { Task } from 'graphile-worker';

const BASE_URL = process.env.SHIGA_DAM_BASE ?? 'http://shiga-bousai.jp/dam';

interface DamCfg {
  id2: number;
  sid: number;
  masterName: string;
  shigaName: string;
}

const DAMS: DamCfg[] = [
  { id2: 2, sid: 35152, shigaName: '日野川ダム', masterName: '日野川' },
  { id2: 3, sid: 39191, shigaName: '石田川ダム', masterName: '石田川' },
  { id2: 4, sid: 36191, shigaName: '宇曽川ダム', masterName: '宇曽川' },
  { id2: 5, sid: 34191, shigaName: '青土ダム', masterName: '青土' },
  { id2: 6, sid: 37191, shigaName: '姉川ダム', masterName: '姉川' },
  { id2: 8, sid: 35691, shigaName: '永源寺ダム', masterName: '永源寺' },
];

const PREF_CODE = '25';

/**
 * Listed by the portal but never ingested: 余呉湖 (id2=1) and 天川 (id2=7) have
 * no master dam, and 野洲川 / 蔵王 / 犬上川 link out to river.go.jp, which our
 * terms bar us from scraping. They are still part of what 滋賀県 publishes, so
 * /coverage has to see them — as stations we failed to link, not as absence.
 * Names are as spelled in this file's header, not verified against the portal.
 */
const UNINGESTED_STATIONS: readonly string[] = ['余呉湖', '天川', '野洲川', '蔵王', '犬上川'];

interface ParsedRow {
  observedAt: Date;
  waterLevelM: number | null;
  inflowM3s: number | null;
  outflowM3s: number | null;
  rainfallMm: number | null;
}

function parseNum(s: string): number | null {
  const t = s.replace(/[,\s　]/g, '');
  if (!t || t === '―' || t === '-' || t === '欠測') return null;
  const n = Number(t);
  return Number.isFinite(n) ? n : null;
}

/** Today's JST date as YYYY-MM-DD, used in the page URL. */
function todayJstDateString(now = new Date()): string {
  const jst = new Date(now.getTime() + 9 * 3600 * 1000);
  const y = jst.getUTCFullYear();
  const m = String(jst.getUTCMonth() + 1).padStart(2, '0');
  const d = String(jst.getUTCDate()).padStart(2, '0');
  return `${y}-${m}-${d}`;
}

function jstHourString(now = new Date()): string {
  const jst = new Date(now.getTime() + 9 * 3600 * 1000);
  const h = String(jst.getUTCHours()).padStart(2, '0');
  return `${h}:50`;
}

/**
 * Parse 「05/15 22:50」-style rows into Date + the four numeric fields we
 * keep. The page uses rowspan=23 on the date cell so subsequent rows only
 * carry the 時刻 column; we propagate the date as we walk top to bottom.
 *
 * Walks <tr> children of the main hourly table. Rows that don't carry the
 * expected leading "MM/DD" or "HH:MM" pattern are skipped.
 */
export function parseShigaDamTable(html: string, year: number): ParsedRow[] {
  const out: ParsedRow[] = [];
  // Cut down to the hourly-data table by anchoring on the headers. The page
  // also includes daily summary tables which we don't want to ingest.
  const start = html.indexOf('60分雨量');
  if (start < 0) return out;
  const section = html.slice(start, html.indexOf('</table>', start));

  let currentMonth: number | null = null;
  let currentDay: number | null = null;

  const rowRe = /<tr[^>]*>([\s\S]*?)<\/tr>/g;
  let rowMatch: RegExpExecArray | null;
  // biome-ignore lint/suspicious/noAssignInExpressions: idiomatic regex iteration
  while ((rowMatch = rowRe.exec(section)) !== null) {
    const inner = rowMatch[1] ?? '';
    const cells: string[] = [];
    const cellRe = /<td[^>]*>([\s\S]*?)<\/td>/g;
    let cellMatch: RegExpExecArray | null;
    // biome-ignore lint/suspicious/noAssignInExpressions: idiomatic regex iteration
    while ((cellMatch = cellRe.exec(inner)) !== null) {
      cells.push((cellMatch[1] ?? '').replace(/<[^>]*>/g, '').trim());
    }
    if (cells.length === 0) continue;

    // First cell may be MM/DD (rowspan=23) or HH:MM directly.
    let offset = 0;
    const dateMatch = cells[0]?.match(/^(\d{1,2})\/(\d{1,2})$/);
    if (dateMatch) {
      currentMonth = Number(dateMatch[1]);
      currentDay = Number(dateMatch[2]);
      offset = 1;
    }
    if (currentMonth == null || currentDay == null) continue;
    const timeStr = cells[offset];
    const timeMatch = timeStr?.match(/^(\d{1,2}):(\d{2})$/);
    if (!timeMatch) continue;
    const hour = Number(timeMatch[1]);
    const min = Number(timeMatch[2]);

    // Build a JST Date from year + currentMonth + currentDay + hour + min,
    // converted to UTC.
    const observedAt = new Date(Date.UTC(year, currentMonth - 1, currentDay, hour - 9, min, 0, 0));

    // Cell layout after time:
    //   [0] 60分雨量, [1] 累加雨量, [2] 貯水位, [3] 流入量, [4] 放流量
    const base = offset + 1;
    const rainfall = parseNum(cells[base] ?? '');
    const level = parseNum(cells[base + 2] ?? '');
    const inflow = parseNum(cells[base + 3] ?? '');
    const outflow = parseNum(cells[base + 4] ?? '');

    if (level == null && inflow == null && outflow == null) continue;
    out.push({
      observedAt,
      waterLevelM: level,
      inflowM3s: inflow,
      outflowM3s: outflow,
      rainfallMm: rainfall,
    });
  }

  return out;
}

async function ensureSourcePriority(): Promise<void> {
  await sql`
    INSERT INTO source_priorities (source_id, priority, description, active)
    VALUES ('shiga-bousai', 308,
            '滋賀県土木防災情報システム — hourly, 6 dams (日野川/石田川/宇曽川/青土/姉川/永源寺)',
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

async function ensureExternalIds(log: (s: string) => void): Promise<DamMatch[]> {
  const matches: DamMatch[] = [];
  // What this source publishes, matched or not — recorded so /coverage can
  // say "they publish it, we failed to link it" instead of guessing. The
  // portal's per-dam id2 doesn't cover the stations we never fetch, so the
  // published name is the key for every row.
  const universe: UniverseRow[] = [];
  for (const c of DAMS) {
    const rows = await sql<{ id: bigint; name: string }[]>`
      SELECT id, name FROM dams
      WHERE pref_code = ${PREF_CODE}
        AND name LIKE ${`%${c.masterName}%`}
      ORDER BY
        CASE
          WHEN name = ${c.masterName} THEN 0
          WHEN name = ${`${c.masterName}ダム`} THEN 1
          ELSE 5
        END,
        id
      LIMIT 1
    `;
    const r = rows[0];
    universe.push({
      externalId: c.shigaName,
      name: c.shigaName,
      prefCode: PREF_CODE,
      resolvedDamId: r?.id ?? null,
    });
    if (!r) {
      log(`shiga-bousai: no master match for ${c.shigaName} (${c.masterName})`);
      continue;
    }
    matches.push({ cfg: c, damId: r.id });
    await sql`
      UPDATE dams
      SET external_ids = COALESCE(external_ids, '{}'::jsonb)
                       || jsonb_build_object('shiga-bousai', ${c.shigaName}::text)
      WHERE id = ${r.id}
        AND COALESCE(external_ids->>'shiga-bousai', '') <> ${c.shigaName}
    `;
  }
  for (const name of UNINGESTED_STATIONS) {
    universe.push({ externalId: name, name, prefCode: PREF_CODE, resolvedDamId: null });
  }
  await recordUniverse('shiga-bousai', universe);
  return matches;
}

const task: Task = async (_payload, helpers) => {
  const log = (s: string): void => helpers.logger.info(s);
  await ensureSourcePriority();
  const matches = await ensureExternalIds(log);
  log(`shiga-bousai: matched ${matches.length}/${DAMS.length} master dams`);

  const day = todayJstDateString();
  const time = jstHourString();
  const year = Number(day.slice(0, 4));
  let totalWritten = 0;

  for (const m of matches) {
    const url = `${BASE_URL}/dam_table.php?day=${day}&time=${encodeURIComponent(time)}&interval=60&id1=8&id2=${m.cfg.id2}&id3=0&id4=0&sid=${m.cfg.sid}`;
    try {
      const r = await fetch(url, {
        headers: {
          'user-agent':
            process.env.HTTP_USER_AGENT ??
            'DamDataPlatform/0.1 (+https://dam.teraren.com/legal/terms; contact: https://discord.gg/UbWqspWbAk)',
        },
        signal: AbortSignal.timeout(15_000),
      });
      if (r.status !== 200) {
        log(`shiga-bousai: ${m.cfg.shigaName} HTTP ${r.status}; skip`);
        continue;
      }
      const html = await r.text();
      const rows = parseShigaDamTable(html, year);
      const inputs = rows.map((row) => ({
        observedAt: row.observedAt,
        damId: m.damId,
        sourceId: 'shiga-bousai',
        storageVolumeM3: null,
        storageRate: null,
        inflowM3s: row.inflowM3s,
        outflowM3s: row.outflowM3s,
        waterLevelM: row.waterLevelM,
        rainfallMm: row.rainfallMm,
        rawSnapshotId: null,
        qualityFlag: 0,
      }));
      const written = await upsertObservations(inputs);
      totalWritten += written;
      log(`shiga-bousai: ${m.cfg.shigaName} +${written} rows`);
    } catch (e) {
      log(`shiga-bousai: ${m.cfg.shigaName} ERROR ${(e as Error).message}`);
    }
  }

  log(`shiga-bousai done — matched=${matches.length} written=${totalWritten}`);
};

export default task;
