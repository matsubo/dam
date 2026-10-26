// apps/worker/src/tasks/ingest_osaka.ts
//
// 大阪府河川防災情報 dam telemetry.
//
// Source: https://www.osaka-kasen-portal.net/suibou/publicdata/choryuryo.json
// The JSON is fetched directly (no pointer file needed); all facilities share
// one `displayDt` timestamp in YYYYMMDDHHMM JST format.
//
// The feed covers multiple facility types (地下河川 typeId=0, 遊水地 typeId=1,
// 調節池 typeId=2) plus ダム (typeId=3). We filter to typeId=3 only:
//   facilityId 35 → 安威川ダム (茨木市)
//   facilityId 36 → 箕面川ダム (箕面市)
//   facilityId 37 → 狭山池ダム (大阪狭山市) ← mapped to 狭山池（再）
//
// Values:
//   storageData     → effective storage (m³, absolute)
//   storageCapacity → capacity (m³, for cross-check only; not stored)
//   storageRate     → % of capacity (string, e.g. "65.4")
//
// No level, inflow, or outflow fields are published.
//
// Master match note: 狭山池（再）and 狭山池（元）both normalize to the same stem.
// 狭山池（再） is the dam in service, completed 2001 (pref.osaka.lg.jp
// /o130100/damusabo/dam/sayama.html 「完成した狭山池ダム」; ダム便覧 1440),
// and its total_capacity_m3 = 2,800,000 matches the API's storageCapacity.
// The entry names the （再） row outright, because the master row carries no
// ダム便覧 link, so the year is never refreshed and the binding must not
// depend on it.
//
// Cron: hourly at :31.

import { ingestTask } from '../ingest/run.ts';
import type { Entry, Reading } from '../ingest/types.ts';

const DATA_URL =
  process.env.OSAKA_DAM_URL ??
  'https://www.osaka-kasen-portal.net/suibou/publicdata/choryuryo.json';
const PREF_CODE = '27';
const SOURCE_ID = 'osaka-bousai';

const TYPE_DAM = '3';
/** 狭山池ダム's facilityId: the in-service （再） master row, by name. */
const SAYAMAIKE = '37';

interface OsakaFacility {
  facilityId: string;
  facilityNm: string;
  typeId: string;
  storageRate: string;
  storageData: string;
  storageCapacity: string;
}

export interface OsakaResponse {
  keikaList: OsakaFacility[];
  displayDt: string;
}

/** Parse 「YYYYMMDDHHMM」 (JST) → UTC Date. */
export function parseOsakaTimestamp(s: string): Date | null {
  const m = s.match(/^(\d{4})(\d{2})(\d{2})(\d{2})(\d{2})$/);
  if (!m) return null;
  return new Date(
    Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3]), Number(m[4]) - 9, Number(m[5])),
  );
}

function num(s: string | undefined): number | null {
  const t = s?.trim();
  if (!t) return null;
  const n = Number(t);
  return Number.isFinite(n) ? n : null;
}

/**
 * Every typeId=3 facility is an entry: the feed lists a dam whether or not
 * this snapshot carried 貯水量/貯水率 for it. Other facility types (地下河川,
 * 遊水地, 調節池) are not dams and are not part of this source's universe.
 */
export function osakaEntries(res: OsakaResponse): Entry[] {
  const observedAt = parseOsakaTimestamp(res.displayDt ?? '');
  const out: Entry[] = [];
  for (const f of res.keikaList ?? []) {
    if (f.typeId !== TYPE_DAM) continue;
    let reading: Reading;
    if (!observedAt) reading = { state: 'unreadable', why: `displayDt "${res.displayDt}"` };
    else {
      const vol = num(f.storageData);
      const rate = num(f.storageRate);
      reading = {
        state: 'values',
        observations: [
          {
            observedAt,
            storageVolumeM3: vol != null && vol > 0 ? vol : null,
            storageRate: rate != null ? Math.max(0, Math.min(1, rate / 100)) : null,
          },
        ],
      };
    }
    out.push({
      key: f.facilityId,
      name: f.facilityNm,
      pref: PREF_CODE,
      ...(f.facilityId === SAYAMAIKE ? { bind: { name: '狭山池（再）' } } : {}),
      reading,
    });
  }
  return out;
}

export default ingestTask(SOURCE_ID, async (log) => {
  const res = await fetch(DATA_URL, {
    headers: {
      'user-agent':
        process.env.HTTP_USER_AGENT ??
        'DamDataPlatform/0.1 (+https://dam.teraren.com/legal/terms; contact: https://discord.gg/UbWqspWbAk)',
    },
    signal: AbortSignal.timeout(15_000),
  });
  if (!res.ok) throw new Error(`${SOURCE_ID}: HTTP ${res.status}`);
  const data = (await res.json()) as OsakaResponse;
  const entries = osakaEntries(data);
  log(`${SOURCE_ID}: ${entries.length} dams at ${data.displayDt}`);
  return { entries };
});
