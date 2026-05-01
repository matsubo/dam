import { boolean, integer, pgTable, text } from 'drizzle-orm/pg-core';

export const sourcePriorities = pgTable('source_priorities', {
  sourceId: text('source_id').primaryKey(),
  priority: integer('priority').notNull(),
  description: text('description'),
  active: boolean('active').notNull().default(true),
});

export type SourcePriority = typeof sourcePriorities.$inferSelect;
