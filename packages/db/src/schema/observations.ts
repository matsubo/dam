import {
  bigint,
  numeric,
  pgTable,
  primaryKey,
  smallint,
  text,
  timestamp,
} from 'drizzle-orm/pg-core';

export const observations = pgTable(
  'observations',
  {
    observedAt: timestamp('observed_at', { withTimezone: true }).notNull(),
    damId: bigint('dam_id', { mode: 'bigint' }).notNull(),
    sourceId: text('source_id').notNull(),
    storageVolumeM3: numeric('storage_volume_m3'),
    storageRate: numeric('storage_rate'),
    inflowM3s: numeric('inflow_m3s'),
    outflowM3s: numeric('outflow_m3s'),
    waterLevelM: numeric('water_level_m'),
    rainfallMm: numeric('rainfall_mm'),
    rawSnapshotId: bigint('raw_snapshot_id', { mode: 'bigint' }),
    qualityFlag: smallint('quality_flag').notNull().default(0),
    createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => ({ pk: primaryKey({ columns: [t.damId, t.observedAt, t.sourceId] }) }),
);

export type Observation = typeof observations.$inferSelect;
export type NewObservation = typeof observations.$inferInsert;
