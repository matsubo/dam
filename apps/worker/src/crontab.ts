// apps/worker/src/crontab.ts
// graphile-worker crontab format: https://github.com/graphile/worker
// Note: graphile-worker's crontab parser only allows [_a-zA-Z][_a-zA-Z0-9:_-]*
// for task identifiers, so we use colons instead of dots.
export const CRONTAB = `
# Master refresh
0 3 1 * * master:refresh:ndi
0 3 5 * * master:refresh:damnet
0 4 * * * master:match

# Realtime ingest (every hour at :05)
5 * * * * ingest:kasenbosai

# Backfill scheduling (rarely; run manually via add_job for ad-hoc enqueue)
# Run actual fetches every 5 minutes (small batches, respects upstream)
*/5 * * * * backfill:suimon:run

# Quality recomputation
30 4 * * * quality:recompute

# Cover-image and elevation refresh — monthly, staggered to avoid hitting the
# upstream APIs all at once.
0 5 1 * * images:refresh:damnet
0 5 2 * * images:refresh:wikipedia
0 5 3 * * master:refresh:elevation
`;
