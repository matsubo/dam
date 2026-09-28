// apps/worker/src/tasks/ingest_jwa_toyokawa.ts
//
// 水資源機構 中部支社 豊川水系 — every facility on the 豊川用水 real-time map.
// The page updates every ~10 minutes; one page is fetched hourly.
//
//   dams      宇連 / 大島                 貯水位 (EL.m), 有効貯水量 (10³m³), 流入量
//   調整池     大原 / 三ツ口池 / 万場 / 芦ヶ池 / 初立池 / 駒場池 / 蒲郡
//                                         貯水位 (EL.m), 有効貯水量 (10³m³)
//   頭首工     大入 / 振草 / 大野 / 牟呂松原 / 寒狭川   貯水位 (m)
//
// Source: https://www.water.go.jp/mizu/chubu/realtime/index_2.html, parsed by
// jwa_chubu_realtime.ts. Every facility is in 愛知. 有効貯水量 is stored as the
// volume (× 1000); the page prints no rate, so the trigger derives one from
// the master's capacity (調整池 on 2026-09-28: 万場 4,861 / 有効 5,000 千m³,
// 大原 1,956 / 2,000, 初立池 1,485 / 1,600, 駒場池 721 / 800, 蒲郡 467 / 500).
// The only outflow printed is 放流量（利水）, the water-supply release, not the
// total (大島: 0.00 while kasenbosai's total was > 0 at 49 of 61 shared
// timestamps), so no outflow is stored.
//
// The 頭首工 unit is a bare "m" and is not always an elevation: 大入 0.84 and
// 振草 3.42 are gauge heights. 大野頭首工's is EL: its 施設情報 page
// (realtime/p020313_60/305_1_1.html, 2026-09-28) gives 常時満水位 78.00 m and
// 最低水位 68.20 m around readings of 77.3–77.5 m. 大野 is the only 頭首工 in
// the NDI master; 三ツ口池, 芦ヶ池調整池 and the other four 頭首工 are not, and
// migration 0211 records them as not master dams.
//
// License: 水資源機構「著作権・リンク等について」(honsya/honsya/policy/copyright):
//         「数値データ、簡単な表・グラフ等は著作権の対象ではありませんので、これらに
//         ついては本利用ルールの適用はなく、自由に利用できます。」 The 中部支社
//         リアルタイム情報 note (mizu/chubu/res/description/description.pdf) asks:
//         「ツール等による、自動的なデータ収集等はサーバに負荷がかかり、情報提供
//         できなくなる恐れがありますのでご遠慮頂くよう、ご理解・ご協力をお願い
//         いたします。」 Kept on that basis (user decision, 2026-09-28): only the
//         observed numbers are stored, with the source named, and the fetch is one
//         page an hour (the page itself refreshes every 10 minutes).
//
// Priority 298: above aitoyo (295) and jwa-junpo on 宇連/大島, which they
// publish daily / every 10 days; below kasenbosai (310) there. The 調整池 and
// 大野頭首工 have no other source.

import { sql } from '@dam/db/client';
import { upsertObservations } from '@dam/db/repo/observations';
import { recordUniverse } from '@dam/db/repo/source_universe';
import type { Task } from 'graphile-worker';
import {
  matchFacilities,
  parseJwaChubuRealtime,
  type RealtimeFacility,
} from './jwa_chubu_realtime.ts';

const SOURCE_ID = 'jwa-toyokawa';
const PAGE_URL =
  process.env.JWA_TOYOKAWA_URL ?? 'https://www.water.go.jp/mizu/chubu/realtime/index_2.html';

/** Every facility on the map as of 2026-09-28; all are in 愛知. */
const PREF_BY_NAME: Record<string, string> = {
  宇連ダム: '23',
  大島ダム: '23',
  大原調整池: '23',
  三ツ口池: '23',
  万場調整池: '23',
  芦ヶ池調整池: '23',
  初立池: '23',
  駒場池: '23',
  蒲郡調整池: '23',
  大入頭首工: '23',
  振草頭首工: '23',
  大野頭首工: '23',
  牟呂松原頭首工: '23',
  寒狭川頭首工: '23',
};

export interface ToyokawaReading {
  name: string;
  waterLevelM: number | null;
  storageVolumeM3: number | null;
  inflowM3s: number | null;
}

/** The stored quantities of each facility; one with none of them is dropped. */
export function toyokawaReadings(facilities: RealtimeFacility[]): ToyokawaReading[] {
  const rows: ToyokawaReading[] = [];
  for (const f of facilities) {
    const volumeThou = f.values.有効貯水量 ?? null;
    const row = {
      name: f.name,
      waterLevelM: f.values.貯水位 ?? null,
      storageVolumeM3: volumeThou === null ? null : volumeThou * 1000,
      inflowM3s: f.values.流入量 ?? null,
    };
    if (row.waterLevelM === null && row.storageVolumeM3 === null && row.inflowM3s === null) {
      continue;
    }
    rows.push(row);
  }
  return rows;
}

export function matchToyokawa(facilities: RealtimeFacility[], log: (s: string) => void) {
  return matchFacilities(SOURCE_ID, facilities, PREF_BY_NAME, log);
}

async function ensureSourcePriority(): Promise<void> {
  await sql`
    INSERT INTO source_priorities (source_id, priority, description, active)
    VALUES (${SOURCE_ID}, 298,
            '水資源機構 中部支社 豊川水系 — real-time (~10 min), 14 facilities (宇連/大島 + 豊川用水 調整池・頭首工)',
            true)
    ON CONFLICT (source_id) DO UPDATE
      SET priority    = EXCLUDED.priority,
          description = EXCLUDED.description,
          active      = EXCLUDED.active
  `;
}

const task: Task = async (_payload, helpers) => {
  const log = (s: string): void => helpers.logger.info(s);
  await ensureSourcePriority();

  const r = await fetch(PAGE_URL, {
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
  const { observedAt, facilities } = parseJwaChubuRealtime(await r.text());
  if (!observedAt || facilities.length === 0) {
    throw new Error(
      `${SOURCE_ID}: no 観測時刻 or no facility blocks on ${PAGE_URL} — layout change?`,
    );
  }

  // What this source publishes, matched or not — recorded so /coverage can
  // say "they publish it, we failed to link it" instead of guessing.
  const { damByName, universe } = await matchToyokawa(facilities, log);
  await recordUniverse(SOURCE_ID, universe);

  const readings = toyokawaReadings(facilities);
  const inputs = [] as Parameters<typeof upsertObservations>[0];
  for (const row of readings) {
    const damId = damByName.get(row.name);
    if (!damId) continue;
    inputs.push({
      observedAt,
      damId,
      sourceId: SOURCE_ID,
      storageVolumeM3: row.storageVolumeM3,
      storageRate: null, // no rate on the page; the trigger derives one from the volume
      inflowM3s: row.inflowM3s,
      outflowM3s: null, // only 放流量（利水） is published, not the total release
      waterLevelM: row.waterLevelM,
      rainfallMm: null,
      rawSnapshotId: null,
      qualityFlag: 0,
    });
  }
  const written = await upsertObservations(inputs);
  log(
    `${SOURCE_ID} done at ${observedAt.toISOString()}: parsed=${facilities.length} ` +
      `matched=${damByName.size} written=${written}`,
  );
};

export default task;
