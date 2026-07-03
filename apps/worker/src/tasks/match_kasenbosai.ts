// apps/worker/src/tasks/match_kasenbosai.ts
//
// Phase A1 (#2): seed `external_ids.kasenbosai` on master `dams` rows by
// matching against the 川の防災情報 (MLIT SCC) dam catalogue.
//
// The catalogue is exposed as one GeoJSON per prefecture code at:
//   /kawabou/file/gjson/obs/{YYYYMMDD}/{HHMM}/dam/{prefCd}.json
//
// Each feature has properties.obs_fcd (13-digit observation code), obs_nm
// (Japanese name), ofc_cd (managing office) plus geometry coordinates
// [lon, lat]. The full sweep returns ~900 dams across 49 prefecture codes.
//
// Matching strategy (per kasenbosai dam):
//   1. Find master candidates within 5 km of the kasenbosai coordinates.
//   2. Score using normalizeJaName on both sides (handles ヶ↔ケ, ヵ↔カ,
//      NFKC, strip ダム/貯水池 suffix, strip parenthetical readings):
//        exact  (normalised names equal)       → 1.0
//        contains (one normalised name ⊂ other) → 0.8
//        trigram similarity ≥ 0.70 within 3 km  → 0.65
//        distance < 500 m only                  → 0.60
//        otherwise                              → 0.40 (below threshold)
//   3. Distance tie-break: nearer beats farther within same score tier.
//   4. Write external_ids.kasenbosai for score ≥ 0.6; stage score < 0.8
//      for human review in match_review.
//
// Triggered ad-hoc:
//   add_job('match:kasenbosai', { date?: 'YYYYMMDD', time?: 'HHMM' })
// With no payload, uses the most recent 5-minute snapshot in JST.

import { PREFECTURES } from '@dam/core/prefectures';
import { normalizeJaName, trigramSimilarity } from '@dam/core/similarity';
import { sql } from '@dam/db/client';
import type { Task } from 'graphile-worker';

const PREFAREA_URL =
  process.env.KASENBOSAI_PREFAREA_URL ??
  'https://www.river.go.jp/kawabou/file/files/map/pref/prefarea.json';

const OBS_BASE =
  process.env.KASENBOSAI_OBS_BASE ?? 'https://www.river.go.jp/kawabou/file/gjson/obs';

interface PrefArea {
  prefCd: number;
  prefNm: string;
  altPrefNm: string | null;
  lat: number;
  lon: number;
}
interface PrefAreaResp {
  prefs: PrefArea[];
}

interface CatalogueDam {
  obsFcd: string;
  obsNm: string;
  ofcCd: number;
  lat: number;
  lon: number;
  /** kasenbosai prefcd (101..4701) — distinct from master JIS pref code. */
  kbPrefCd: number;
}

interface MatchPayload {
  /** YYYYMMDD in JST. Defaults to current JST day. */
  date?: string;
  /** HHMM in JST snapped to 5-min boundary. Defaults to a fresh value. */
  time?: string;
}

function jstNowParts(): { date: string; time: string } {
  // node Date in UTC → shift +9h for JST → format
  const now = new Date(Date.now() + 9 * 3_600_000);
  const yyyy = now.getUTCFullYear();
  const mm = String(now.getUTCMonth() + 1).padStart(2, '0');
  const dd = String(now.getUTCDate()).padStart(2, '0');
  const hh = String(now.getUTCHours()).padStart(2, '0');
  // SCC files publish at 5-minute boundaries; snap DOWN and back off one
  // more 5-minute step so the file is reliably present.
  const min = Math.max(0, Math.floor(now.getUTCMinutes() / 5) * 5 - 5);
  const mi = String(min).padStart(2, '0');
  return { date: `${yyyy}${mm}${dd}`, time: `${hh}${mi}` };
}

function userAgent(): string {
  return (
    process.env.HTTP_USER_AGENT ??
    'DamDataPlatform/0.1 (+https://dam.teraren.com/legal/terms; contact: https://discord.gg/UbWqspWbAk)'
  );
}

async function fetchJson<T>(url: string, timeoutMs = 10_000): Promise<T> {
  const r = await fetch(url, {
    headers: { 'user-agent': userAgent() },
    signal: AbortSignal.timeout(timeoutMs),
  });
  if (!r.ok) throw new Error(`${url}: HTTP ${r.status}`);
  // SCC files have a UTF-8 BOM; TextDecoder('utf-8') strips it automatically
  // for Bun's response.json() too.
  return (await r.json()) as T;
}

interface DamFeature {
  geometry?: { coordinates?: [number, number] };
  properties?: { obs_fcd?: string; obs_nm?: string; ofc_cd?: number };
}
interface DamCollection {
  features?: DamFeature[];
}

