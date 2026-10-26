// Fixture → universe entries, no database: binding and writing belong to the
// ingest run (apps/worker/src/ingest/run.test.ts).

import { describe, expect, it } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { Entry, Observed } from '../ingest/types.ts';
import { tottoriEntries } from './ingest_tottori';

const FIXTURE = readFileSync(
  join(import.meta.dir, '../../../../tests/fixtures/tottori_dam/data10all.html'),
  'utf8',
);

function observed(entries: Entry[], key: string): Observed {
  const r = entries.find((e) => e.key === key)?.reading;
  if (!r || typeof r === 'function' || r.state !== 'values') throw new Error(`${key}: no values`);
  const [o] = r.observations;
  if (!o) throw new Error(`${key}: no observation`);
  return o;
}

describe('tottoriEntries', () => {
  it('lists every dam in the 10分データ全ダム一覧 table, each with values', () => {
    const entries = tottoriEntries(FIXTURE);
    expect(entries.map((e) => e.key).sort()).toEqual(
      ['佐治川ダム', '東郷ダム', '朝鍋ダム', '百谷ダム', '賀祥ダム'].sort(),
    );
    for (const e of entries) {
      expect(e.pref).toBe('31');
      expect(e.name).toBe(e.key);
      expect(typeof e.reading !== 'function' && e.reading.state).toBe('values');
    }
  });

  it('reads 賀祥ダム the way the prefecture publishes it', () => {
    // The top page's <area alt> reported 452 千m³ / 07 % for this same reading,
    // which contradicts its own 空容量 (452 + 5,480 ≠ 6,690). The table page is
    // self-consistent and matches 鳥取県防災Web's 18 %.
    const kasho = observed(tottoriEntries(FIXTURE), '賀祥ダム');
    expect(kasho.storageVolumeM3).toBe(1_210_000);
    expect(kasho.storageRate).toBeCloseTo(0.18, 6);
    expect(kasho.waterLevelM).toBe(107.89);
    expect(kasho.inflowM3s).toBe(0.7);
    expect(kasho.outflowM3s).toBe(0.7);
    expect(kasho.observedAt.toISOString()).toBe('2026-09-11T00:20:00.000Z');
  });

  it('keeps single-digit columns and blank 下流水位 cells from breaking a row', () => {
    const sajigawa = observed(tottoriEntries(FIXTURE), '佐治川ダム');
    expect(sajigawa.storageVolumeM3).toBe(111_000);
    expect(sajigawa.storageRate).toBeCloseTo(0.06, 6);
    expect(sajigawa.rainfallMm).toBe(0);
  });

  it('drops a 貯水率 the row’s own 有効貯水容量 contradicts', () => {
    // Synthetic: a row whose 貯水率 no longer matches the volume and capacity
    // printed beside it. (The top page's 賀祥 block was self-consistent in these
    // three fields — 452 / 6,690 really is 07 % — so it is not this case.)
    const broken = FIXTURE.replace(
      '<td class="data"> 1210</td>\n<td class="data">6690</td>',
      '<td class="data"> 452</td>\n<td class="data">6690</td>',
    );
    const kasho = observed(tottoriEntries(broken), '賀祥ダム');
    expect(kasho.storageVolumeM3).toBe(452_000);
    expect(kasho.storageRate).toBeNull();
  });

  it('a row of 欠測 in every column is provider-marked empty', () => {
    const marked = FIXTURE.replace(
      /(<td class="data" nowrap>百谷ダム<\/td>)([\s\S]*?)(<\/tr>)/,
      (_m, head: string, cells: string, tail: string) =>
        head + cells.replace(/<td class="data">[^<]*<\/td>/g, '<td class="data">欠測</td>') + tail,
    );
    const momo = tottoriEntries(marked).find((e) => e.key === '百谷ダム')?.reading;
    expect(momo).toEqual({ state: 'empty', mark: '欠測/― in every column' });
  });

  it('every known dam is unreadable when the page has no table', () => {
    const entries = tottoriEntries('<html><body>maintenance</body></html>');
    expect(entries).toHaveLength(5);
    for (const e of entries) {
      expect(e.reading).toEqual({ state: 'unreadable', why: 'no data10 table' });
    }
  });
});
