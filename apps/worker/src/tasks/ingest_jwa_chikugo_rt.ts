// apps/worker/src/tasks/ingest_jwa_chikugo_rt.ts
//
// 水資源機構 筑後川局 水管理情報WEB — hourly reports for the 5 facilities it
// operates in the 筑後川 system:
//
//   江川 / 寺内 / 小石原川 (福岡) · 大山 (大分) · 筑後大堰 (福岡)
//
// Source: http://chikugo.ec-net.jp/chikugo/kyoku/pc/new/rep{EG,TR,KB,OY,CO}_I60.html
//   linked from water.go.jp/chikugo/chikugo/water-source.html; the station
//   list is the site's own menu (kyoku/pc/script/menuTbl.js). Plain HTTP only —
//   the https endpoint does not answer. Shift_JIS HTML; each page is a 24-row
//   hourly table (JST), oldest first. The date is printed only on the first
//   row of each day, and midnight is written as "24:00" under the previous
//   date. Markers: *** 欠測 (and other non-numeric cells) → null.
//
// Columns are read by header label, because they differ per facility:
//   dams  貯水位[EL.m] | 有効貯水量[千m³] | 空容量 | 貯水率[%] | 流入量 |
//         (gate / 利水 / 洪水吐 放流量 …) | 総放流量 | 流域平均時間雨量
//   大堰  貯水位 水位[TP.m] | 貯水位 設定水位 | 有効貯水量[千m³] |
//         堰直下水位 | 大堰地点時間雨量
//
// 貯水率 is the rate against the facility's 貯水容量 — the purpose pool
// water-source.html prints next to it (江川 24,000 / 寺内 8,230 / 小石原川
// 35,000 / 大山 11,000 千m³). 有効貯水量 / 貯水率 over the 24 captured rows
// back-solves to 23,906–24,088 / 8,215–8,246 / 34,954–35,047 / 10,993–11,007,
// i.e. that pool within the rounding of a one-decimal rate; 0087 trusts it.
// 筑後大堰 prints no rate and no flows.
//
// Every run upserts the page's whole 24 h window, so a missed run heals.
// Priority 298: above the daily 0時 jwa-chikugo (297) on the same dams, below
// kasenbosai (310), which carries 江川/寺内/小石原川/大山 at 10-minute cadence.
// 筑後大堰 is published by no other source. Cron hourly at :50 (the page is
// regenerated at ~:37 past the hour).
//
// License: 水資源機構 利用ルール (water.go.jp/honsya/honsya/policy/copyright/)
// — 出典を記載すれば複製・公衆送信・加工・商用利用可; 数値データは著作権の対象外.

import { type BindableMaster, chooseRanked } from '@dam/core/dam_binding';
import { sql } from '@dam/db/client';
import { bindExternalId } from '@dam/db/repo/dams';
import { upsertObservations } from '@dam/db/repo/observations';
import { recordUniverse, type UniverseRow } from '@dam/db/repo/source_universe';
import type { Task } from 'graphile-worker';

const BASE_URL =
  process.env.JWA_CHIKUGO_RT_BASE_URL ?? 'http://chikugo.ec-net.jp/chikugo/kyoku/pc/new';

const SOURCE_ID = 'jwa-chikugo-rt';

export interface Station {
  /** The site's screen id (rep{code}_I60.html); also the stamp and universe key. */
  code: string;
  name: string;
  masterName: string;
  prefCodes: string[];
}

export const STATIONS: Station[] = [
  { code: 'EG', name: '江川ダム', masterName: '江川', prefCodes: ['40'] },
  { code: 'TR', name: '寺内ダム', masterName: '寺内', prefCodes: ['40'] },
  { code: 'KB', name: '小石原川ダム', masterName: '小石原川', prefCodes: ['40'] },
  { code: 'OY', name: '大山ダム', masterName: '大山', prefCodes: ['44'] },
  { code: 'CO', name: '筑後大堰', masterName: '筑後大堰', prefCodes: ['40'] },
];

// --- parsing ----------------------------------------------------------------

