import postgres from 'postgres';
import {
  connectionOptions,
  POOL_CONNECT_TIMEOUT_S,
  POOL_IDLE_TIMEOUT_S,
  POOL_MAX_LIFETIME_S,
  poolReconnectBackoffS,
} from './client_options.ts';
import { withRetry } from './retry.ts';

// During `next build` Next.js runs "Collecting page data" which loads every
// route module — but the build host has no DATABASE_URL. We accept a
// placeholder URL so the module imports cleanly; the first real query will
// fail loudly with a connection error if the env wasn't actually set at
// runtime.
const url = process.env.DATABASE_URL ?? 'postgres://build@build/build';

// The database is a 2-instance CloudNativePG cluster: a switchover or a
// failover leaves no writable primary for ~3-10 s, and every query in that
// window fails with a connection error. withRetry re-issues such queries with
// backoff for up to 20 s so visitors see a slow response instead of a 500.
// A statement that never reached a writable server (connection refused,
// cannot_connect_now, read-only standby) is retried whatever it is. One cut
// off mid-flight (connection closed, admin_shutdown) may already have
// committed, so only reads are retried; writes surface the error rather than
// risk running twice. See retry.ts for the exact codes and the read rule.
function makeClient() {
  return withRetry(
    postgres(url, {
      max: 10,
      idle_timeout: POOL_IDLE_TIMEOUT_S,
      max_lifetime: POOL_MAX_LIFETIME_S,
      connect_timeout: POOL_CONNECT_TIMEOUT_S,
      backoff: poolReconnectBackoffS,
      prepare: false,
      connection: connectionOptions(process.env),
      types: {
        bigint: postgres.BigInt,
      },
    }),
  );
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
