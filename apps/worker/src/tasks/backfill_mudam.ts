// apps/worker/src/tasks/backfill_mudam.ts
//
// Historical-depth backfill from NILIM ダム諸量データベース (mudam.nilim.go.jp).
// 600 dams across 9 regions × up to 27 years of daily 貯水位 / 流入量 / 放流量.
// The published values are confirmed/historical (1-2 year lag), so we use this
// as a foundational historical layer beneath the live real-time sources.
//
// Source: https://mudam.nilim.go.jp/
// Coverage: ~600 dams (hokkaido 37, tohoku 92, kanto 54, chubu 109, kinki 60,
//           chugoku 76, shikoku 43, kyushu 114, okinawa 15).
// License: 国の公式統計値, robots.txt allows all, CSV download endpoint open.
//
// Triggered ad-hoc (no cron — historical, runs on demand):
//   add_job('backfill:mudam', { district: 'kanto', years: 5 })
//   add_job('backfill:mudam', { district: 'all', years: 1 })  -- all 9, 1 year
//
// The CSV download endpoint:
//   GET https://mudam.nilim.go.jp/chronology/form02/download/csv
//        ?damsysId={id}&options=day&yearFrom=YYYY&yearTo=YYYY
//   → Shift_JIS CSV, columns: 年月日, 貯水位(m), 流入量(m³/s), 放流量(m³/s)
//   → No storage volume / rate directly (vol would require dam H-V curve we
//     don't have).
//
// Master matching strategy: by name proximity. For each mudam entry we have
// (id, lat, lng, name); we find the master dam whose name CONTAINS the mudam
// name (or vice-versa) AND whose location is within 10 km of (lat, lng). If
// no match within that window, the mudam entry is logged and skipped. The
// listings that rule gets wrong are pinned in MUDAM_OVERRIDES.

import { type BindableMaster, chooseRanked } from '@dam/core/dam_binding';
import { sql } from '@dam/db/client';
import { bindExternalId } from '@dam/db/repo/dams';
import { upsertObservations } from '@dam/db/repo/observations';
import type { Task } from 'graphile-worker';

const BASE_URL = process.env.MUDAM_URL ?? 'https://mudam.nilim.go.jp';
const SLEEP_BETWEEN_FETCHES_MS = 2_000;

type DistrictKey =
  | 'hokkaido'
  | 'tohoku'
  | 'kanto'
  | 'chubu'
  | 'kinki'
  | 'chugoku'
  | 'shikoku'
  | 'kyushu'
  | 'okinawa';

const ALL_DISTRICTS: DistrictKey[] = [
  'hokkaido',
  'tohoku',
  'kanto',
  'chubu',
  'kinki',
  'chugoku',
  'shikoku',
  'kyushu',
  'okinawa',
];

interface BackfillPayload {
  /** District to walk; 'all' iterates every region sequentially. Default 'kanto'. */
  district?: DistrictKey | 'all';
  /** Years of historical CSV to fetch per dam. Default 5. */
  years?: number;
}

interface MudamDam {
  damsysId: number;
  lat: number;
  lng: number;
  name: string;
}

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

function userAgent(): string {
  return (
    process.env.HTTP_USER_AGENT ??
    'DamDataPlatform/0.1 (+https://dam.teraren.com/legal/terms; contact: https://discord.gg/UbWqspWbAk)'
  );
}

/**
 * The district map pages embed dam metadata as inline JS:
 *   markersInfo.push([33, 36.804306, 139.036722, "藤原"]);
 * We parse that out — no HTML walk needed.
 */
export function parseDistrictDams(html: string): MudamDam[] {
  const out: MudamDam[] = [];
  const re = /markersInfo\.push\(\[(\d+),\s*([\d.-]+),\s*([\d.-]+),\s*"([^"]+)"\]\)/g;
  let m: RegExpExecArray | null;
  // biome-ignore lint/suspicious/noAssignInExpressions: idiomatic regex iteration
  while ((m = re.exec(html)) !== null) {
    out.push({
      damsysId: Number(m[1]),
      lat: Number(m[2]),
      lng: Number(m[3]),
      name: m[4] ?? '',
    });
  }
  return out;
}

/**
 * mudam.nilim.go.jp serves an intermediate-only TLS chain that Bun's
 * bundled root store can't verify. Rather than disable TLS verification
 * globally (would weaken every outbound call from the worker), we shell
 * out to `curl`, which uses the OS CA bundle and resolves the chain
 * correctly. The Dockerfile.worker installs curl.
 */
