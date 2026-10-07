/**
 * Per-connection settings for the shared postgres pool. Only the web server
 * sets PG_STATEMENT_TIMEOUT_MS (deploy/coolify/bootstrap.sh, on `next start`
 * alone): public endpoints must not hold a query forever, but the worker's
 * backfills and the migrations legitimately run long.
 */
export function connectionOptions(env: Record<string, string | undefined>): {
  statement_timeout?: number;
} {
  const ms = Number(env.PG_STATEMENT_TIMEOUT_MS);
  return Number.isInteger(ms) && ms > 0 ? { statement_timeout: ms } : {};
}

/**
 * Pool lifetimes, in seconds. A backend keeps the memory its biggest plan
 * needed (glibc does not hand it back), and that memory is only freed when
 * the connection closes. Without these the pool never closed a connection
 * (postgres.js: no idle timeout, 30-60 min lifetime), so each of the 10 web
 * connections settled at its peak: ~270 MB each on production before the
 * storageChange rewrite, enough to OOM a 3 GiB database container.
 * - idle 30 s: production traffic is a few page renders a minute, so most
 *   connections are idle and give their memory back within half a minute of a
 *   burst. Reopening costs ~10 ms to connect plus ~60 ms of catalog loading on
 *   the next hypertable query (storageChange plans in 0.10 s on a new backend,
 *   0.04 s on a warm one).
 * - lifetime 10 min: also recycles connections that never go idle under
 *   steady load, instead of every 30-60 min.
 */
export const POOL_IDLE_TIMEOUT_S = 30;
export const POOL_MAX_LIFETIME_S = 10 * 60;
