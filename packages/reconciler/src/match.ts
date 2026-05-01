import { findDamsForReconciliation } from '@dam/db/repo/dams';
import { normalizeJaName, trigramSimilarity } from '@dam/core/similarity';
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

export async function matchDam(record: IncomingRecord): Promise<MatchResult> {
  const candidates = await findDamsForReconciliation({
    pref: record.prefCode,
    centerLat: record.lat ?? undefined,
    centerLng: record.lng ?? undefined,
    radiusM: record.lat != null && record.lng != null ? 5_000 : undefined,
    limit: 50,
  });

  const normIncoming = normalizeJaName(record.name);
  let best: { id: bigint; score: number } | null = null;
  const candidateIds: bigint[] = [];

  for (const c of candidates) {
    const nameSim = trigramSimilarity(normIncoming, normalizeJaName(c.name));
    const distanceM =
      record.lat != null && record.lng != null
        ? haversineM(record.lat, record.lng, c.lat, c.lng)
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
  return {
    bestDamId: best.score >= 0.6 ? best.id : null,
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