async function curlFetch(
  url: string,
  timeoutS = 20,
): Promise<{ status: number; body: Uint8Array }> {
  const proc = Bun.spawn(
    [
      'curl',
      '-sL',
      '--max-time',
      String(timeoutS),
      '-A',
      `Mozilla/5.0 ${userAgent()}`,
      '-w',
      '%{http_code}',
      '-o',
      '-',
      url,
    ],
    { stdout: 'pipe', stderr: 'pipe' },
  );
  const buf = await new Response(proc.stdout).arrayBuffer();
  const exit = await proc.exited;
  if (exit !== 0) throw new Error(`curl exited ${exit}: ${url}`);
  // curl with -w '%{http_code}' appends the 3-digit status at the very end.
  const bytes = new Uint8Array(buf);
  if (bytes.length < 3) throw new Error(`curl response too short: ${url}`);
  const statusStr = new TextDecoder('ascii').decode(bytes.slice(bytes.length - 3));
  const status = Number(statusStr);
  const body = bytes.slice(0, bytes.length - 3);
  return { status, body };
}

async function fetchDistrict(district: DistrictKey): Promise<MudamDam[]> {
  const { status, body } = await curlFetch(`${BASE_URL}/districtMap/${district}`, 20);
  if (status !== 200) throw new Error(`district ${district} HTTP ${status}`);
  return parseDistrictDams(new TextDecoder('utf-8').decode(body));
}

interface CsvRow {
  observedAt: Date;
  waterLevelM: number | null;
  inflowM3s: number | null;
  outflowM3s: number | null;
}

function parseNum(s: string): number | null {
  const t = s.trim();
  if (!t || t === '―' || t === '-' || t === '欠測') return null;
  const n = Number(t);
  return Number.isFinite(n) ? n : null;
}

function parseDateJst(s: string): Date | null {
  const m = s.trim().match(/^(\d{4})\/(\d{1,2})\/(\d{1,2})$/);
  if (!m) return null;
  const [, y, mo, d] = m;
  // Daily snapshots are 0:00 JST = 15:00 UTC the previous day.
  return new Date(Date.UTC(Number(y), Number(mo) - 1, Number(d) - 1, 15, 0, 0, 0));
}

/** Parse a Shift_JIS CSV from form02/download. */
export function parseMudamCsv(text: string): CsvRow[] {
  const lines = text.split(/\r?\n/);
  const out: CsvRow[] = [];
  // First two lines are headers (dam name + column labels). Body starts at idx 2.
  for (let i = 2; i < lines.length; i += 1) {
    const line = lines[i];
    if (!line) continue;
    const cols = line.split(',');
    if (cols.length < 4) continue;
    const obs = parseDateJst(cols[0] ?? '');
    if (!obs) continue;
    const waterLevelM = parseNum(cols[1] ?? '');
    const inflowM3s = parseNum(cols[2] ?? '');
    const outflowM3s = parseNum(cols[3] ?? '');
    // The header says （※空欄はデータがなし）: a blank day is no observation,
    // and stored as an all-NULL row it read as coverage.
    if (waterLevelM == null && inflowM3s == null && outflowM3s == null) continue;
    out.push({ observedAt: obs, waterLevelM, inflowM3s, outflowM3s });
  }
  return out;
}

async function downloadYearCsv(damsysId: number, year: number): Promise<CsvRow[]> {
  const url = `${BASE_URL}/chronology/form02/download/csv?damsysId=${damsysId}&options=day&yearFrom=${year}&yearTo=${year}`;
  const { status, body } = await curlFetch(url, 30);
  if (status !== 200) return [];
  // Response is Shift_JIS; decode via TextDecoder.
  return parseMudamCsv(new TextDecoder('shift_jis').decode(body));
}

async function ensureSourcePriority(): Promise<void> {
  await sql`
    INSERT INTO source_priorities (source_id, priority, description, active, historical_only)
    VALUES ('mudam', 280,
            'NILIM ダム諸量データベース (mudam.nilim.go.jp) — daily, ~600 dams, 1-2 year lag (confirmed historical)',
            true, true)
    ON CONFLICT (source_id) DO UPDATE
      SET priority        = EXCLUDED.priority,
          description     = EXCLUDED.description,
          active          = EXCLUDED.active,
          -- Declared here as well as in migration 0058 so a fresh environment
          -- does not recreate the row inside the source_universe gate: a dump
          -- with no recurring scan would hold the gate open forever and no dam
          -- could ever be classified 提供元なし.
          historical_only = EXCLUDED.historical_only
  `;
}

