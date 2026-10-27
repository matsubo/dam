import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { defineSource } from '@dam/core/sources';
import { sql } from '../client.ts';
import { syncSourcePriorities } from './source_priorities.ts';

const ACTIVE = 'sync-test-active';
const RETIRED = 'sync-test-retired';
const HISTORICAL = 'sync-test-historical';
const UNDECLARED = 'sync-test-undeclared';
const FIXTURES = [ACTIVE, RETIRED, HISTORICAL, UNDECLARED];

const details = { upstream: 'u', license: null, cadence: 'c', what: 'w' };

async function cleanup(): Promise<void> {
  await sql`DELETE FROM source_priorities WHERE source_id = ANY(${FIXTURES}::TEXT[])`;
}

interface Row {
  source_id: string;
  priority: number;
  description: string;
  active: boolean;
  provides_observations: boolean;
  universe_enumerable: boolean;
  historical_only: boolean;
  trusted_rate_basis: boolean;
}

let undeclared: string[] = [];

beforeAll(async () => {
  await cleanup();
  // What a migration or an old task run left behind: drifted values, and a
  // retired source a task run had switched back on.
  await sql`
    INSERT INTO source_priorities
      (source_id, priority, description, active, trusted_rate_basis, universe_enumerable)
    VALUES (${ACTIVE}, 1, 'stale', FALSE, FALSE, FALSE),
           (${RETIRED}, 308, 'old', TRUE, TRUE, TRUE),
           (${UNDECLARED}, 7, 'left alone', TRUE, FALSE, TRUE)
  `;
  const result = await syncSourcePriorities([
    defineSource({
      id: ACTIVE,
      priority: 300,
      description: 'declared',
      trustedRateBasis: true,
      details,
    }),
    defineSource({ id: RETIRED, priority: 308, description: 'old', status: 'retired', details }),
    defineSource({
      id: HISTORICAL,
      priority: 280,
      description: 'dump',
      status: 'historical',
      universeEnumerable: false,
      details,
    }),
  ]);
  undeclared = result.undeclared;
});

afterAll(cleanup);

async function row(id: string): Promise<Row | undefined> {
  const [r] = await sql<Row[]>`
    SELECT source_id, priority, description, active, provides_observations,
           universe_enumerable, historical_only, trusted_rate_basis
    FROM source_priorities WHERE source_id = ${id}
  `;
  return r;
}

describe('syncSourcePriorities', () => {
  test('overwrites every column of an existing row with the declaration', async () => {
    expect(await row(ACTIVE)).toEqual({
      source_id: ACTIVE,
      priority: 300,
      description: 'declared',
      active: true,
      provides_observations: true,
      universe_enumerable: true,
      historical_only: false,
      trusted_rate_basis: true,
    });
  });

  test('keeps a retired source inactive, whatever the row said', async () => {
    expect((await row(RETIRED))?.active).toBe(false);
  });

  test('creates a historical source outside the coverage gate', async () => {
    expect(await row(HISTORICAL)).toMatchObject({
      active: true,
      historical_only: true,
      universe_enumerable: false,
    });
  });

  test('leaves an undeclared row untouched and reports it', async () => {
    expect(await row(UNDECLARED)).toMatchObject({ priority: 7, description: 'left alone' });
    expect(undeclared).toContain(UNDECLARED);
  });
});
