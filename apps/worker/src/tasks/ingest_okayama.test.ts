// apps/worker/src/tasks/ingest_okayama.test.ts
//
// Fixture → universe entries, no database: binding and writing belong to the
// ingest run (apps/worker/src/ingest/run.test.ts).
//
// The fixture is a verbatim capture of the live feed from 2026-05-25:
//   data/damQuantities/list/2026-05-25-11-30.json

import { describe, expect, test } from 'bun:test';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { okayamaEntries, parseOkayamaTimestamp } from './ingest_okayama.ts';

const FIXTURE = join(
  import.meta.dir,
  '../../../../tests/fixtures/okayama/list_2026-05-25-11-30.json',
);

async function entries() {
  const json = JSON.parse(await readFile(FIXTURE, 'utf8'));
  return okayamaEntries(json.items);
}

describe('parseOkayamaTimestamp', () => {
  test('parses 「YYYY-MM-DD HH:MM:SS」 JST → UTC', () => {
    expect(parseOkayamaTimestamp('2026-05-25 11:30:00')?.toISOString()).toBe(
      '2026-05-25T02:30:00.000Z',
    );
  });

  test('returns null on malformed input', () => {
    expect(parseOkayamaTimestamp('garbage')).toBeNull();
  });
});

describe('okayamaEntries', () => {
  test('every listed dam is an entry; the six flagged on every field are provider-marked empty', async () => {
    const list = await entries();
    expect(list.length).toBe(21);
    const empty = list.filter((e) => 'state' in e.reading && e.reading.state === 'empty');
    expect(empty.map((e) => e.name)).toEqual([
      '八塔寺川ダム',
      '湯原ダム',
      '竹谷ダム',
      '高瀬川ダム',
      '河本ダム',
      '千屋ダム',
    ]);
    const values = list.filter((e) => 'state' in e.reading && e.reading.state === 'values');
    expect(values.length).toBe(15);
  });

  test('reads 旭川ダム in m³ and the 利水 rate when 有効 is flagged', async () => {
    const asahi = (await entries()).find((e) => e.key === '05200301');
    expect(asahi?.name).toBe('旭川ダム');
    const r = asahi?.reading;
    if (!r || typeof r === 'function' || r.state !== 'values') throw new Error('no values');
    expect(r.observations[0]?.storageVolumeM3).toBe(19_998_000);
    expect(r.observations[0]?.waterLevelM).toBe(100.21);
    expect(r.observations[0]?.observedAt.toISOString()).toBe('2026-05-25T02:30:00.000Z');
  });

  test('a field flagged on its own is dropped, the rest kept (黒谷 level Flg 3)', async () => {
    const kurotani = (await entries()).find((e) => e.key === '90050101');
    const r = kurotani?.reading;
    if (!r || typeof r === 'function' || r.state !== 'values') throw new Error('no values');
    expect(r.observations[0]?.waterLevelM).toBeNull();
    expect(r.observations[0]?.storageVolumeM3).not.toBeNull();
  });
});
