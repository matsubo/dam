import { bigserial, integer, pgTable, text, timestamp, unique } from 'drizzle-orm/pg-core';

export const rawSnapshots = pgTable(
  'raw_snapshots',
  {
    id: bigserial('id', { mode: 'bigint' }).primaryKey(),
    sourceId: text('source_id').notNull(),
    targetId: text('target_id').notNull(),
    fetchedAt: timestamp('fetched_at', { withTimezone: true }).notNull(),
    storageUri: text('storage_uri').notNull(),
    httpStatus: integer('http_status'),
    etag: text('etag'),
    bytes: integer('bytes'),
    contentType: text('content_type'),
    parseStatus: text('parse_status').notNull().default('pending'),
    parseError: text('parse_error'),
    createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => ({ uniq: unique('raw_snapshots_uniq').on(t.sourceId, t.targetId, t.fetchedAt) }),
);

export type RawSnapshot = typeof rawSnapshots.$inferSelect;
export type NewRawSnapshot = typeof rawSnapshots.$inferInsert;
