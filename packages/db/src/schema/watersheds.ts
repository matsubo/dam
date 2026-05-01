import {
  bigserial,
  customType,
  doublePrecision,
  pgTable,
  text,
  timestamp,
} from 'drizzle-orm/pg-core';

const geographyMultiPolygon = customType<{ data: string; driverData: string }>({
  dataType: () => 'GEOGRAPHY(MULTIPOLYGON, 4326)',
});

export const watersheds = pgTable('watersheds', {
  id: bigserial('id', { mode: 'bigint' }).primaryKey(),
  code: text('code').notNull().unique(),
  slug: text('slug').notNull().unique(),
  name: text('name').notNull(),
  nameKana: text('name_kana'),
  kind: text('kind', { enum: ['first', 'second', 'other'] }).notNull(),
  boundary: geographyMultiPolygon('boundary').notNull(),
  areaKm2: doublePrecision('area_km2'),
  createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).defaultNow().notNull(),
});

export type Watershed = typeof watersheds.$inferSelect;
export type NewWatershed = typeof watersheds.$inferInsert;
