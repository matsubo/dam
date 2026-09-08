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
  /** 国土数値情報 水系域コード (河川コード上位 6 桁); NULL when the name never matched the codelist. */
  ndiCode: text('ndi_code'),
  boundary: geographyMultiPolygon('boundary').notNull(),
  areaKm2: doublePrecision('area_km2'),
  createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).defaultNow().notNull(),
});

export type Watershed = typeof watersheds.$inferSelect;
export type NewWatershed = typeof watersheds.$inferInsert;
