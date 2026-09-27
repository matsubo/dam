// apps/worker/src/tasks/ingest_jwa_chubu.ts
//
// 水資源機構 中部支社 — 6 dams from the daily water-source status report:
//
//   木曽川水系: 牧尾/阿木川/味噌川/岩屋/徳山
//   三重用水:   中里 (いなべ市, 三重 — not a 長野 dam; see migration 0083)
//
// Source: https://www.water.go.jp/mizu/chubu/report/
// Format: Static HTML; date "YYYY年MM月DD日"; storage units 千m³. Each dam is a
//         block headed by <span class="dam-name">; values sit in
//         <div class="databox">: [EL …] = 0時の貯水位, 流入量/放流量 = 前日平均,
//         貯水量<br>&lt;午前0時&gt; and (貯水率 …) on the 利水容量 basis.
// License: 水資源機構 published; 出典明示で再配布可.
//
// New coverage: 中里ダム (not in jwa-junpo).
// Overlap (牧尾/阿木川/味噌川/岩屋/徳山): provides inflow/outflow and daily
// cadence vs jwa-junpo's 10-day. aitoyo has same 5 overlap dams at priority 295,
// so jwa-chubu (296) becomes preferredSource for them when both present.

import { type BindableMaster, chooseRanked } from '@dam/core/dam_binding';
import { sql } from '@dam/db/client';
import { bindExternalId } from '@dam/db/repo/dams';
import { upsertObservations } from '@dam/db/repo/observations';
import { recordUniverse, type UniverseRow } from '@dam/db/repo/source_universe';
import type { Task } from 'graphile-worker';

const PAGE_URL = process.env.JWA_CHUBU_URL ?? 'https://www.water.go.jp/mizu/chubu/report/';

const NAME_MAP: Array<{ chubuName: string; masterName: string; prefCodes: string[] }> = [
  { chubuName: '牧尾ダム', masterName: '牧尾', prefCodes: ['20'] }, // 長野
  { chubuName: '阿木川ダム', masterName: '阿木川', prefCodes: ['21'] }, // 岐阜
  { chubuName: '味噌川ダム', masterName: '味噌川', prefCodes: ['20'] },
  { chubuName: '岩屋ダム', masterName: '岩屋', prefCodes: ['21'] },
  { chubuName: '中里ダム', masterName: '中里', prefCodes: ['24'] }, // 三重 (三重用水)
  { chubuName: '徳山ダム', masterName: '徳山', prefCodes: ['21'] },
];

interface ParsedRow {
  chubuName: string;
  storageVolumeThouM3: number;
  storageRatePct: number;
  waterLevelM: number | null;
  inflowM3s: number | null;
  outflowM3s: number | null;
}

function parseNum(s: string): number | null {
  const cleaned = s.replace(/[,\s　%千m³/s]/g, '');
  if (!cleaned || cleaned === '―' || cleaned === '-' || cleaned === '—') return null;
  const n = Number(cleaned);
  return Number.isFinite(n) ? n : null;
}

/** Parse "YYYY年MM月DD日" → JST midnight = UTC day-1 15:00. */
export function parseChubuDate(text: string): Date | null {
  const m = text.match(/(\d{4})年(\d{1,2})月(\d{1,2})日/);
  if (!m) return null;
  const yr = Number(m[1]);
  const mo = Number(m[2]);
  const day = Number(m[3]);
  if (!yr || !mo || !day) return null;
  const d = new Date(Date.UTC(yr, mo - 1, day - 1, 15, 0, 0, 0));
  return Number.isNaN(d.getTime()) ? null : d;
}

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * The block headed by <span class="dam-name…">NAME</span>, up to the next
 * dam-name span or the end of its table. Matching the whole span keeps
 * 中里ダム off 「(中里ダム・調整池合計)」, the 三重用水 total printed first.
 */
