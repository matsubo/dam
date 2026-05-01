import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { sql } from '@dam/db/client';
import { upsertDamByExternalId } from '@dam/db/repo/dams';
import { matchDam } from './match.ts';

beforeAll(async () => {
  await upsertDamByExternalId('ndi', {
    slug: 'yanba-10',
    name: '八ッ場ダム',
    prefCode: '10',
    manager: '国土交通省関東地方整備局',
    lat: 36.55,
    lng: 138.69,
    externalIds: { ndi: 'TEST-RECON-1' },
  });
});

afterAll(async () => {
  await sql`DELETE FROM dams WHERE external_ids ->> 'ndi' = 'TEST-RECON-1'`;
});

describe('matchDam', () => {
  test('matches with high confidence on exact name + close location', async () => {
    const r = await matchDam({
      name: '八ッ場ダム',
      prefCode: '10',
      manager: '国土交通省関東地方整備局',
      lat: 36.5501,
      lng: 138.6901,
    });
    expect(r.bestDamId).not.toBeNull();
    expect(r.confidence).toBeGreaterThan(0.9);
  });

  test('returns null bestDamId when score is below threshold', async () => {
    const r = await matchDam({
      name: '全然違う名前',
      prefCode: '10',
      lat: 0,
      lng: 0,
    });
    expect(r.bestDamId).toBeNull();
  });

  test('does not auto-match pref-only fallback below 0.85 threshold', async () => {
    const r = await matchDam({
      name: '八ッ場ダム', // exact name
      prefCode: '10',
      manager: '国土交通省関東地方整備局', // exact manager
      lat: null, // no location at all
      lng: null,
    });
    // name (1.0 * 0.5) + manager (0.1) = 0.6, below the 0.85 no-loc threshold
    expect(r.bestDamId).toBeNull();
    expect(r.confidence).toBeCloseTo(0.6, 5);
    expect(r.candidateDamIds.length).toBeGreaterThan(0);
  });
});
