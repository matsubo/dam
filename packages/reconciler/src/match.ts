import { normalizeJaName, trigramSimilarity } from '@dam/core/similarity';
import { findDamsForReconciliation } from '@dam/db/repo/dams';
import { scoreCandidate } from './score.ts';

export interface IncomingRecord {
  name: string;
  prefCode: string;
  manager?: string | null;
  lat?: number | null;
  lng?: number | null;
}

export interface MatchResult {
  bestDamId: bigint | null;
  confidence: number;
  candidateDamIds: bigint[];
}

const AUTO_MATCH_THRESHOLD_WITH_LOC = 0.6;
const AUTO_MATCH_THRESHOLD_NO_LOC = 0.85;

export async function matchDam(record: IncomingRecord): Promise<MatchResult> {
  const hasLatLng = record.lat != null && record.lng != null;

  let candidates = hasLatLng
    ? await findDamsForReconciliation({
        pref: record.prefCode,
        centerLat: record.lat as number,
        centerLng: record.lng as number,
        radiusM: 5_000,
        limit: 50,
      })
    : await findDamsForReconciliation({
        pref: record.prefCode,
        limit: 50,
      });

  // Fallback: if a spatial search returned nothing, widen to pref-only
  // (do not auto-match below — see threshold logic).
  let usedFallback = false;
  if (hasLatLng && candidates.length === 0) {
    candidates = await findDamsForReconciliation({
      pref: record.prefCode,
      limit: 50,
    });
    usedFallback = true;
  }

  const normIncoming = normalizeJaName(record.name);
  let best: { id: bigint; score: number } | null = null;
  const candidateIds: bigint[] = [];

  for (const c of candidates) {
    const nameSim = trigramSimilarity(normIncoming, normalizeJaName(c.name));
    const distanceM = hasLatLng
      ? haversineM(record.lat as number, record.lng as number, c.lat, c.lng)
      : Number.POSITIVE_INFINITY;
    const score = scoreCandidate({
      nameSim,
      distanceM,
      managerMatch: !!record.manager && record.manager === c.manager,
    });
    candidateIds.push(c.id);
    if (!best || score > best.score) best = { id: c.id, score };
  }

  if (!best) return { bestDamId: null, confidence: 0, candidateDamIds: [] };

  const threshold =
    !hasLatLng || usedFallback ? AUTO_MATCH_THRESHOLD_NO_LOC : AUTO_MATCH_THRESHOLD_WITH_LOC;

  return {
    bestDamId: best.score >= threshold ? best.id : null,
    confidence: best.score,
    candidateDamIds: candidateIds,
  };
}

function haversineM(lat1: number, lng1: number, lat2: number, lng2: number): number {
  const R = 6_371_008.8;
  const toRad = (d: number) => (d * Math.PI) / 180;
  const dLat = toRad(lat2 - lat1);
  const dLng = toRad(lng2 - lng1);
  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(a));
}