function damBlock(html: string, damName: string): string {
  const head = new RegExp(`<span class="dam-name[^"]*">${escapeRegExp(damName)}</span>`).exec(html);
  if (!head) return '';
  const rest = html.slice(head.index + head[0].length);
  const next = rest.search(/<span class="dam-name|<\/table>/);
  return next < 0 ? rest : rest.slice(0, next);
}

/** The first <div class="databox"> value after `marker`. */
function databoxAfter(block: string, marker: RegExp): number | null {
  const m = marker.exec(block);
  if (!m) return null;
  const box = block.slice(m.index + m[0].length).match(/<div class="databox[^"]*">([^<]*)<\/div>/);
  return box ? parseNum(box[1] ?? '') : null;
}

export function parseChubuHtml(html: string): { reportDate: Date | null; rows: ParsedRow[] } {
  const reportDate = parseChubuDate(html);
  const rows: ParsedRow[] = [];

  for (const m of NAME_MAP) {
    const block = damBlock(html, m.chubuName);
    if (!block) continue;

    // 貯水量<br>&lt;午前0時&gt; is the storage; the 有効貯水量<br> label above
    // it (徳山) is the capacity, and 前日貯水量との増減 the day's change.
    const volume = databoxAfter(block, /(?<!有効)貯水量<br>/);
    const rate = databoxAfter(block, /貯水率(?=<div)/);
    if (volume == null || rate == null) continue;
    rows.push({
      chubuName: m.chubuName,
      storageVolumeThouM3: volume,
      storageRatePct: rate,
      waterLevelM: databoxAfter(block, /\[EL\s*/),
      inflowM3s: databoxAfter(block, /流入量(?=<div)/),
      outflowM3s: databoxAfter(block, /(?<!利水)放流量(?=<div)/),
    });
  }
  return { reportDate, rows };
}

interface DamMatch {
  chubuName: string;
  damId: bigint;
}

async function ensureSourcePriority(): Promise<void> {
  await sql`
    INSERT INTO source_priorities (source_id, priority, description, active)
    VALUES ('jwa-chubu', 296,
            '水資源機構 中部支社 木曽川水系 — daily, 6 dams with inflow/outflow',
            true)
    ON CONFLICT (source_id) DO UPDATE
      SET priority    = EXCLUDED.priority,
          description = EXCLUDED.description,
          active      = EXCLUDED.active
  `;
}

export async function ensureExternalIds(log: (s: string) => void): Promise<DamMatch[]> {
  const matches: DamMatch[] = [];
  // What this source publishes, matched or not — recorded so /coverage can
  // say "they publish it, we failed to link it" instead of guessing.
  const universe: UniverseRow[] = [];
  for (const m of NAME_MAP) {
    // （元） and （再） rank alike so chooseRanked binds the current twin.
    const candidates = await sql<(BindableMaster & { rank: number })[]>`
      SELECT id, name, completed_year AS "completedYear",
             external_ids->>'jwa-chubu' AS stamp,
             CASE
               WHEN name = ${`${m.masterName}ダム`}       THEN 0
               WHEN name = ${m.masterName}                 THEN 1
               WHEN name LIKE ${`${m.masterName}（再）%`}  THEN 2
               WHEN name LIKE ${`${m.masterName}（元）%`}  THEN 2
               ELSE 5
             END AS rank
      FROM dams
      WHERE pref_code = ANY(${m.prefCodes}::text[])
        AND name LIKE ${`%${m.masterName}%`}
    `;
    const r = chooseRanked(candidates, m.chubuName);
    universe.push({
      externalId: m.chubuName,
      name: m.chubuName,
      prefCode: m.prefCodes[0] ?? null,
      resolvedDamId: r?.id ?? null,
    });
    if (!r) {
      log(`jwa-chubu: no master match for "${m.chubuName}" (${m.masterName})`);
      continue;
    }
    matches.push({ chubuName: m.chubuName, damId: r.id });
    await bindExternalId(r.id, 'jwa-chubu', m.chubuName);
  }
  await recordUniverse('jwa-chubu', universe);
  return matches;
}

const task: Task = async (_payload, helpers) => {
  const log = (s: string): void => helpers.logger.info(s);
  await ensureSourcePriority();
  const matches = await ensureExternalIds(log);
  log(`jwa-chubu: matched ${matches.length}/${NAME_MAP.length} master dams`);

  const r = await fetch(PAGE_URL, {
    headers: {
      'user-agent':
        process.env.HTTP_USER_AGENT ??
        'DamDataPlatform/0.1 (+https://dam.teraren.com/legal/terms; contact: https://discord.gg/UbWqspWbAk)',
    },
    signal: AbortSignal.timeout(20_000),
  });
  if (r.status !== 200) {
    log(`jwa-chubu: HTTP ${r.status}; aborting`);
    return;
  }
  const html = await r.text();
  const { reportDate, rows: parsed } = parseChubuHtml(html);
  log(
    `jwa-chubu: parsed ${parsed.length} rows, reportDate=${reportDate?.toISOString() ?? '(missing)'}`,
  );

  if (!reportDate) {
    log('jwa-chubu: no reportDate found; aborting to avoid wrong timestamps');
    return;
  }

  const matchByName = new Map(matches.map((m) => [m.chubuName, m.damId]));
  const inputs = [] as Parameters<typeof upsertObservations>[0];
  for (const row of parsed) {
    const damId = matchByName.get(row.chubuName);
    if (!damId) continue;
    inputs.push({
      observedAt: reportDate,
      damId,
      sourceId: 'jwa-chubu',
      storageVolumeM3: row.storageVolumeThouM3 * 1_000,
      storageRate: Math.max(0, Math.min(1, row.storageRatePct / 100)),
      inflowM3s: row.inflowM3s,
      outflowM3s: row.outflowM3s,
      waterLevelM: row.waterLevelM,
      rainfallMm: null,
      rawSnapshotId: null,
      qualityFlag: 0,
    });
  }
  const written = await upsertObservations(inputs);
  log(`jwa-chubu done: parsed=${parsed.length} matched=${matches.length} written=${written}`);
};

export default task;
