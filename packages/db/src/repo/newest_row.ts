import { sql } from '../client.ts';

// The newest-row rule (#121/0223, #122). Several sources often stamp one dam
// at the same observed_at; a pick ordered by observed_at alone then takes
// whichever row the plan meets first. Every "newest reading" pick orders by:
//   1. observed_at, newest first;
//   2. on a tie, the higher source_priorities.priority of an ACTIVE source
//      (inactive or unlisted sources rank below every active one, as in
//      preferredSourceForDam and the watershed series);
//   3. then the greater source_id.
// display_observation() and obs_daily's last value apply the same order in SQL
// (0223); keep the three in step.
//
// Both fragments expect the observation row under the alias `o` (any relation
// with observed_at and source_id), and are used together:
//
//   FROM observations o ${sourceRankJoin()}
//   WHERE o.dam_id = … ORDER BY ${newestFirst()} LIMIT 1
//
// Prefer a per-dam LATERAL … LIMIT 1 over DISTINCT ON across many dams: the
// LIMIT 1 probe reads the (dam_id, observed_at) index and sorts only the rows
// of the newest timestamp, while DISTINCT ON with these keys loses TimescaleDB's
// SkipScan and sorts every row in the window.

/** Joins `o_rank`, the source_priorities row of `o.source_id`, for newestFirst(). */
export function sourceRankJoin() {
  return sql`LEFT JOIN source_priorities o_rank ON o_rank.source_id = o.source_id`;
}

/** ORDER BY keys of the newest-row rule; needs sourceRankJoin() in the same FROM. */
export function newestFirst() {
  return sql`o.observed_at DESC, COALESCE(CASE WHEN o_rank.active THEN o_rank.priority END, -1) DESC, o.source_id DESC`;
}
