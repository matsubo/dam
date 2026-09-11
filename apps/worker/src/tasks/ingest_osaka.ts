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
// chooseMaster breaks the tie by preferring （再）over （元）since rebuilt dams
// are the operational ones (confirmed: 狭山池（再）total_capacity_m3 = 2,800,000
// matches the API's storageCapacity exactly).
//
// Cron: hourly at :31.

import { sql } from '@dam/db/client';
import { upsertObservations } from '@dam/db/repo/observations';
import { recordUniverse, type UniverseRow } from '@dam/db/repo/source_universe';
import type { Task } from 'graphile-worker';

const DATA_URL =
  process.env.OSAKA_DAM_URL ??
  'https://www.osaka-kasen-portal.net/suibou/publicdata/choryuryo.json';
const PREF_CODE = '27';
const SOURCE_ID = 'osaka-bousai';

const TYPE_DAM = '3';

interface OsakaFacility {
  facilityId: string;
  facilityNm: string;
  typeId: string;
  storageRate: string;
  storageData: string;
  storageCapacity: string;
}

interface OsakaResponse {
  keikaList: OsakaFacility[];
  displayDt: string;
}

export interface ParsedRow {
  facilityId: string;
  facilityNm: string;
  observedAt: Date;
  storageVolumeM3: number | null;
  storageRate: number | null;
}

/** Parse 「YYYYMMDDHHMM」 (JST) → UTC Date. */
export function parseOsakaTimestamp(s: string): Date | null {
  const m = s.match(/^(\d{4})(\d{2})(\d{2})(\d{2})(\d{2})$/);
  if (!m) return null;
  return new Date(
    Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3]), Number(m[4]) - 9, Number(m[5])),
  );
}

/** Strip ダム suffix and （再）/（元）annotations from a name. */
export function normalizeName(s: string): string {
  return s
    .replace(/[（(][^）)]*[）)]/g, '')
    .replace(/ダム$/, '')
    .trim();
}

/** Parse dam entries from the response, skipping non-dam facility types. */
export function parseOsakaItems(res: OsakaResponse): ParsedRow[] {
  const observedAt = parseOsakaTimestamp(res.displayDt ?? '');
  if (!observedAt) return [];

  const out: ParsedRow[] = [];
  for (const f of res.keikaList ?? []) {
    if (f.typeId !== TYPE_DAM) continue;
    const vol = Number(f.storageData);
    const rate = Number(f.storageRate);
    out.push({
      facilityId: f.facilityId,
      facilityNm: f.facilityNm,
      observedAt,
      storageVolumeM3: Number.isFinite(vol) && vol > 0 ? vol : null,
      storageRate: Number.isFinite(rate) ? Math.max(0, Math.min(1, rate / 100)) : null,
    });
  }
  return out;
}

async function ensureSourcePriority(): Promise<void> {
  await sql`
    INSERT INTO source_priorities (source_id, priority, description, active)
    VALUES (${SOURCE_ID}, 310,
            '大阪府河川防災情報 — hourly, 3 県管理ダム (JSON feed, 1分更新)',
            true)
    ON CONFLICT (source_id) DO UPDATE
      SET priority    = EXCLUDED.priority,
          description = EXCLUDED.description,
          active      = EXCLUDED.active
  `;
}

interface DamMatch {
  facilityId: string;
  damId: bigint;
}

/**
 * Pick the best master dam for a facility name. When the stem matches both
 * （元）and（再）variants at equal rank, prefer（再）because rebuilt dams are
 * the operational ones (e.g., 狭山池ダム → 狭山池（再）not 狭山池（元）).
 */
export function chooseMaster(stem: string, masters: { id: bigint; name: string }[]): bigint | null {
  let best: { id: bigint; rank: number; rebuilt: boolean } | null = null;
  for (const m of masters) {
    const mStem = normalizeName(m.name);
    let rank: number;
    if (mStem === stem) rank = 0;
    else if (m.name === `${stem}ダム`) rank = 1;
    else if (mStem.startsWith(stem)) rank = 2;
    else if (mStem.includes(stem)) rank = 3;
    else continue;
    const rebuilt = m.name.includes('（再）');
    if (
      !best ||
      rank < best.rank ||
      (rank === best.rank && rebuilt && !best.rebuilt) ||
      (rank === best.rank && rebuilt === best.rebuilt && m.id < best.id)
    ) {
      best = { id: m.id, rank, rebuilt };
    }
  }
  return best?.id ?? null;
}

async function matchMaster(rows: ParsedRow[], log: (s: string) => void): Promise<DamMatch[]> {
  const masters = await sql<{ id: bigint; name: string }[]>`
    SELECT id, name FROM dams WHERE pref_code = ${PREF_CODE} ORDER BY id
  `;
  const out: DamMatch[] = [];
  // What this source publishes, matched or not — recorded so /coverage can
  // say "they publish it, we failed to link it" instead of guessing. Every
  // typeId=3 facility belongs here: the feed lists a dam whether or not this
  // snapshot carried 貯水量/貯水率 for it.
  const universe: UniverseRow[] = [];
  for (const r of rows) {
    const stem = normalizeName(r.facilityNm);
    if (!stem) continue;
    const damId = chooseMaster(stem, masters);
    universe.push({
      externalId: r.facilityId,
      name: r.facilityNm,
      prefCode: PREF_CODE,
      resolvedDamId: damId,
    });
    if (!damId) {
      log(`${SOURCE_ID}: no master match for ${r.facilityNm} (${r.facilityId})`);
      continue;
    }
    out.push({ facilityId: r.facilityId, damId });
    await sql`
      UPDATE dams
      SET external_ids = COALESCE(external_ids, '{}'::jsonb)
                       || jsonb_build_object(${SOURCE_ID}::text, ${r.facilityId}::text)
      WHERE id = ${damId}
        AND COALESCE(external_ids->>${SOURCE_ID}, '') <> ${r.facilityId}
    `;
  }
  await recordUniverse(SOURCE_ID, universe);
  return out;
}

const task: Task = async (_payload, helpers) => {
  const log = (s: string): void => helpers.logger.info(s);
  await ensureSourcePriority();

  const ua =
    process.env.HTTP_USER_AGENT ??
    'DamDataPlatform/0.1 (+https://dam.teraren.com/legal/terms; contact: https://discord.gg/UbWqspWbAk)';

  const res = await fetch(DATA_URL, {
    headers: { 'user-agent': ua },
    signal: AbortSignal.timeout(15_000),
  });
  if (!res.ok) {
    log(`${SOURCE_ID}: HTTP ${res.status}; abort`);
    return;
  }
  const data = (await res.json()) as OsakaResponse;
  const parsed = parseOsakaItems(data);
  log(`${SOURCE_ID}: parsed ${parsed.length} dams at ${data.displayDt}`);

  const matches = await matchMaster(parsed, log);
  const damByFacility = new Map(matches.map((m) => [m.facilityId, m.damId]));

  const inputs = [] as Parameters<typeof upsertObservations>[0];
  for (const p of parsed) {
    const damId = damByFacility.get(p.facilityId);
    if (!damId) continue;
    inputs.push({
      observedAt: p.observedAt,
      damId,
      sourceId: SOURCE_ID,
      storageVolumeM3: p.storageVolumeM3,
      storageRate: p.storageRate,
      inflowM3s: null,
      outflowM3s: null,
      waterLevelM: null,
      rainfallMm: null,
      rawSnapshotId: null,
      qualityFlag: 0,
    });
  }
  const written = await upsertObservations(inputs);
  log(`${SOURCE_ID} done: parsed=${parsed.length} matched=${matches.length} written=${written}`);
};

export default task;
