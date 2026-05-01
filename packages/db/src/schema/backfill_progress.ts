import { bigint, integer, pgTable, primaryKey, text, timestamp } from 'drizzle-orm/pg-core';

export const backfillProgress = pgTable(
  'backfill_progress',
  {
    sourceId: text('source_id').notNull(),
    damId: bigint('dam_id', { mode: 'bigint' }).notNull(),
    year: integer('year').notNull(),
    status: text('status', {
      enum: ['pending', 'running', 'completed', 'failed', 'skipped'],
    }).notNull(),
    attempts: integer('attempts').notNull().default(0),
    lastError: text('last_error'),
    startedAt: timestamp('started_at', { withTimezone: true }),
    completedAt: timestamp('completed_at', { withTimezone: true }),
    rowsWritten: integer('rows_written'),
  },
  (t) => ({ pk: primaryKey({ columns: [t.sourceId, t.damId, t.year] }) }),
);

export type BackfillProgress = typeof backfillProgress.$inferSelect;