export async function fetchAllKasenbosaiDams(
  date: string,
  time: string,
  log: (s: string) => void,
): Promise<CatalogueDam[]> {
  const prefArea = await fetchJson<PrefAreaResp>(PREFAREA_URL);
  const out: CatalogueDam[] = [];
  for (const pref of prefArea.prefs) {
    const url = `${OBS_BASE}/${date}/${time}/dam/${pref.prefCd}.json`;
    try {
      const fc = await fetchJson<DamCollection>(url, 8_000);
      for (const f of fc.features ?? []) {
        const p = f.properties ?? {};
        const c = f.geometry?.coordinates;
        if (!p.obs_fcd || !p.obs_nm || !c || c.length < 2) continue;
        const lon = c[0];
        const lat = c[1];
        if (typeof lon !== 'number' || typeof lat !== 'number') continue;
        if (!Number.isFinite(lon) || !Number.isFinite(lat)) continue;
        out.push({
          obsFcd: p.obs_fcd,
          obsNm: p.obs_nm,
          ofcCd: p.ofc_cd ?? 0,
          lon,
          lat,
          kbPrefCd: pref.prefCd,
        });
      }
    } catch (err) {
      log(
        `match:kasenbosai: pref ${pref.prefCd} (${pref.prefNm}) skipped: ${(err as Error).message}`,
      );
    }
    // Light throttle so we don't hammer the CDN.
    await new Promise((r) => setTimeout(r, 80));
  }
  return out;
}

/**
 * Map kasenbosai prefcd (101..4701) to a JIS prefecture code (01..47).
 * Hokkaido is split into 5 sub-regions (101-105); all map to '01'.
 * Other prefectures use the convention `NNN01` where NN = JIS code + 1
 * (1=北海道 → 101..105, 2=青森 → 201, 3=岩手 → 301, ... 47=沖縄 → 4701).
 */
export function kbPrefToJis(kbPrefCd: number): string | null {
  // Hokkaido sub-regions:
  if (kbPrefCd >= 101 && kbPrefCd <= 105) return '01';
  // Other prefectures: 201..4701 with pattern (jis - 1) * 100 + 1
  // Actually observed: 201 (青森=02), 301 (岩手=03), 401 (宮城=04), 501 (秋田=05),
  // ..., 1301 (東京=13), 1401 (神奈川=14), ..., 4701 (沖縄=47).
  // So jis = (kbPrefCd - 1) / 100. Verify it's an integer.
  if (kbPrefCd >= 201 && kbPrefCd <= 4701 && (kbPrefCd - 1) % 100 === 0) {
    const jisNum = Math.floor((kbPrefCd - 1) / 100);
    return String(jisNum).padStart(2, '0');
  }
  return null;
}

interface MatchResult {
  obsFcd: string;
  obsNm: string;
  damId: bigint | null;
  damName: string | null;
  distanceM: number | null;
  score: number;
  reason: string;
  /** All proximity candidates (top 10) for match_review fallback. */
  candidates: { id: bigint; name: string; distanceM: number }[];
}

/**
 * For one catalogue dam, find the best master match.
 * Uses normaliseJaName on both sides for ヶ↔ケ, suffix stripping, etc.
 */
async function matchOne(d: CatalogueDam): Promise<MatchResult> {
  const jisPref = kbPrefToJis(d.kbPrefCd);
  // Normalised stem: handles ヶ↔ケ, ヵ↔カ, NFKC, strips ダム/貯水池 and parens.
  const normStem = normalizeJaName(d.obsNm);
  if (!normStem) {
    return {
      obsFcd: d.obsFcd,
      obsNm: d.obsNm,
      damId: null,
      damName: null,
      distanceM: null,
      score: 0,
      reason: 'empty-stem',
      candidates: [],
    };
  }
  const point = `SRID=4326;POINT(${d.lon} ${d.lat})`;
  const rows = await sql<
    { id: bigint; name: string; distance_m: number; pref_code: string | null }[]
  >`
    SELECT
      d.id,
      d.name,
      ST_Distance(d.location::geography, ST_GeogFromText(${point})) AS distance_m,
      d.pref_code
    FROM dams d
    WHERE d.location IS NOT NULL
      AND ST_DWithin(d.location::geography, ST_GeogFromText(${point}), 5000)
      ${jisPref ? sql`AND (d.pref_code = ${jisPref} OR d.pref_code IS NULL)` : sql``}
    ORDER BY ST_Distance(d.location::geography, ST_GeogFromText(${point}))
    LIMIT 10
  `;
  const candidates = rows.map((r) => ({
    id: r.id,
    name: r.name,
    distanceM: Math.round(r.distance_m),
  }));
  if (rows.length === 0) {
    return {
      obsFcd: d.obsFcd,
      obsNm: d.obsNm,
      damId: null,
      damName: null,
      distanceM: null,
      score: 0,
      reason: 'no-candidates-within-5km',
      candidates,
    };
  }
  // Score each candidate using normalised names so ヶ↔ケ and suffix variants
  // (ダム vs 貯水池) do not cause false mismatches.
  let best: { row: (typeof rows)[number]; score: number; reason: string } | null = null;
  for (const r of rows) {
    const normR = normalizeJaName(r.name);
    let score = 0;
    let reason = '';
    if (normR === normStem) {
      score = 1.0;
      reason = 'exact-name';
    } else if (normR.includes(normStem) || normStem.includes(normR)) {
      score = 0.8;
      reason = 'name-contains';
    } else {
      const sim = trigramSimilarity(normR, normStem);
      if (sim >= 0.7 && r.distance_m < 3000) {
        // Decent trigram overlap + nearby → cautious accept
        score = 0.65;
        reason = `trigram-${sim.toFixed(2)}`;
      } else {
        score = r.distance_m < 500 ? 0.6 : 0.4;
        reason = `distance-only (${Math.round(r.distance_m)}m)`;
      }
    }
    if (best == null || score > best.score) {
      best = { row: r, score, reason };
    }
  }
  if (!best || best.score < 0.6) {
    return {
      obsFcd: d.obsFcd,
      obsNm: d.obsNm,
      damId: null,
      damName: rows[0]?.name ?? null,
      distanceM: rows[0]?.distance_m ?? null,
      score: best?.score ?? 0,
      reason: best?.reason ?? 'low-score',
      candidates,
    };
  }
  return {
    obsFcd: d.obsFcd,
    obsNm: d.obsNm,
    damId: best.row.id,
    damName: best.row.name,
    distanceM: best.row.distance_m,
    score: best.score,
    reason: best.reason,
    candidates,
  };
}

