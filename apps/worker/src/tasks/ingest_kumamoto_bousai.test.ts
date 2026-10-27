// apps/worker/src/tasks/ingest_kumamoto_bousai.test.ts
//
// Fixture → universe entries, no database: binding and writing belong to the
// ingest run (apps/worker/src/ingest/run.test.ts).
//
// tests/fixtures/kumamoto_bousai holds a verbatim Shift_JIS capture of
// GmnDspD.exe?52A0 at the 2026/10/26 24:00 JST update (all 6 dams).

import { describe, expect, test } from 'bun:test';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { Entry, Observed } from '../ingest/types.ts';
import {
  kumamotoEntries,
  parseDspDatEntry,
  parseKumamotoDatetime,
} from './ingest_kumamoto_bousai.ts';

const FIXTURE = join(
  import.meta.dir,
  '../../../../tests/fixtures/kumamoto_bousai/GmnDspD_52A0_2026-10-27T0000.shiftjis.html',
);

function observation(e: Entry | undefined): Observed | undefined {
  const r = e?.reading;
  if (!r || typeof r === 'function' || r.state !== 'values') throw new Error('no values');
  return r.observations[0];
}

describe('parseKumamotoDatetime', () => {
  test('parses "YYYY/MM/DD HH:MM" JST → UTC (subtract 9h)', () => {
    const d = parseKumamotoDatetime('2026/06/05 15:00');
    expect(d).not.toBeNull();
    // 15:00 JST = 06:00 UTC
    expect(d?.toISOString()).toBe('2026-06-05T06:00:00.000Z');
  });

  test('handles midnight crossover (JST hour < 9 → previous UTC day)', () => {
    const d = parseKumamotoDatetime('2026/06/05 08:00');
    expect(d).not.toBeNull();
    // 08:00 JST = 2026-06-04T23:00:00Z
    expect(d?.toISOString()).toBe('2026-06-04T23:00:00.000Z');
  });

  test('returns null for malformed strings', () => {
    expect(parseKumamotoDatetime('')).toBeNull();
    expect(parseKumamotoDatetime('bad')).toBeNull();
    expect(parseKumamotoDatetime('2026/06/05')).toBeNull();
  });

  test('handles leading/trailing whitespace', () => {
    const d = parseKumamotoDatetime('  2026/06/05 15:00  ');
    expect(d?.toISOString()).toBe('2026-06-05T06:00:00.000Z');
  });
});

describe('parseDspDatEntry', () => {
  const ICHIFUSA =
    '<a href="JavaScript:JumpStation(575)"><FONT COLOR="blue"><u>市房ダム</u></FONT></a>,' +
    '球磨川,' +
    '2026/06/05 15:00,' +
    '272.50<font color="red">↑</font>,' +
    '27.46<font color="blue">↓</font>,' +
    '19.60→,' +
    '19793<font color="red">↑</font>,' +
    '19793<font color="red">↑</font>,' +
    '0→,' +
    '56.45<font color="red">↑</font>,' +
    '68.73<font color="red">↑</font>,' +
    '0.00→';

  test('parses all fields from 市房ダム entry', () => {
    const row = parseDspDatEntry(ICHIFUSA);
    expect(row).not.toBeNull();
    expect(row?.kumamotoName).toBe('市房ダム');
    expect(row?.observedAt.toISOString()).toBe('2026-06-05T06:00:00.000Z');
    expect(row?.waterLevelM).toBeCloseTo(272.5);
    expect(row?.inflowM3s).toBeCloseTo(27.46);
    expect(row?.outflowM3s).toBeCloseTo(19.6);
    // 19793 × 1000 = 19,793,000 m³
    expect(row?.storageVolumeM3).toBe(19_793_000);
    // field[10] 貯水率(利水容量) = 68.73, not field[9] 貯水率(有効容量) = 56.45.
    expect(row?.storageRate).toBeCloseTo(0.6873);
  });

  test('strips ↑↓→ arrow indicators from numeric fields', () => {
    const row = parseDspDatEntry(ICHIFUSA);
    expect(row?.waterLevelM).toBeCloseTo(272.5);
  });

  test('multiplies 有効貯水量 by 1000 to convert 千m³ → m³', () => {
    const row = parseDspDatEntry(ICHIFUSA);
    expect(row?.storageVolumeM3).toBe(19_793_000);
  });

  test('returns null when no <u> dam name found', () => {
    expect(parseDspDatEntry('no-name,ball,2026/06/05 15:00,1,2,3,4,5,6,7,8,9')).toBeNull();
  });

  test('returns null when fewer than 10 fields', () => {
    expect(parseDspDatEntry('<u>テストダム</u>,river,2026/06/05 15:00,1,2,3')).toBeNull();
  });

  test('returns null when datetime malformed', () => {
    const bad = '<a href="#"><u>テストダム</u></a>,river,BAD DATE,1,2,3,4,5,6,7,8,9';
    expect(parseDspDatEntry(bad)).toBeNull();
  });

  test('parses zero storage volume', () => {
    const withZero =
      '<a href="#"><u>石打ダム</u></a>,' +
      '波多川,' +
      '2026/06/05 15:00,' +
      '73.99<font color="blue">↓</font>,' +
      '0.05<font color="red">↑</font>,' +
      '0.13→,' +
      '234→,' +
      '234→,' +
      '0→,' +
      '20.70→,' +
      '44.30→,' +
      '0.00→';
    const row = parseDspDatEntry(withZero);
    expect(row?.kumamotoName).toBe('石打ダム');
    expect(row?.storageVolumeM3).toBe(234_000);
    // field[10] 貯水率(利水容量) = 44.30, not field[9] 貯水率(有効容量) = 20.70.
    expect(row?.storageRate).toBeCloseTo(0.443);
  });
});

