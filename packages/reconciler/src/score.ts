const MAX_DISTANCE_M = 500;

export interface ScoreInput {
  nameSim: number; // 0..1
  distanceM: number; // metres
  managerMatch: boolean;
}

export function scoreCandidate(input: ScoreInput): number {
  const nameTerm = Math.max(0, Math.min(1, input.nameSim)) * 0.5;
  const distNorm = Math.max(0, 1 - input.distanceM / MAX_DISTANCE_M);
  const distTerm = distNorm * 0.4;
  const mgrTerm = input.managerMatch ? 0.1 : 0;
  return Number((nameTerm + distTerm + mgrTerm).toFixed(6));
}
