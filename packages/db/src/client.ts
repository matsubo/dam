import postgres from 'postgres';

// During `next build` Next.js runs "Collecting page data" which loads every
// route module — but the build host has no DATABASE_URL. We accept a
// placeholder URL so the module imports cleanly; the first real query will
// fail loudly with a connection error if the env wasn't actually set at
// runtime.
const url = process.env.DATABASE_URL ?? 'postgres://build@build/build';

function makeClient() {
  return postgres(url, {
    max: 10,
    prepare: false,
    types: {
      bigint: postgres.BigInt,
    },
  });
}

// Pin the postgres pool to globalThis so Next dev's HMR cycle (which re-evals
// the module on every file change) reuses the same client instead of opening
// a fresh 10-connection pool each time. Without this, ~10 edits exhaust the
// default `max_connections=100` and every page returns 500
// "sorry, too many clients already".
const globalAny = globalThis as typeof globalThis & {
  __damSql?: ReturnType<typeof makeClient>;
};
if (!globalAny.__damSql) globalAny.__damSql = makeClient();

export const sql = globalAny.__damSql;

export type Sql = typeof sql;
