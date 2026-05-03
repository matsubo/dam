import postgres from 'postgres';

// During `next build` Next.js runs "Collecting page data" which loads every
// route module — but the build host has no DATABASE_URL. We accept a
// placeholder URL so the module imports cleanly; the first real query will
// fail loudly with a connection error if the env wasn't actually set at
// runtime.
const url = process.env.DATABASE_URL ?? 'postgres://build@build/build';

export const sql = postgres(url, {
  max: 10,
  prepare: false,
  types: {
    bigint: postgres.BigInt,
  },
});

export type Sql = typeof sql;
