// apps/worker/src/tasks/ingest_qsr_turuta.test.ts
//
// Fixture → universe entries, no database: binding and writing belong to the
// ingest run (apps/worker/src/ingest/run.test.ts).

import { describe, expect, test } from 'bun:test';
import type { Reading } from '../ingest/types.ts';
import { parseTurutaTimestamp, turutaEntries, turutaReading } from './ingest_qsr_turuta.ts';

// Minimal EUC-JP response (already decoded to UTF-8 string for tests)
const SAMPLE_HTML = `
<HTML>
<HEAD>
<TITLE>リアルタイムダム諸量一覧表</TITLE>
</HEAD>
<BODY>
<TABLE>
  <TBODY>
    <TR>
      <TD align="center">2026/06/05</TD>
      <TD align="center">18:30</TD>
      <TD align="right"><FONT COLOR="#0000FF">0.0</FONT></TD>
      <TD align="right"><FONT COLOR="#0000FF">3543</FONT></TD>
      <TD align="right"><FONT COLOR="#0000FF">119.17</FONT></TD>
      <TD align="right"><FONT COLOR="#0000FF">119.00</FONT></TD>
      <TD align="right"><FONT COLOR="#0000FF">3.5</FONT></TD>
    </TR>
    <TR>
      <TD align="center">2026/06/05</TD>
      <TD align="center">18:20</TD>
      <TD align="right"><FONT COLOR="#0000FF">0.0</FONT></TD>
      <TD align="right"><FONT COLOR="#0000FF">3543</FONT></TD>
      <TD align="right"><FONT COLOR="#0000FF">119.40</FONT></TD>
      <TD align="right"><FONT COLOR="#0000FF">119.00</FONT></TD>
      <TD align="right"><FONT COLOR="#0000FF">3.5</FONT></TD>
    </TR>
  </TBODY>
</TABLE>
</BODY>
</HTML>
`;

const EXPECT_AT = '2026-06-05T09:30:00.000Z';
const EXPECT_M3 = 3_543_000;
const EXPECT_RATE = 0.035;
const EXPECT_IN = 119.17;
const EXPECT_OUT = 119.0;

describe('parseTurutaTimestamp', () => {
  test('parses "YYYY/MM/DD HH:MM" (JST) → UTC', () => {
    const d = parseTurutaTimestamp('2026/06/05', '18:30');
    expect(d?.toISOString()).toBe('2026-06-05T09:30:00.000Z');
  });

  test('handles midnight crossover', () => {
    const d = parseTurutaTimestamp('2026/06/05', '01:00');
    expect(d?.toISOString()).toBe('2026-06-04T16:00:00.000Z');
  });

  test('returns null for malformed input', () => {
    expect(parseTurutaTimestamp('', '18:30')).toBeNull();
    expect(parseTurutaTimestamp('2026/06/05', '')).toBeNull();
    expect(parseTurutaTimestamp('bad', 'bad')).toBeNull();
  });
});

function observed(r: Reading) {
  if (r.state !== 'values') throw new Error(`expected values, got ${r.state}`);
  const [o] = r.observations;
  if (!o) throw new Error('no observation');
  return o;
}

describe('turutaReading', () => {
  test('reads the most recent row (first TR)', () => {
    expect(observed(turutaReading(SAMPLE_HTML)).observedAt.toISOString()).toBe(EXPECT_AT);
  });

  test('storage volume converted from 千m³ to m³', () => {
    expect(observed(turutaReading(SAMPLE_HTML)).storageVolumeM3).toBe(EXPECT_M3);
  });

  test('storageRate as decimal ratio', () => {
    expect(observed(turutaReading(SAMPLE_HTML)).storageRate).toBeCloseTo(EXPECT_RATE);
  });

  test('inflow and outflow parsed correctly', () => {
    const o = observed(turutaReading(SAMPLE_HTML));
    expect(o.inflowM3s).toBeCloseTo(EXPECT_IN);
    expect(o.outflowM3s).toBeCloseTo(EXPECT_OUT);
  });

  test('rainfall parsed correctly', () => {
    expect(observed(turutaReading(SAMPLE_HTML)).rainfallMm).toBeCloseTo(0.0);
  });

  test('skips a newest row with no stored value for the next one', () => {
    const html = `<TABLE><TR>
      <TD>2026/06/05</TD><TD>19:00</TD>
      <TD></TD><TD></TD><TD></TD><TD></TD><TD></TD>
    </TR></TABLE>${SAMPLE_HTML}`;
    expect(observed(turutaReading(html)).observedAt.toISOString()).toBe(EXPECT_AT);
  });

  test('an empty page is unreadable', () => {
    expect(turutaReading('').state).toBe('unreadable');
    expect(turutaReading('<HTML></HTML>').state).toBe('unreadable');
  });

  test('a row with blank numeric cells is unreadable', () => {
    const html = `<TABLE><TR>
      <TD>2026/06/05</TD><TD>18:30</TD>
      <TD></TD><TD></TD><TD></TD><TD></TD><TD></TD>
    </TR></TABLE>`;
    expect(turutaReading(html).state).toBe('unreadable');
  });

  test('欠測 in every stored column of every row is provider-marked empty', () => {
    const html = `<TABLE><TR>
      <TD>2026/06/05</TD><TD>18:30</TD>
      <TD>欠測</TD><TD>欠測</TD><TD>欠測</TD><TD>欠測</TD><TD>欠測</TD>
    </TR></TABLE>`;
    expect(turutaReading(html)).toEqual({
      state: 'empty',
      mark: '欠測 in every stored column of every row',
    });
  });
});

describe('turutaEntries', () => {
  test('lists 鶴田ダム by name in 鹿児島 and reads it from the page', async () => {
    const [entry, ...rest] = turutaEntries(async () => SAMPLE_HTML);
    expect(rest).toEqual([]);
    expect(entry).toMatchObject({ key: '鶴田ダム', name: '鶴田ダム', pref: '46' });
    if (typeof entry?.reading !== 'function') throw new Error('expected a reading function');
    expect((await entry.reading(null)).state).toBe('values');
  });

  test('a page that fails to load makes the reading throw (the run records it unreadable)', async () => {
    const [entry] = turutaEntries(() => Promise.reject(new Error('HTTP 503')));
    if (typeof entry?.reading !== 'function') throw new Error('expected a reading function');
    await expect(Promise.resolve(entry.reading(null))).rejects.toThrow('HTTP 503');
  });
});
