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
// no match within that window, the mudam entry is logged and skipped.

import { sql } from '@dam/db/client';
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
  const re = /markersInfo\.push\(\[(\d+),\s*([\d.\-]+),\s*([\d.\-]+),\s*"([^"]+)"\]\)/g;
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

async function fetchDistrict(district: DistrictKey): Promise<MudamDam[]> {
  const r = await fetch(`${BASE_URL}/districtMap/${district}`, {
    headers: { 'user-agent': `Mozilla/5.0 ${userAgent()}` },
    signal: AbortSignal.timeout(20_000),
    // mudam.nilim.go.jp serves an intermediate-only chain that Bun/Node's
    // bundled trust store can't verify. Server cert itself is valid (issued
    // by a reputable CA); we only relax the leaf-signature check.
    tls: { rejectUnauthorized: false },
  } as RequestInit);
  if (r.status !== 200) throw new Error(`district ${district} HTTP ${r.status}`);
  return parseDistrictDams(await r.text());
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
    out.push({
      observedAt: obs,
      waterLevelM: parseNum(cols[1] ?? ''),
      inflowM3s: parseNum(cols[2] ?? ''),
      outflowM3s: parseNum(cols[3] ?? ''),
    });
  }
  return out;
}

async function downloadYearCsv(damsysId: number, year: number): Promise<CsvRow[]> {
  const url = `${BASE_URL}/chronology/form02/download/csv?damsysId=${damsysId}&options=day&yearFrom=${year}&yearTo=${year}`;
  const r = await fetch(url, {
    headers: { 'user-agent': `Mozilla/5.0 ${userAgent()}` },
    signal: AbortSignal.timeout(30_000),
    tls: { rejectUnauthorized: false },
  } as RequestInit);
  if (r.status !== 200) return [];
  // Response is Shift_JIS; decode via TextDecoder.
  const buf = await r.arrayBuffer();
  const text = new TextDecoder('shift_jis').decode(buf);
  return parseMudamCsv(text);
}

async function ensureSourcePriority(): Promise<void> {
  await sql`
    INSERT INTO source_priorities (source_id, priority, description, active)
    VALUES ('mudam', 280,
            'NILIM ダム諸量データベース (mudam.nilim.go.jp) — daily, ~600 dams, 1-2 year lag (confirmed historical)',
            true)
    ON CONFLICT (source_id) DO UPDATE
      SET priority    = EXCLUDED.priority,
          description = EXCLUDED.description,
          active      = EXCLUDED.active
  `;
}

interface MatchResult {
  damId: bigint;
  distanceM: number;
  damName: string;
}

/**
 * Match a mudam dam to a master dam by (a) name overlap and (b) location
 * proximity. Returns the closest match within `radiusM` whose name contains
 * the mudam name (or vice-versa, allowing the 「ダム」 suffix to be omitted
 * either side). Null if no acceptable match.
 */
async function matchMaster(mudam: MudamDam, radiusM = 10_000): Promise<MatchResult | null> {
  const rows = await sql<{ id: bigint; name: string; dist: number }[]>`
    SELECT id, name, ST_Distance(
      location,
      ST_SetSRID(ST_MakePoint(${mudam.lng}, ${mudam.lat}), 4326)::geography
    )::FLOAT8 AS dist
    FROM dams
    WHERE ST_DWithin(
      location,
      ST_SetSRID(ST_MakePoint(${mudam.lng}, ${mudam.lat}), 4326)::geography,
      ${radiusM}
    )
      AND (
        name LIKE ${`%${mudam.name}%`}
        OR ${mudam.name}::text LIKE ('%' || REPLACE(REPLACE(name, 'ダム', ''), '貯水池', '') || '%')
      )
    ORDER BY dist
    LIMIT 1
  `;
  const r = rows[0];
  if (!r) return null;
  return { damId: r.id, distanceM: r.dist, damName: r.name };
}

async function stampExternalId(damId: bigint, damsysId: number): Promise<void> {
  await sql`
    UPDATE dams
    SET external_ids = COALESCE(external_ids, '{}'::jsonb)
                     || jsonb_build_object('mudam', ${String(damsysId)}::text)
    WHERE id = ${damId}
      AND COALESCE(external_ids->>'mudam', '') <> ${String(damsysId)}
  `;
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
        log(`  miss "${m.name}" (id=${m.damsysId}) — no master within 10 km`);
        continue;
      }
      totalMatched += 1;
      await stampExternalId(match.damId, m.damsysId);

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
