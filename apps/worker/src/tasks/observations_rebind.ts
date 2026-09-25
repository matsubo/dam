import { sql } from '@dam/db/client';
import type { Task } from 'graphile-worker';
import type postgres from 'postgres';

// Move one source's observations from the dam row they were wrongly bound to
// onto the right one (#57: 菅生 on the （元） instead of the （再）, the たつの
// 長谷 station on 神河's 長谷, …). Fixing the binding only redirects new
// rows; display_observation() reads the newest row per dam, so the wrong page
// would keep showing a frozen reading and the right one would lack history.
//
// - Keyed by NDI id, which is stable across reimports; slugs are not.
// - Where both rows already hold the same (observed_at, source), the right
//   row's copy wins — it was written after the binding was fixed.
// - A rate the trigger derived (quality_flag bit 32, derived_rate) used the wrong row's
//   capacity. It is cleared so the BEFORE UPDATE trigger (0036/0051) derives
//   it again against the right row; a source's own rate is kept as is.
// - Rows sit in compressed chunks (segmentby dam_id), so the decompression cap
//   is lifted for this transaction only, as bootstrap.sh does for its purge.
//   One transaction per move; run it from the admin endpoint, not at boot.

type Types = typeof sql extends postgres.Sql<infer T> ? T : never;
type Db = postgres.Sql<Types>;

export interface RebindMove {
  sourceId: string;
  fromNdi: string;
  toNdi: string;
}

async function damIdByNdi(db: postgres.TransactionSql<Types>, ndi: string): Promise<bigint> {
  const [row] = await db<{ id: bigint }[]>`SELECT id FROM dams WHERE external_ids->>'ndi' = ${ndi}`;
  if (!row) throw new Error(`observations:rebind: no dam with ndi ${ndi}`);
  return row.id;
}

/** Returns the number of rows moved. */
export async function rebindObservations(db: Db, move: RebindMove): Promise<number> {
  return db.begin(async (tx) => {
    const from = await damIdByNdi(tx, move.fromNdi);
    const to = await damIdByNdi(tx, move.toNdi);
    await tx`SET LOCAL timescaledb.max_tuples_decompressed_per_dml_transaction = 0`;
    await tx`
      DELETE FROM observations f
      USING observations t
      WHERE f.dam_id = ${from} AND t.dam_id = ${to}
        AND f.source_id = ${move.sourceId} AND t.source_id = ${move.sourceId}
        AND f.observed_at = t.observed_at
    `;
    const moved = await tx`
      UPDATE observations SET
        dam_id       = ${to},
        storage_rate = CASE WHEN (quality_flag & 32) = 32 THEN NULL ELSE storage_rate END,
        quality_flag = quality_flag & ~32
      WHERE dam_id = ${from} AND source_id = ${move.sourceId}
    `;
    // The right row's own derived rows from after the fix used its capacity
    // already; nothing to redo there.
    return moved.count;
  });
}

function parseMoves(payload: unknown): RebindMove[] {
  const moves = (payload as { moves?: unknown } | null)?.moves;
  if (!Array.isArray(moves) || moves.length === 0) {
    throw new Error('observations:rebind: payload.moves must be a non-empty array');
  }
  return moves.map((m, i) => {
    const { sourceId, fromNdi, toNdi } = (m ?? {}) as Partial<RebindMove>;
    if (typeof sourceId !== 'string' || typeof fromNdi !== 'string' || typeof toNdi !== 'string') {
      throw new Error(`observations:rebind: moves[${i}] needs string sourceId, fromNdi, toNdi`);
    }
    return { sourceId, fromNdi, toNdi };
  });
}

const task: Task = async (payload, helpers) => {
  for (const move of parseMoves(payload)) {
    const n = await rebindObservations(sql, move);
    helpers.logger.info(
      `observations:rebind ${move.sourceId} ndi ${move.fromNdi} → ${move.toNdi}: ${n} rows`,
    );
  }
};

export default task;