async function writeExternalId(damId: bigint, obsFcd: string): Promise<void> {
  await sql`
    UPDATE dams
    SET external_ids = COALESCE(external_ids, '{}'::jsonb)
                     || jsonb_build_object('kasenbosai', ${obsFcd}::text)
    WHERE id = ${damId}
      AND COALESCE(external_ids->>'kasenbosai', '') <> ${obsFcd}
  `;
}

export async function writeMatchReview(d: CatalogueDam, m: MatchResult): Promise<void> {
  // Bind candidate ids as a text[] then cast to bigint[]. The client pins a
  // custom bigint type parser, which makes postgres.js mis-serialize a
  // bigint[] param as a scalar (→ "cannot cast type bigint to bigint[]").
  const candidateIds = m.candidates.map((c) => c.id.toString());
  const payload = {
    catalogue: { obsNm: d.obsNm, lat: d.lat, lon: d.lon, ofcCd: d.ofcCd, kbPrefCd: d.kbPrefCd },
    bestReason: m.reason,
    bestDistanceM: m.distanceM,
    candidates: m.candidates.map((c) => ({
      id: c.id.toString(),
      name: c.name,
      distanceM: c.distanceM,
    })),
  };
  await sql`
    INSERT INTO match_review (
      source_id, source_external_id, candidate_dam_ids, best_dam_id, confidence, payload
    )
    VALUES (
      'kasenbosai', ${d.obsFcd}, ${candidateIds}::bigint[],
      ${m.damId}, ${m.score}::numeric, ${sql.json(payload)}
    )
    ON CONFLICT (source_id, source_external_id) DO UPDATE
      SET candidate_dam_ids = EXCLUDED.candidate_dam_ids,
          best_dam_id       = EXCLUDED.best_dam_id,
          confidence        = EXCLUDED.confidence,
          payload           = EXCLUDED.payload
      WHERE match_review.resolved_dam_id IS NULL
  `;
}

const task: Task = async (rawPayload, helpers) => {
  const log = (s: string): void => helpers.logger.info(s);
  const payload = (rawPayload ?? {}) as MatchPayload;
  const { date: dDef, time: tDef } = jstNowParts();
  const date = payload.date ?? dDef;
  const time = payload.time ?? tDef;
  log(`match:kasenbosai start — snapshot ${date} ${time}`);

  const cat = await fetchAllKasenbosaiDams(date, time, log);
  log(`match:kasenbosai: fetched ${cat.length} dams across ${PREFECTURES.length} JIS prefs`);

  let matched = 0;
  let alreadySet = 0;
  let unmatched = 0;
  let needsReview = 0;
  for (const d of cat) {
    const m = await matchOne(d);
    if (m.damId == null) {
      unmatched += 1;
      // Surface candidates for human review when there were any nearby dams.
      if (m.candidates.length > 0) {
        await writeMatchReview(d, m);
        needsReview += 1;
      }
      continue;
    }
    // Check current external_ids.kasenbosai to track new vs existing.
    const existing = await sql<{ k: string | null }[]>`
      SELECT external_ids->>'kasenbosai' AS k FROM dams WHERE id = ${m.damId}
    `;
    if (existing[0]?.k === d.obsFcd) {
      alreadySet += 1;
    } else {
      await writeExternalId(m.damId, d.obsFcd);
      matched += 1;
      log(
        `  ok ${m.obsNm.padEnd(14)} → ${m.damName} (${Math.round(m.distanceM ?? 0)} m, ${m.reason})`,
      );
    }
    // Also stage uncertain auto-matches (score < 0.8) for review.
    if (m.score < 0.8) {
      await writeMatchReview(d, m);
      needsReview += 1;
    }
  }
  log(
    `match:kasenbosai done — fetched=${cat.length} newly-matched=${matched} already-set=${alreadySet} unmatched=${unmatched} needs-review=${needsReview}`,
  );
};

export default task;
