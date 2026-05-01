import {
  bigint,
  bigserial,
  boolean,
  char,
  customType,
  integer,
  pgTable,
  primaryKey,
  text,
  timestamp,
} from 'drizzle-orm/pg-core';

const bytea = customType<{ data: Uint8Array; driverData: Buffer }>({
  dataType: () => 'bytea',
  toDriver: (v) => Buffer.from(v),
  fromDriver: (v) => new Uint8Array(v),
});

export const apiKeys = pgTable('api_keys', {
  id: bigserial('id', { mode: 'bigint' }).primaryKey(),
  prefix: char('prefix', { length: 8 }).notNull().unique(),
  hash: bytea('hash').notNull(),
  email: text('email').notNull(),
  label: text('label'),
  tier: text('tier', { enum: ['free', 'partner', 'admin'] })
    .notNull()
    .default('free'),
  ratePerMin: integer('rate_per_min').notNull().default(60),
  ratePerDay: integer('rate_per_day').notNull().default(10000),
  active: boolean('active').notNull().default(true),
  createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
  lastUsedAt: timestamp('last_used_at', { withTimezone: true }),
  revokedAt: timestamp('revoked_at', { withTimezone: true }),
});

export const apiKeyUsage = pgTable(
  'api_key_usage',
  {
    apiKeyId: bigint('api_key_id', { mode: 'bigint' }).notNull(),
    bucketMinute: timestamp('bucket_minute', { withTimezone: true }).notNull(),
    count: integer('count').notNull(),
  },
  (t) => ({ pk: primaryKey({ columns: [t.apiKeyId, t.bucketMinute] }) }),
);

export type ApiKey = typeof apiKeys.$inferSelect;
