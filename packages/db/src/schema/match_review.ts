import {
  bigint,
  bigserial,
  jsonb,
  numeric,
  pgTable,
  text,
  timestamp,
  unique,
} from 'drizzle-orm/pg-core';

export const matchReview = pgTable(
  'match_review',
  {
    id: bigserial('id', { mode: 'bigint' }).primaryKey(),
    sourceId: text('source_id').notNull(),
    sourceExternalId: text('source_external_id').notNull(),
    candidateDamIds: bigint('candidate_dam_ids', { mode: 'bigint' }).array().notNull(),
    bestDamId: bigint('best_dam_id', { mode: 'bigint' }),
    confidence: numeric('confidence').notNull(),
    payload: jsonb('payload').notNull(),
    resolvedDamId: bigint('resolved_dam_id', { mode: 'bigint' }),
    resolvedAt: timestamp('resolved_at', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => ({
    uniq: unique('match_review_src_uniq').on(t.sourceId, t.sourceExternalId),
  }),
);

export type MatchReview = typeof matchReview.$inferSelect;