interface MatchResult {
  damId: bigint;
  distanceM: number;
  damName: string;
}

/**
 * Listings the name/distance rule binds to the wrong row, pinned to the right
 * row's NDI id. Evidence is mudam's own 諸元 table
 * (/chronology/form01/<id>/2024: 堤高, 総/有効貯水容量), which matches the
 * pinned row exactly and not the one the rule picks, compared with prod's
 * rows on 2026-09-27.
 *
 * - 3 桂沢 → 新桂沢（再）. The names differ, so twinOf does not pair them and
 *   the old stamp kept the listing on 桂沢（元）. 新桂沢 is 桂沢 raised on the
 *   same axis (同軸嵩上げ, 63.6 → 75.5 m), completed 2024-03-31
 *   (https://www.hkd.mlit.go.jp/sp/ikushunbetu_damu/kluhh4000000byma.html).
 *   mudam keeps one listing and dam code; its 諸元 switch to the new body
 *   (75.5 m, 総 147,300 千m³) from 2024. The level first passes the old
 *   常時満水位 187.0 in 2023-11, when test impoundment began. One reservoir,
 *   one series: the whole history sits with the live sources on the （再）.
 * - 180 遠野第二 → 遠野第2 (23.1 m, 総 248), 310 上市川第二 → 上市川第2
 *   (67.0 m, 総 7,800). "遠野第二" contains "遠野" while the master spells
 *   第2, so the listing took 遠野 from 172 遠野 (and 310 took 上市川 from 309
 *   上市川).
 * - 54 丸山 → 丸山（元） (98.2 m, 総 79,520). 新丸山（再） is a new, higher
 *   body still being built (https://www.cbr.mlit.go.jp/shinmaru/), and
 *   its name does not pair with 丸山（元）.
 * - 435 木屋川 → 木屋川（元） (41.0 m, 総 21,750). The （再） is the 10 m
 *   raising Yamaguchi started in 2021
 *   (https://www.pref.yamaguchi.lg.jp/soshiki/132/23891.html).
 * - 369 大日 → 大日 (36.0 m, 総 1,100), not the nearer 大日川 whose name
 *   contains it (42.8 m, 総 2,099).
 * - 447 黒杭川上流 → 黒杭川上流 (48.0 m, 総 450), not the nearer 黒杭 whose
 *   name it contains (16.9 m, 総 246).
 * - 366 長谷（兵庫県） → Hyogo's 長谷 on 千種川水系長谷川 (30.3 m, 総 240).
 *   The district-map marker sits on Kansai Electric's 102 m 長谷 in 神河,
 *   30 km away; mudam's 諸元 give 34°56'23" 134°26'40", Hyogo's 長谷.
 * - 524 小ヶ倉 → Nagasaki City's 小ヶ倉 on 鹿尾川 (41.2 m, 総 2,040). The
 *   marker sits on the prefecture's 21.1 m 小ヶ倉 22 km away; mudam's 諸元
 *   give 32°42'58" 129°52'35", Nagasaki City's.
 */
export const MUDAM_OVERRIDES: Readonly<Record<number, string>> = {
  3: '156',
  54: '901',
  180: '257',
  310: '1108',
  366: '1573',
  369: '1593',
  435: '2025',
  447: '1991',
  524: '2609',
};

/**
 * Match a mudam dam to a master dam by (a) name overlap and (b) location
 * proximity. Returns the closest match within `radiusM` whose name contains
 * the mudam name (or vice-versa, allowing the 「ダム」 suffix to be omitted
 * either side). Null if no acceptable match.
 *
 * A listing in MUDAM_OVERRIDES goes to that NDI row and nowhere else. Other
 * than that, a row already stamped with this damsysId keeps it. The （元） and
 * （再） of one dam rank at the nearer twin's distance (花山's share
 * coordinates), so the current structure wins instead of whichever row the
 * sort met first.
 */
