// Fixture → universe entries, no database: binding and writing belong to the
// ingest run (apps/worker/src/ingest/run.test.ts).

import { describe, expect, it } from 'bun:test';
import listFixture from '../../../../tests/fixtures/tottori_bousai/list_2026-06-05-08-20.json';
// Items that are not the dam's own telemetry, verbatim from 鳥取県防災Web:
//   09-23-14-20 incomplete list (total=2), both items a 0 m placeholder
//   09-27-05-20 complete list, 菅沢 carries 朝鍋's real values
//   09-27-12-20 incomplete list (total=2), 朝鍋 a 0 m placeholder, 菅沢 real
import partialCopied from '../../../../tests/fixtures/tottori_bousai/list_2026-09-23-14-20.json';
import completeCopied from '../../../../tests/fixtures/tottori_bousai/list_2026-09-27-05-20.json';
import partialPlaceholder from '../../../../tests/fixtures/tottori_bousai/list_2026-09-27-12-20.json';
// Live list 2026-09-28 12:40 JST, verbatim: the 利水 column null for all six.
import liveList from '../../../../tests/fixtures/tottori_bousai/list_2026-09-28-12-40.json';
import type { Entry, Observed } from '../ingest/types.ts';
import { parseTottoriTimestamp, tottoriEntries } from './ingest_tottori_bousai';

type Items = Parameters<typeof tottoriEntries>[0];

/** The single observation of an entry in state `values`, else null. */
function observed(e: Entry | undefined): Observed | null {
  const r = e?.reading;
  return r && typeof r !== 'function' && r.state === 'values' ? (r.observations[0] ?? null) : null;
}
const states = (entries: Entry[]) =>
  entries.map((e) => [e.name, typeof e.reading === 'function' ? 'fn' : e.reading.state]);

describe('parseTottoriTimestamp', () => {
  it('converts JST to UTC, across midnight', () => {
    expect(parseTottoriTimestamp('2026-06-05 08:20:00')?.toISOString()).toBe(
      '2026-06-04T23:20:00.000Z',
    );
    expect(parseTottoriTimestamp('2026-01-01 00:00:00')?.toISOString()).toBe(
      '2025-12-31T15:00:00.000Z',
    );
    expect(parseTottoriTimestamp('bad')).toBeNull();
  });
});

describe('tottoriEntries', () => {
  it('lists all 6 dams, keyed by the stringified observatory id, in 千m³ → m³', () => {
    const entries = tottoriEntries(listFixture.items as Items);
    expect(entries.length).toBe(6);
    expect(entries[0]?.key).toBe('71001');
    const sugisawa = entries.find((e) => e.name === '菅沢ダム');
    expect(observed(sugisawa)?.storageVolumeM3).toBe(10604 * 1000);
    // 東郷 (県-managed): 31.0% → 0.31
    expect(observed(entries.find((e) => e.name === '東郷ダム'))?.storageRate).toBeCloseTo(0.31, 3);
  });

  it('prefers 利水容量貯水率 over 有効容量貯水率', () => {
    const [base] = listFixture.items as Items;
    if (!base) throw new Error('fixture missing');
    const [e] = tottoriEntries([
      {
        ...base,
        storageRateEffectiveCapacity: 31.0,
        storageRateEffectiveCapacityFlg: '0',
        storageRateWaterUseCapacity: 96.2,
        storageRateWaterUseCapacityFlg: '0',
      },
    ]);
    expect(observed(e)?.storageRate).toBeCloseTo(0.962, 3);
  });

  it("does not store 菅沢's 有効容量貯水率: the 国 dam's rate is not its manager's", () => {
    const entries = tottoriEntries(liveList.items as Items);
    const sugisawa = observed(entries.find((e) => e.name === '菅沢ダム'));
    expect(sugisawa?.storageVolumeM3).toBe(450_000);
    expect(sugisawa?.storageRate).toBeNull();
    // 県-managed 賀祥 keeps 鳥取県's own 15 %.
    expect(observed(entries.find((e) => e.name === '賀祥ダム'))?.storageRate).toBeCloseTo(0.15, 3);
  });

  it('still takes a 国 dam’s 利水容量貯水率 when one is published', () => {
    const sugisawa = (liveList.items as Items).find((it) => it.managerCd === '41');
    if (!sugisawa) throw new Error('fixture missing');
    const [e] = tottoriEntries([
      { ...sugisawa, storageRateWaterUseCapacity: 39.1, storageRateWaterUseCapacityFlg: '0' },
    ]);
    expect(observed(e)?.storageRate).toBeCloseTo(0.391, 3);
  });

  it('the zero-level placeholder of an incomplete list is unreadable; the real row is read', () => {
    const entries = tottoriEntries(partialPlaceholder.items as Items);
    expect(states(entries)).toEqual([
      ['朝鍋ダム', 'unreadable'],
      ['菅沢ダム', 'values'],
    ]);
    expect(observed(entries[1])?.waterLevelM).toBeCloseTo(356.2, 2);
    expect(observed(entries[1])?.storageVolumeM3).toBe(429_000);
  });

  it('placeholder items are unreadable even when their other fields look plausible', () => {
    expect(states(tottoriEntries(partialCopied.items as Items)).map(([, s]) => s)).toEqual([
      'unreadable',
      'unreadable',
    ]);
  });

  it("a 菅沢 item carrying 朝鍋's real values is unreadable; the other five are read", () => {
    const entries = tottoriEntries(completeCopied.items as Items);
    expect(
      states(entries)
        .filter(([, s]) => s === 'values')
        .map(([n]) => n),
    ).toEqual(['百谷ダム', '佐治川ダム', '東郷ダム', '賀祥ダム', '朝鍋ダム']);
    const asanabe = observed(entries.find((e) => e.name === '朝鍋ダム'));
    expect(asanabe?.waterLevelM).toBeCloseTo(102.89, 2);
    expect(asanabe?.storageVolumeM3).toBe(280_000);
  });
});
