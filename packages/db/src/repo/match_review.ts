import type postgres from 'postgres';
import { sql } from '../client.ts';

export interface NewMatchReview {
  sourceId: string;
  sourceExternalId: string;
  candidateDamIds: bigint[];
  bestDamId: bigint | null;
  confidence: number;
  payload: Record<string, unknown>;
}

export async function enqueueMatchReview(input: NewMatchReview): Promise<void> {
  await sql`
    INSERT INTO match_review (
      source_id, source_external_id, candidate_dam_ids, best_dam_id, confidence, payload
    )
    VALUES (
      ${input.sourceId}, ${input.sourceExternalId},
      ${sql.array(input.candidateDamIds.map((id) => id.toString()))}::bigint[],
      ${input.bestDamId},
      ${input.confidence}, ${sql.json(input.payload as postgres.JSONValue)}::jsonb
    )
    ON CONFLICT (source_id, source_external_id)
    DO UPDATE SET candidate_dam_ids = EXCLUDED.candidate_dam_ids,
                  best_dam_id = EXCLUDED.best_dam_id,
                  confidence  = EXCLUDED.confidence,
                  payload     = EXCLUDED.payload
  `;
}
