import { bigint, bigserial, pgTable, text, timestamp, unique } from 'drizzle-orm/pg-core';

export const rivers = pgTable(
  'rivers',
  {
    id: bigserial('id', { mode: 'bigint' }).primaryKey(),
    watershedId: bigint('watershed_id', { mode: 'bigint' }).notNull(),
    name: text('name').notNull(),
    kind: text('kind', { enum: ['main', 'tributary', 'other'] }).notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => ({
    uniq: unique('rivers_watershed_name_uniq').on(t.watershedId, t.name),
  }),
);

export type River = typeof rivers.$inferSelect;
export type NewRiver = typeof rivers.$inferInsert;
