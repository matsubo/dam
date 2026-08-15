// apps/worker/src/tasks/match_kasenbosai_scoring.ts
//
// Pure scoring rules for match_kasenbosai. Kept free of I/O so the ranking
// can be unit-tested against the real collisions in the MLIT catalogue.
//
// Tiers, highest first (same prefecture):
//   exact normalised name                  → 1.00  auto-bind
//   containment                            → 0.80  auto-bind
//   containment, master-side ordinal       → 0.70  auto-bind + review
//   trigram ≥ 0.70 within 3 km             → 0.65  auto-bind + review
//   distance < 500 m                       → 0.60  auto-bind + review
//   containment, catalogue-side ordinal    → 0.50  rejected (sibling dam)
//   anything else                          → 0.40  rejected
//
// Across a prefecture border only an exact name within CROSS_PREF_MAX_DISTANCE_M
// binds, and only at review confidence — see CROSS_PREF_EXACT_SCORE.

import { normalizeJaName, trigramSimilarity } from '@dam/core/similarity';

/** Minimum score that writes `external_ids.kasenbosai`. */
export const MATCH_THRESHOLD = 0.6;

/** Scores below this are also staged in `match_review` for a human. */
export const REVIEW_THRESHOLD = 0.8;

/**
 * MLIT files some stations under the prefecture they drain into rather than
 * the one the structure sits in (奥只見 is a 新潟 dam filed under 福島). Those
 * are true border cases: the master and catalogue coordinates agree to within
 * a few tens of metres. Namesakes further apart are far more likely to be one
 * of the many repeated dam names (新池 occurs 18× nationwide).
 */
export const CROSS_PREF_MAX_DISTANCE_M = 2000;

/**
 * Deliberately below REVIEW_THRESHOLD: a cross-border bind is good enough to
 * publish data with, but every one still lands in the human review queue.
 */
export const CROSS_PREF_EXACT_SCORE = 0.75;

export interface ScoreCandidate {
  name: string;
  distanceM: number;
  /** JIS prefecture code of the master row; null when the master has none. */
  prefCode: string | null;
}

export interface Score {
  score: number;
  reason: string;
}

/**
 * When one normalised name contains the other, report which side carries the
 * extra ordinal — the direction decides whether they are the same dam:
 *
 *   'catalogue' — MLIT names a numbered sibling (矢作第2) the master stores as
 *      its own row. Binding to the generic parent (矢作) is simply the wrong
 *      dam, so this must not match.
 *   'master' — the master splits one reservoir into numbered embankments
 *      (平荘第1/第2/第3) that MLIT gauges as a single station (平荘). There is
 *      no better target, so this still binds.
 *   null — the surplus carries no digit; ordinary containment.
 */
function ordinalSurplus(masterName: string, catalogueName: string): 'master' | 'catalogue' | null {
  const [short, long] =
    masterName.length <= catalogueName.length
      ? [masterName, catalogueName]
      : [catalogueName, masterName];
  if (!/[0-9]/.test(long.replace(short, ''))) return null;
  return long === masterName ? 'master' : 'catalogue';
}

/** Score one master candidate against a normalised catalogue name stem. */
export function scoreCandidate(
  candidate: ScoreCandidate,
  normStem: string,
  jisPref: string | null,
): Score {
  const normName = normalizeJaName(candidate.name);
  const exact = normName === normStem;
  const crossPref = jisPref != null && candidate.prefCode != null && candidate.prefCode !== jisPref;

  if (crossPref) {
    if (exact && candidate.distanceM <= CROSS_PREF_MAX_DISTANCE_M) {
      return { score: CROSS_PREF_EXACT_SCORE, reason: 'exact-name-cross-pref' };
    }
    return {
      score: 0,
      reason: `cross-pref-reject (${candidate.prefCode} vs ${jisPref})`,
    };
  }

  if (exact) return { score: 1, reason: 'exact-name' };

  if (normName.includes(normStem) || normStem.includes(normName)) {
    switch (ordinalSurplus(normName, normStem)) {
      case 'catalogue':
        return { score: 0.5, reason: 'sibling-name-mismatch' };
      case 'master':
        return { score: 0.7, reason: 'name-contains-ordinal' };
      default:
        return { score: 0.8, reason: 'name-contains' };
    }
  }

  const sim = trigramSimilarity(normName, normStem);
  if (sim >= 0.7 && candidate.distanceM < 3000) {
    return { score: 0.65, reason: `trigram-${sim.toFixed(2)}` };
  }
  return {
    score: candidate.distanceM < 500 ? 0.6 : 0.4,
    reason: `distance-only (${Math.round(candidate.distanceM)}m)`,
  };
}

export interface BestMatch<T extends ScoreCandidate> extends Score {
  candidate: T;
}

export interface MasterBinding {
  damId: bigint | null;
  score: number;
  distanceM: number | null;
}

/**
 * `external_ids.kasenbosai` holds a single station id, so two stations
 * resolving to the same master row means the later write silently replaces the
 * earlier one. That happens legitimately — 小瀬川 is a joint 広島県・山口県 dam
 * gauged once per prefecture office, and 浄土寺川 has a 貯砂ダム station beside
 * the main one — so pick the winner by score (distance breaking ties) instead
 * of leaving it to the order the prefecture files happened to be fetched in.
 *
 * Returns the entries that may be written; the rest belong in match_review.
 */
export function pickStationPerMaster<T extends MasterBinding>(
  bindings: readonly T[],
): ReadonlySet<T> {
  const bestPerMaster = new Map<string, T>();
  for (const b of bindings) {
    if (b.damId == null) continue;
    const key = b.damId.toString();
    const held = bestPerMaster.get(key);
    if (held == null || b.score > held.score) {
      bestPerMaster.set(key, b);
      continue;
    }
    if (
      b.score === held.score &&
      (b.distanceM ?? Number.POSITIVE_INFINITY) < (held.distanceM ?? Number.POSITIVE_INFINITY)
    ) {
      bestPerMaster.set(key, b);
    }
  }
  return new Set(bestPerMaster.values());
}

/**
 * Highest score wins; ties break on distance so the ranking does not depend on
 * the order the caller happened to fetch candidates in.
 */
export function pickBest<T extends ScoreCandidate>(
  candidates: readonly T[],
  normStem: string,
  jisPref: string | null,
): BestMatch<T> | null {
  return candidates.reduce<BestMatch<T> | null>((best, candidate) => {
    const scored = scoreCandidate(candidate, normStem, jisPref);
    if (best == null) return { ...scored, candidate };
    if (scored.score > best.score) return { ...scored, candidate };
    if (scored.score === best.score && candidate.distanceM < best.candidate.distanceM) {
      return { ...scored, candidate };
    }
    return best;
  }, null);
}
