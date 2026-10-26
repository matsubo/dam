import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { sql } from '../client.ts';
import { triageDam } from './coverage.ts';
import {
  latestRateAndSourceByDam,
  listDams,
  listDamsPaged,
  upsertDamByExternalId,
} from './dams.ts';
import { upsertObservations } from './observations.ts';

// GLOSSARY "Value": an observation with none of the six quantities is not
// data. The dam API used to report `hasRealDataLast30d: true` for a dam the
// coverage triage called `published_not_ingested`, because the list filter
// and realSourceId counted any recent row. Every view must agree.

const NDI = ['REALDATA-EMPTY', 'REALDATA-VALUE'];
const SOURCE = 'real-data-test';
let empty: bigint;
let valued: bigint;

async function cleanup(): Promise<void> {
  await sql`
    DELETE FROM observations WHERE dam_id IN (
      SELECT id FROM dams WHERE external_ids ->> 'ndi' = ANY(${NDI}::TEXT[])
    )`;
  await sql`DELETE FROM dams WHERE external_ids ->> 'ndi' = ANY(${NDI}::TEXT[])`;
}

beforeAll(async () => {
  await cleanup();
  const mk = (ndi: string, slug: string) =>
    upsertDamByExternalId('ndi', {
      slug,
      name: slug,
      prefCode: '47',
      lat: 26.2,
      lng: 127.7,
      externalIds: { ndi },
    });
  empty = await mk('REALDATA-EMPTY', 'real-data-empty');
  valued = await mk('REALDATA-VALUE', 'real-data-value');
  const at = new Date(Date.now() - 3_600_000);
  await upsertObservations([
    { observedAt: at, damId: empty, sourceId: SOURCE },
    { observedAt: at, damId: valued, sourceId: SOURCE, waterLevelM: 12.3 },
  ]);
});

afterAll(cleanup);

describe('real data in the last 30 days', () => {
  test('an observation with no value is real data nowhere', async () => {
    const realList = await listDams({ pref: '47', search: 'real-data-', realDataOnly: true });
    const realPage = await listDamsPaged({ pref: '47', search: 'real-data-', realDataOnly: true });
    const sources = await latestRateAndSourceByDam([empty, valued]);

    expect(realList.items.map((d) => d.id)).toEqual([valued]);
    expect(realPage.items.map((d) => d.id)).toEqual([valued]);
    expect(sources.get(empty.toString())?.realSourceId).toBeNull();
    expect(sources.get(valued.toString())?.realSourceId).toBe(SOURCE);
    expect((await triageDam(empty))?.status).not.toBe('covered');
    expect((await triageDam(valued))?.status).toBe('covered');
  });
});
