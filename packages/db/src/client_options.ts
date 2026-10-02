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
