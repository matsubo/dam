// （元）/（再） twins: the master keeps a rebuilt dam and the one it replaced as
// two rows (佐久間（再） sakuma-22, 佐久間（元） sakuma-22-2) and upstreams publish
// readings under only one. The empty row's page canonicalises to the twin that
// has readings — and only then — and the sitemap leaves it out.

import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { sql } from '../client.ts';
import { canonicalTwin, sitemapDams } from './dams.ts';

const SOURCE = 'kasenbosai';

interface Fixture {
  slug: string;
  name: string;
  pref: string;
  withData: boolean;
}

const FIXTURES: Fixture[] = [
  // Only the 元 side has readings.
  { slug: 'twin-test-a-sai', name: 'ツインテストA（再）', pref: '01', withData: false },
  { slug: 'twin-test-a-moto', name: 'ツインテストA（元）', pref: '01', withData: true },
  // Only the 再 side has readings.
  { slug: 'twin-test-g-sai', name: 'ツインテストG（再）', pref: '01', withData: true },
  { slug: 'twin-test-g-moto', name: 'ツインテストG（元）', pref: '01', withData: false },
  // Both have readings.
  { slug: 'twin-test-b-sai', name: 'ツインテストB（再）', pref: '01', withData: true },
  { slug: 'twin-test-b-moto', name: 'ツインテストB（元）', pref: '01', withData: true },
  // Neither has readings.
  { slug: 'twin-test-c-sai', name: 'ツインテストC（再）', pref: '01', withData: false },
  { slug: 'twin-test-c-moto', name: 'ツインテストC（元）', pref: '01', withData: false },
  // Same names, different prefectures: not twins.
  { slug: 'twin-test-d-sai', name: 'ツインテストD（再）', pref: '01', withData: false },
  { slug: 'twin-test-d-moto', name: 'ツインテストD（元）', pref: '02', withData: true },
  // No suffix on the empty row: not a twin of the suffixed one.
  { slug: 'twin-test-e', name: 'ツインテストE', pref: '01', withData: false },
  { slug: 'twin-test-e-moto', name: 'ツインテストE（元）', pref: '01', withData: true },
  // Two 元 rows with readings: ambiguous, so no redirect.
  { slug: 'twin-test-f-sai', name: 'ツインテストF（再）', pref: '01', withData: false },
  { slug: 'twin-test-f-moto', name: 'ツインテストF（元）', pref: '01', withData: true },
  { slug: 'twin-test-f-moto-2', name: 'ツインテストF（元）', pref: '01', withData: true },
];
const SLUGS = FIXTURES.map((f) => f.slug);

const ids = new Map<string, bigint>();
let dbAvailable = false;

async function cleanup(): Promise<void> {
  const rows = await sql<{ id: bigint }[]>`SELECT id FROM dams WHERE slug IN ${sql(SLUGS)}`;
  for (const r of rows) {
    await sql`DELETE FROM observations WHERE dam_id = ${r.id}`;
    await sql`DELETE FROM dams WHERE id = ${r.id}`;
  }
}

async function twinOf(slug: string): Promise<string | null> {
  return (await canonicalTwin(ids.get(slug) as bigint))?.slug ?? null;
}

beforeAll(async () => {
  try {
    await sql`SELECT 1`;
    dbAvailable = true;
  } catch {
    return;
  }
  await cleanup();

  // A real, non-synthetic source — display_observation ignores 'synthetic'.
  const [known] = await sql<{ n: number }[]>`
    SELECT COUNT(*)::int AS n FROM source_priorities WHERE source_id = ${SOURCE}
  `;
  if ((known?.n ?? 0) === 0) {
    await sql`
      INSERT INTO source_priorities (source_id, priority, trusted_rate_basis)
      VALUES (${SOURCE}, 100, TRUE)
      ON CONFLICT (source_id) DO NOTHING
    `;
  }

  for (const f of FIXTURES) {
    const [row] = await sql<{ id: bigint }[]>`
      INSERT INTO dams (slug, name, pref_code, location, external_ids, active_capacity_m3)
      VALUES (${f.slug}, ${f.name}, ${f.pref},
              ST_SetSRID(ST_MakePoint(140.1, 42.4), 4326)::geography, '{}'::jsonb, 1000000)
      RETURNING id
    `;
    const id = row?.id as bigint;
    ids.set(f.slug, id);
    if (f.withData) {
      await sql`
        INSERT INTO observations (dam_id, observed_at, source_id, storage_volume_m3, storage_rate)
        VALUES (${id}, NOW() - INTERVAL '1 hour', ${SOURCE}, 500000, 0.5)
      `;
    }
  }
});

afterAll(async () => {
  if (!dbAvailable) return;
  await cleanup();
});

describe('canonicalTwin', () => {
  test('an empty twin points at the one with readings', async () => {
    if (!dbAvailable) return;
    expect(await twinOf('twin-test-a-sai')).toBe('twin-test-a-moto');
    // The twin with readings stays self-canonical.
    expect(await twinOf('twin-test-a-moto')).toBeNull();
  });

  test('works from the 元 side too', async () => {
    if (!dbAvailable) return;
    expect(await twinOf('twin-test-g-moto')).toBe('twin-test-g-sai');
  });

  test('no redirect when both or neither have readings', async () => {
    if (!dbAvailable) return;
    expect(await twinOf('twin-test-b-sai')).toBeNull();
    expect(await twinOf('twin-test-b-moto')).toBeNull();
    expect(await twinOf('twin-test-c-sai')).toBeNull();
    expect(await twinOf('twin-test-c-moto')).toBeNull();
  });

  test('a different pref_code is not a twin', async () => {
    if (!dbAvailable) return;
    expect(await twinOf('twin-test-d-sai')).toBeNull();
  });

  test('a name without （元）/（再） has no twin', async () => {
    if (!dbAvailable) return;
    expect(await twinOf('twin-test-e')).toBeNull();
  });

  test('no redirect when more than one twin has readings', async () => {
    if (!dbAvailable) return;
    expect(await twinOf('twin-test-f-sai')).toBeNull();
  });
});

describe('sitemapDams', () => {
  test('lists every fixture except those that canonicalise to a twin', async () => {
    if (!dbAvailable) return;
    const listed = new Set((await sitemapDams()).map((d) => d.slug));
    expect(SLUGS.filter((s) => !listed.has(s))).toEqual(['twin-test-a-sai', 'twin-test-g-moto']);
  });
});