export interface ParsedRow {
  observedAt: Date;
  waterLevelM: number | null;
  storageVolumeM3: number | null;
  /** 貯水率 as a 0..1 fraction; dams only. */
  storageRate: number | null;
  inflowM3s: number | null;
  outflowM3s: number | null;
  rainfallMm: number | null;
}

function cellText(raw: string): string {
  return raw
    .replace(/<[^>]*>/g, '')
    .replace(/&nbsp;/g, ' ')
    .replace(/&[a-z]+;/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

function cellValue(raw: string | undefined): number | null {
  const text = cellText(raw ?? '');
  if (!/^-?\d+(?:\.\d+)?$/.test(text)) return null;
  return Number(text);
}

/** Header label with units and line breaks dropped: "有効<br>貯水量<br>[千m³]" → "有効貯水量". */
function headerLabel(raw: string): string {
  return cellText(raw.replace(/\[[^\]]*\]/g, '')).replace(/\s/g, '');
}

/**
 * Every hourly row of one rep*_I60 page. Rows with no parsable time, or with
 * nothing but markers, are dropped; the station itself is still published.
 */
export function parseChikugoRtPage(html: string): ParsedRow[] {
  const labels = [...html.matchAll(/<td class="item"[^>]*>([\s\S]*?)<\/td>/g)].map((m) =>
    headerLabel(m[1] ?? ''),
  );
  const level = labels.findIndex((l) => l === '貯水位' || l === '貯水位水位');
  const volume = labels.indexOf('有効貯水量');
  const rate = labels.indexOf('貯水率');
  const inflow = labels.indexOf('流入量');
  const outflow = labels.indexOf('総放流量');
  const rain = labels.findIndex((l) => l.endsWith('時間雨量'));
  const at = (cells: string[], i: number): number | null => (i < 0 ? null : cellValue(cells[i]));

  const rows: ParsedRow[] = [];
  let date: { y: number; m: number; d: number } | null = null;
  for (const tr of html.matchAll(/<tr class="line\d"[^>]*>([\s\S]*?)<\/tr>/g)) {
    const cells = [...(tr[1] ?? '').matchAll(/<td[^>]*>([\s\S]*?)<\/td>/g)].map((c) => c[1] ?? '');
    const stamp = cellText(cells[0] ?? '').match(
      /^(?:(\d{4})\/(\d{2})\/(\d{2})\s+)?(\d{2}):(\d{2})$/,
    );
    if (!stamp) continue;
    if (stamp[1]) date = { y: Number(stamp[1]), m: Number(stamp[2]), d: Number(stamp[3]) };
    if (!date) continue;
    // JST → UTC; "24:00" rolls over to the next day through Date.UTC.
    const observedAt = new Date(
      Date.UTC(date.y, date.m - 1, date.d, Number(stamp[4]) - 9, Number(stamp[5])),
    );
    const volumeThou = at(cells, volume);
    const ratePct = at(cells, rate);
    const row: ParsedRow = {
      observedAt,
      waterLevelM: at(cells, level),
      storageVolumeM3: volumeThou === null ? null : volumeThou * 1_000,
      storageRate: ratePct === null ? null : ratePct / 100,
      inflowM3s: at(cells, inflow),
      outflowM3s: at(cells, outflow),
      rainfallMm: at(cells, rain),
    };
    if (
      row.waterLevelM === null &&
      row.storageVolumeM3 === null &&
      row.inflowM3s === null &&
      row.outflowM3s === null
    ) {
      continue;
    }
    rows.push(row);
  }
  return rows;
}

// --- matching ---------------------------------------------------------------

function stem(name: string): string {
  return name
    .normalize('NFKC')
    .replace(/\((?:元|再)\)$/, '')
    .replace(/ダム$/, '')
    .trim();
}

/**
 * The master for a station: the row already stamped with its code, else the
 * row whose name is the station's (（元）/（再） alike, so preferMaster picks the
 * live twin). No prefix or substring fallback — these five names are exact in
 * the master, and a looser match would only ever find a different dam.
 */
export function chooseMaster(station: Station, masters: BindableMaster[]): bigint | null {
  const candidates = masters
    .filter((m) => m.stamp === station.code || stem(m.name) === station.masterName)
    .map((m) => ({ ...m, rank: 0 }));
  return chooseRanked(candidates, station.code)?.id ?? null;
}

// --- DB helpers -------------------------------------------------------------

async function ensureSourcePriority(): Promise<void> {
  await sql`
    INSERT INTO source_priorities (source_id, priority, description, active)
    VALUES (${SOURCE_ID}, 298,
            '水資源機構 筑後川局 水管理情報WEB — hourly, 5 施設 (江川/寺内/小石原川/大山/筑後大堰)',
            true)
    ON CONFLICT (source_id) DO UPDATE
      SET priority    = EXCLUDED.priority,
          description = EXCLUDED.description,
          active      = EXCLUDED.active
  `;
}

async function matchMaster(log: (s: string) => void): Promise<Map<string, bigint>> {
  const prefCodes = [...new Set(STATIONS.flatMap((s) => s.prefCodes))];
  const masters = await sql<(BindableMaster & { prefCode: string })[]>`
    SELECT id, name, pref_code AS "prefCode", completed_year AS "completedYear",
           external_ids->>${SOURCE_ID} AS stamp
    FROM dams WHERE pref_code = ANY(${prefCodes}::text[]) ORDER BY id
  `;
  const damByCode = new Map<string, bigint>();
  // What this source publishes, matched or not — recorded so /coverage can
  // say "they publish it, we failed to link it" instead of guessing.
  const universe: UniverseRow[] = [];
  for (const s of STATIONS) {
    const damId = chooseMaster(
      s,
      masters.filter((m) => s.prefCodes.includes(m.prefCode)),
    );
    universe.push({
      externalId: s.code,
      name: s.name,
      prefCode: s.prefCodes[0] ?? null,
      resolvedDamId: damId,
    });
    if (!damId) {
      log(`${SOURCE_ID}: no master match for "${s.name}" (${s.code})`);
      continue;
    }
    damByCode.set(s.code, damId);
    await bindExternalId(damId, SOURCE_ID, s.code);
  }
  await recordUniverse(SOURCE_ID, universe);
  return damByCode;
}

// --- task -------------------------------------------------------------------

const task: Task = async (_payload, helpers) => {
  const log = (s: string): void => helpers.logger.info(s);
  await ensureSourcePriority();

  // Resolved before the fetches so a dead page still leaves a scan on record.
  const damByCode = await matchMaster(log);

  const headers = {
    'user-agent':
      process.env.HTTP_USER_AGENT ??
      'DamDataPlatform/0.1 (+https://dam.teraren.com/legal/terms; contact: https://discord.gg/UbWqspWbAk)',
  };

  const inputs = [] as Parameters<typeof upsertObservations>[0];
  let parsed = 0;
  for (const s of STATIONS) {
    const damId = damByCode.get(s.code);
    if (!damId) continue;
    const r = await fetch(`${BASE_URL}/rep${s.code}_I60.html`, {
      headers,
      signal: AbortSignal.timeout(20_000),
    });
    if (r.status !== 200) {
      log(`${SOURCE_ID}: HTTP ${r.status} for ${s.name}; skipping`);
      continue;
    }
    const rows = parseChikugoRtPage(new TextDecoder('shift_jis').decode(await r.arrayBuffer()));
    parsed += rows.length;
    log(
      `${SOURCE_ID}: ${s.name} ${rows.length} rows, latest ${rows.at(-1)?.observedAt.toISOString() ?? '(none)'}`,
    );
    for (const p of rows) {
      inputs.push({
        observedAt: p.observedAt,
        damId,
        sourceId: SOURCE_ID,
        storageVolumeM3: p.storageVolumeM3,
        storageRate: p.storageRate,
        inflowM3s: p.inflowM3s,
        outflowM3s: p.outflowM3s,
        waterLevelM: p.waterLevelM,
        rainfallMm: p.rainfallMm,
        rawSnapshotId: null,
        qualityFlag: 0,
      });
    }
  }

  const written = await upsertObservations(inputs);
  log(`${SOURCE_ID} done: parsed=${parsed} matched=${damByCode.size} written=${written}`);
};

export default task;
