// apps/worker/src/crontab.ts
// graphile-worker crontab format: https://github.com/graphile/worker
// Note: graphile-worker's crontab parser only allows [_a-zA-Z][_a-zA-Z0-9:_-]*
// for task identifiers, so we use colons instead of dots.
export const CRONTAB = `
# Master refresh: NLNI on the 1st of each month at 03:00
0 3 1 * * master:refresh:ndi
# Damnet: 5th of each month at 03:00 (after NLNI to maximize match coverage)
0 3 5 * * master:refresh:damnet
# Match sweep: nightly at 04:00
0 4 * * * master:match
`;
