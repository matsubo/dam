// apps/worker/src/tasks/ingest_jwa_kiso_rt.ts
//
// 水資源機構 中部支社 木曽川水系 — every facility on the 木曽川 real-time map.
// The page updates every ~10 minutes; one page is fetched hourly.
//
//   dams     牧尾 (長野) / 味噌川 (長野) / 阿木川 / 岩屋 / 徳山 (岐阜)
//            貯水位 (EL.m), 有効貯水量 (10³m³), 流入量, 放流量
//   調整池    打上 (岐阜, 貯水位 only) / 中里貯水池 / 宮川 / 菰野 / 加佐登 (三重,
//            三重用水; 貯水位, 有効貯水量)
//   堰       長良川河口堰 (三重) 堰上流水位, 堰下流水位, 流入量, 流出量
//            木曽川大堰 (愛知) 堰上流水位, 流入量, 放流量
//
// Source: https://www.water.go.jp/mizu/chubu/realtime/index.html, parsed by
// jwa_chubu_realtime.ts. 有効貯水量 is stored as the volume (× 1000); the page
// prints no rate, so the trigger derives one from the master's capacity. A
// weir's 堰上流水位 is stored as its level, as jwa-tonekako does for 利根川河口堰,
// and its 流出量 / 放流量 as the outflow.
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
// Priority 297: above jwa-chubu (296, daily) on the five dams and 中里, and
// above mie-kigyo (291, weekly) on 菰野調整池; below kasenbosai (310) on
// 打上調整池 / 加佐登調整池 / 木曽川大堰. 宮川調整池 and 長良川河口堰 have no
// other source.

import { sql } from '@dam/db/client';
import { upsertObservations } from '@dam/db/repo/observations';
import { recordUniverse } from '@dam/db/repo/source_universe';
import type { Task } from 'graphile-worker';
import {
  matchFacilities,
  parseJwaChubuRealtime,
  type RealtimeFacility,
} from './jwa_chubu_realtime.ts';

const SOURCE_ID = 'jwa-kiso-rt';
const PAGE_URL =
  process.env.JWA_KISO_RT_URL ?? 'https://www.water.go.jp/mizu/chubu/realtime/index.html';

/**
 * Every facility on the map as of 2026-09-28. The prefecture is what keeps
 * 中里貯水池 (三重用水, いなべ市) off a 長野 '中里' that once held its stamp.
 */
const PREF_BY_NAME: Record<string, string> = {
  牧尾ダム: '20',
  味噌川ダム: '20',
  阿木川ダム: '21',
  岩屋ダム: '21',
  徳山ダム: '21',
  打上調整池: '21',
  中里貯水池: '24',
  宮川調整池: '24',
  菰野調整池: '24',
  加佐登調整池: '24',
  長良川河口堰: '24',
  木曽川大堰: '23',
};

export interface KisoReading {
  name: string;
  waterLevelM: number | null;
  storageVolumeM3: number | null;
  inflowM3s: number | null;
  outflowM3s: number | null;
}

/** The stored quantities of each facility; one with none of them is dropped. */
export function kisoReadings(facilities: RealtimeFacility[]): KisoReading[] {
  const rows: KisoReading[] = [];
  for (const f of facilities) {
    const v = f.values;
    const volumeThou = v.有効貯水量 ?? null;
    const row = {
      name: f.name,
      waterLevelM: v.貯水位 ?? v.堰上流水位 ?? null,
      storageVolumeM3: volumeThou === null ? null : volumeThou * 1000,
      inflowM3s: v.流入量 ?? null,
      outflowM3s: v.放流量 ?? v.流出量 ?? null,
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

export function matchKiso(facilities: RealtimeFacility[], log: (s: string) => void) {
  return matchFacilities(SOURCE_ID, facilities, PREF_BY_NAME, log);
}

async function ensureSourcePriority(): Promise<void> {
  await sql`
    INSERT INTO source_priorities (source_id, priority, description, active)
    VALUES (${SOURCE_ID}, 297,
            '水資源機構 中部支社 木曽川水系 実時計 — hourly, 12 facilities (5 dams, 三重用水 中里 + 調整池, 長良川河口堰, 木曽川大堰)',
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
  const { damByName, universe } = await matchKiso(facilities, log);
  await recordUniverse(SOURCE_ID, universe);

  const inputs = [] as Parameters<typeof upsertObservations>[0];
  for (const row of kisoReadings(facilities)) {
    const damId = damByName.get(row.name);
    if (!damId) continue;
    inputs.push({
      observedAt,
      damId,
      sourceId: SOURCE_ID,
      storageVolumeM3: row.storageVolumeM3,
      storageRate: null, // no rate on the page; the trigger derives one from the volume
      inflowM3s: row.inflowM3s,
      outflowM3s: row.outflowM3s,
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
