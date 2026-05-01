import { appendExternalId, applyDamnetAttributes } from '@dam/db/repo/dams';
import { enqueueMatchReview } from '@dam/db/repo/match_review';
import { matchDam } from '@dam/reconciler';
import type { DamnetDetail } from './types.ts';

export interface ImportOutcome {
  outcome: 'matched' | 'review_enqueued' | 'no_candidate';
  damId: bigint | null;
  confidence: number;
}

export async function importDamnetDetail(detail: DamnetDetail): Promise<ImportOutcome> {
  const result = await matchDam({
    name: detail.name,
    prefCode: detail.prefCode,
    manager: detail.manager ?? null,
    lat: detail.lat ?? null,
    lng: detail.lng ?? null,
  });

  if (result.bestDamId !== null) {
    await appendExternalId(result.bestDamId, 'damnet', detail.damnetId);
    await applyDamnetAttributes(result.bestDamId, {
      nameKana: detail.nameKana ?? null,
      type: detail.type ?? null,
      heightM: detail.heightM ?? null,
      totalCapacityM3: detail.totalCapacityM3 ?? null,
      effectiveCapacityM3: detail.effectiveCapacityM3 ?? null,
      floodCapacityM3: detail.floodCapacityM3 ?? null,
      completedYear: detail.completedYear ?? null,
      manager: detail.manager ?? null,
    });
    return { outcome: 'matched', damId: result.bestDamId, confidence: result.confidence };
  }

  if (result.candidateDamIds.length > 0) {
    await enqueueMatchReview({
      sourceId: 'damnet',
      sourceExternalId: detail.damnetId,
      candidateDamIds: result.candidateDamIds,
      bestDamId: null,
      confidence: result.confidence,
      payload: detail as unknown as Record<string, unknown>,
    });
    return { outcome: 'review_enqueued', damId: null, confidence: result.confidence };
  }

  return { outcome: 'no_candidate', damId: null, confidence: 0 };
}
