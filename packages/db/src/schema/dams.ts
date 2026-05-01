import {
  bigint,
  bigserial,
  char,
  customType,
  integer,
  jsonb,
  numeric,
  pgTable,
  text,
  timestamp,
} from 'drizzle-orm/pg-core';

const geographyPoint = customType<{ data: string; driverData: string }>({
  dataType: () => 'GEOGRAPHY(POINT, 4326)',
});

export const dams = pgTable('dams', {
  id: bigserial('id', { mode: 'bigint' }).primaryKey(),
  slug: text('slug').notNull().unique(),
  name: text('name').notNull(),
  nameKana: text('name_kana'),
  prefCode: char('pref_code', { length: 2 }).notNull(),
  riverId: bigint('river_id', { mode: 'bigint' }),
  watershedId: bigint('watershed_id', { mode: 'bigint' }),
  manager: text('manager'),
  type: text('type'),
  heightM: numeric('height_m'),
  totalCapacityM3: numeric('total_capacity_m3'),
  effectiveCapacityM3: numeric('effective_capacity_m3'),
  floodCapacityM3: numeric('flood_capacity_m3'),
  completedYear: integer('completed_year'),
  location: geographyPoint('location').notNull(),
  externalIds: jsonb('external_ids').$type<Record<string, string>>().default({}).notNull(),
  createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).defaultNow().notNull(),
});

export type Dam = typeof dams.$inferSelect;
export type NewDam = typeof dams.$inferInsert;