describe('kumamotoEntries', () => {
  function makePage(entries: string[]): string {
    return entries.map((e, i) => `DspDat[${i}] = '${e}';`).join('\n');
  }

  const ICHIFUSA_ENTRY =
    '<a href="JavaScript:JumpStation(575)"><FONT COLOR="blue"><u>市房ダム</u></FONT></a>,' +
    '球磨川,2026/06/05 15:00,272.50<font color="red">↑</font>,' +
    '27.46<font color="blue">↓</font>,19.60→,' +
    '19793<font color="red">↑</font>,19793<font color="red">↑</font>,0→,' +
    '56.45<font color="red">↑</font>,68.73<font color="red">↑</font>,0.00→';

  const HIKAWA_ENTRY =
    '<a href="JavaScript:JumpStation(576)"><FONT COLOR="blue"><u>氷川ダム</u></FONT></a>,' +
    '氷川,2026/06/05 15:00,164.00→,' +
    '2.46<font color="blue">↓</font>,2.41→,' +
    '1310→,1310→,0→,' +
    '22.20→,93.57→,0.00→';

  test('one entry per DspDat entry, keyed by the printed name', () => {
    const list = kumamotoEntries(makePage([ICHIFUSA_ENTRY, HIKAWA_ENTRY]));
    expect(list.map((e) => [e.key, e.name, e.pref])).toEqual([
      ['市房ダム', '市房ダム', '43'],
      ['氷川ダム', '氷川ダム', '43'],
    ]);
  });

  test('returns nothing for a page with no DspDat entries', () => {
    expect(kumamotoEntries('<html></html>')).toHaveLength(0);
  });

  test('skips an entry without a name; one with a bad time is listed unreadable', () => {
    const list = kumamotoEntries(
      makePage([
        'no-u-tag,river,2026/06/05 15:00,1,2,3,4,5,6,7,8,9',
        ICHIFUSA_ENTRY.replace('2026/06/05 15:00', 'BAD DATE'),
        HIKAWA_ENTRY,
      ]),
    );
    expect(
      list.map((e) => [e.key, typeof e.reading === 'function' ? '' : e.reading.state]),
    ).toEqual([
      ['市房ダム', 'unreadable'],
      ['氷川ダム', 'values'],
    ]);
  });

  test('氷川ダム storage volume = 1310 × 1000 = 1,310,000 m³', () => {
    const o = observation(kumamotoEntries(makePage([HIKAWA_ENTRY]))[0]);
    expect(o?.storageVolumeM3).toBe(1_310_000);
    // field[10] 貯水率(利水容量) = 93.57, not field[9] 貯水率(有効容量) = 22.20.
    expect(o?.storageRate).toBeCloseTo(0.9357);
  });

  test('the live page lists all six dams with a 24:00 time read as the next midnight', async () => {
    const html = new TextDecoder('shift_jis').decode(await readFile(FIXTURE));
    const list = kumamotoEntries(html);
    expect(list.map((e) => e.key)).toEqual([
      '市房ダム',
      '氷川ダム',
      '石打ダム',
      '上津浦ダム',
      '亀川ダム',
      '路木ダム',
    ]);
    const ichifusa = observation(list[0]);
    expect(ichifusa?.observedAt.toISOString()).toBe('2026-10-26T15:00:00.000Z');
    expect(ichifusa?.storageVolumeM3).toBe(4_034_000);
    expect(ichifusa?.storageRate).toBeCloseTo(0.1401, 6);
  });
});