export async function matchMaster(mudam: MudamDam, radiusM = 10_000): Promise<MatchResult | null> {
  const point = sql`ST_SetSRID(ST_MakePoint(${mudam.lng}, ${mudam.lat}), 4326)::geography`;
  const ndi = MUDAM_OVERRIDES[mudam.damsysId];
  if (ndi) {
    const [pinned] = await sql<{ id: bigint; name: string; dist: number }[]>`
      SELECT id, name, ST_Distance(location, ${point})::FLOAT8 AS dist
      FROM dams WHERE external_ids->>'ndi' = ${ndi}
    `;
    return pinned ? { damId: pinned.id, distanceM: pinned.dist, damName: pinned.name } : null;
  }
  const rows = await sql<(BindableMaster & { rank: number; dist: number })[]>`
    SELECT id, name, completed_year AS "completedYear", stamp, dist,
           CASE WHEN twin
                THEN MIN(dist) OVER (PARTITION BY twin, regexp_replace(name, '（(元|再)）$', ''))
                ELSE dist
           END AS rank
    FROM (
      SELECT id, name, completed_year, external_ids->>'mudam' AS stamp,
             name ~ '（(元|再)）$' AS twin,
             ST_Distance(location, ${point})::FLOAT8 AS dist
      FROM dams
      WHERE ST_DWithin(location, ${point}, ${radiusM})
        AND (
          name LIKE ${`%${mudam.name}%`}
          OR ${mudam.name}::text LIKE ('%' || REPLACE(REPLACE(name, 'ダム', ''), '貯水池', '') || '%')
        )
    ) c
  `;
  const r = chooseRanked(rows, String(mudam.damsysId));
  if (!r) return null;
  return { damId: r.id, distanceM: r.dist, damName: r.name };
}

const task: Task = async (rawPayload, helpers) => {
  const log = (s: string): void => helpers.logger.info(s);
  const payload = (rawPayload ?? {}) as BackfillPayload;
  const district = payload.district ?? 'kanto';
  const years = Math.max(1, Math.min(27, payload.years ?? 5));
  const districts = district === 'all' ? ALL_DISTRICTS : [district as DistrictKey];

  await ensureSourcePriority();

  // Most recent year mudam publishes confirmed values for. The page lists up
  // to 令和6年 (2024) today; we walk N years ending there. Adjust as the
  // archive advances.
  const latestYear = 2024;
  const yearList: number[] = [];
  for (let i = 0; i < years; i += 1) yearList.push(latestYear - i);

  let totalMatched = 0;
  let totalMissed = 0;
  let totalRows = 0;
  let totalPages = 0;
  let totalFailures = 0;

  for (const dKey of districts) {
    const dams = await fetchDistrict(dKey);
    log(`mudam:${dKey} — ${dams.length} dams listed in district`);

    for (const m of dams) {
      const match = await matchMaster(m);
      if (!match) {
        totalMissed += 1;
        log(`  miss "${m.name}" (id=${m.damsysId}) — no master matched`);
        continue;
      }
      totalMatched += 1;
      await bindExternalId(match.damId, 'mudam', String(m.damsysId));

      const inputs = [] as Parameters<typeof upsertObservations>[0];
      for (const y of yearList) {
        try {
          const rows = await downloadYearCsv(m.damsysId, y);
          totalPages += 1;
          for (const r of rows) {
            inputs.push({
              observedAt: r.observedAt,
              damId: match.damId,
              sourceId: 'mudam',
              storageVolumeM3: null,
              storageRate: null,
              inflowM3s: r.inflowM3s,
              outflowM3s: r.outflowM3s,
              waterLevelM: r.waterLevelM,
              rainfallMm: null,
              rawSnapshotId: null,
              qualityFlag: 0,
            });
          }
        } catch (e) {
          totalFailures += 1;
          log(`  ERROR ${m.name} ${y}: ${(e as Error).message}`);
        }
        await sleep(SLEEP_BETWEEN_FETCHES_MS);
      }
      if (inputs.length > 0) {
        // Chunk to keep individual COPY statements bounded.
        const CHUNK = 2_000;
        for (let i = 0; i < inputs.length; i += CHUNK) {
          totalRows += await upsertObservations(inputs.slice(i, i + CHUNK));
        }
        log(
          `  ok  ${m.name.padEnd(14)} → ${match.damName} (${(match.distanceM / 1000).toFixed(2)} km)  +${inputs.length} rows`,
        );
      }
    }
  }

  log(
    `backfill:mudam done — districts=${districts.join(',')} matched=${totalMatched} missed=${totalMissed} pages=${totalPages} failures=${totalFailures} rows=${totalRows}`,
  );
};

export default task;
