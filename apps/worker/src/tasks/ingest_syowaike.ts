// apps/worker/src/tasks/ingest_syowaike.ts
//
// 兵庫県 昭和池防災情報管理システム — 昭和池 (加東市馬瀬, 加古川水系, 兵庫/28),
// a 兵庫県-managed irrigation reservoir (NDI 1539, 有効貯水容量 1,500 千m³)
// that no other live source publishes.
//
// Source: the system's public テレメータデータ page (Windows-31J HTML), a
// single snapshot the site says is 「10分毎に更新」:
//   http://www.syowaike.jp/public/DamData.jsp
//
//   更新時刻：YYYY/MM/DD HH:MM:SS (JST); 0000/00/00 would mean offline.
//   One <tr> per item, label cell bgcolor #aaffaa, value cell #ccccff when
//   正常 and #ff8080 when 無効/欠測 (the page's own legend):
//     貯水位(m)      → water level (EL)
//     貯水量(m³)     → storage volume, already m³
//     貯水率(%)      — integer only; not stored. 183,800 / 1,500,000 = 12.3 %
//                      against a printed 12, so the 0051 trigger derives the
//                      same figure from the volume at full precision.
//     流入量(m³/s)   → inflow
//     越流量(m³/s)   — not stored as outflow. Term.html defines it as what
//                      spills over the 洪水吐; the release through the intake
//                      (放流量) is a separate figure this page does not
//                      publish, so 越流量 would read 0 while irrigation draws
//                      the pool down.
//     流入水位(m)    — gauge stage on the inflow channel; not stored.
//     時間雨量(mm)   → rainfall (「毎時00分の過去1時間」)
//
// Licence: the top page's 利用における注意事項 carries only an accuracy
// caveat and 「兵庫県は何ら責任を負うものではありません」; no reuse or tool
// restriction. robots.txt is 404.
//
// Priority 299. Cron hourly at :23 (the page updated at :01/:21/:41 while
// this was written).

import { sql } from '@dam/db/client';
import { bindExternalId } from '@dam/db/repo/dams';
import { upsertObservations } from '@dam/db/repo/observations';
import { recordUniverse } from '@dam/db/repo/source_universe';
import type { Task } from 'graphile-worker';

const PAGE_URL = process.env.SYOWAIKE_URL ?? 'http://www.syowaike.jp/public/DamData.jsp';

const SOURCE_ID = 'syowaike';
const PREF_CODE = '28';
/** The page publishes one reservoir and no station code; its name is the key. */
const STATION = '昭和池';
// Nine masters are named 昭和池, two of them in 兵庫: NDI 1539 is 兵庫県's
// 1,502 千m³ reservoir at 加東市馬瀬 (this system's 「兵庫加東地区昭和池」),
// NDI 1583 淡路町's 62 千m³ pond in 淡路市. Name matching cannot tell them
// apart, so the binding is pinned.
const NDI = '1539';

export interface SyowaikeReading {
  observedAt: Date;
  waterLevelM: number | null;
  storageVolumeM3: number | null;
  inflowM3s: number | null;
  rainfallMm: number | null;
}

/** Parse the テレメータデータ page; null when it carries no live 更新時刻. */
export function parseSyowaikeHtml(html: string): SyowaikeReading | null {
  const ts = html.match(/更新時刻[：:]\s*(\d{4})\/(\d{2})\/(\d{2})\s+(\d{2}):(\d{2})/);
  if (!ts || Number(ts[1]) === 0) return null;
  const observedAt = new Date(
    Date.UTC(Number(ts[1]), Number(ts[2]) - 1, Number(ts[3]), Number(ts[4]) - 9, Number(ts[5])),
  );

  const values = new Map<string, number | null>();
  for (const m of html.matchAll(
    /<td[^>]*bgcolor="#aaffaa"[^>]*>([\s\S]*?)<\/td>\s*<td[^>]*bgcolor="(#[0-9a-f]{6})"[^>]*>([\s\S]*?)<\/td>/gi,
  )) {
    const label = (m[1] ?? '').replace(/<[^>]+>/g, '').trim();
    const text = (m[3] ?? '').replace(/<[^>]+>|&nbsp;|[\s　,]/g, '');
    const valid = (m[2] ?? '').toLowerCase() !== '#ff8080' && /^-?\d+(?:\.\d+)?$/.test(text);
    values.set(label, valid ? Number(text) : null);
  }

  return {
    observedAt,
    waterLevelM: values.get('貯水位(m)') ?? null,
    storageVolumeM3: values.get('貯水量(m3)') ?? null,
    inflowM3s: values.get('流入量(m3/s)') ?? null,
    rainfallMm: values.get('時間雨量(mm)') ?? null,
  };
}

async function ensureSourcePriority(): Promise<void> {
  await sql`
    INSERT INTO source_priorities (source_id, priority, description, active)
    VALUES (${SOURCE_ID}, 299,
            '兵庫県 昭和池防災情報管理システム — 昭和池 (加東市, 10分更新 テレメータ HTML)',
            true)
    ON CONFLICT (source_id) DO UPDATE
      SET priority    = EXCLUDED.priority,
          description = EXCLUDED.description,
          active      = EXCLUDED.active
  `;
}

async function findDamId(log: (s: string) => void): Promise<bigint | null> {
  const [dam] = await sql<{ id: bigint }[]>`
    SELECT id FROM dams
    WHERE pref_code = ${PREF_CODE} AND external_ids->>'ndi' = ${NDI}
  `;
  // The one reservoir this page publishes, matched or not, so /coverage can
  // tell "published, not linked" from "nobody publishes it".
  await recordUniverse(SOURCE_ID, [
    { externalId: STATION, name: STATION, prefCode: PREF_CODE, resolvedDamId: dam?.id ?? null },
  ]);
  if (!dam) {
    log(`${SOURCE_ID}: no master with NDI ${NDI} in pref ${PREF_CODE}`);
    return null;
  }
  await bindExternalId(dam.id, SOURCE_ID, STATION);
  return dam.id;
}

const task: Task = async (_payload, helpers) => {
  const log = (s: string): void => helpers.logger.info(s);
  await ensureSourcePriority();

  const ua =
    process.env.HTTP_USER_AGENT ??
    'DamDataPlatform/0.1 (+https://dam.teraren.com/legal/terms; contact: https://discord.gg/UbWqspWbAk)';

  // Resolved before the fetch: the system publishes the reservoir whether or
  // not this run's page loads, and the universe must say so.
  const damId = await findDamId(log);

  const res = await fetch(PAGE_URL, {
    headers: { 'user-agent': ua },
    signal: AbortSignal.timeout(15_000),
  });
  if (res.status !== 200) {
    log(`${SOURCE_ID}: HTTP ${res.status}; abort`);
    return;
  }
  const reading = parseSyowaikeHtml(new TextDecoder('shift_jis').decode(await res.arrayBuffer()));
  if (!reading) {
    log(`${SOURCE_ID}: no live 更新時刻 on the page; abort`);
    return;
  }
  const { observedAt, waterLevelM, storageVolumeM3, inflowM3s, rainfallMm } = reading;
  if (
    waterLevelM === null &&
    storageVolumeM3 === null &&
    inflowM3s === null &&
    rainfallMm === null
  ) {
    log(`${SOURCE_ID}: all values missing at ${observedAt.toISOString()}; skip`);
    return;
  }
  if (!damId) return;

  const written = await upsertObservations([
    {
      observedAt,
      damId,
      sourceId: SOURCE_ID,
      storageVolumeM3,
      storageRate: null,
      inflowM3s,
      outflowM3s: null,
      waterLevelM,
      rainfallMm,
      rawSnapshotId: null,
      qualityFlag: 0,
    },
  ]);
  log(`${SOURCE_ID} done: parsed=1 matched=1 written=${written} at ${observedAt.toISOString()}`);
};

export default task;
