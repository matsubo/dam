// apps/worker/src/tasks/ingest_qsr_turuta.test.ts

import { describe, expect, test } from 'bun:test';
import { parseTurutaHtml, parseTurutaTimestamp } from './ingest_qsr_turuta.ts';

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

describe('parseTurutaHtml', () => {
  test('returns most recent row (first TR)', () => {
    const row = parseTurutaHtml(SAMPLE_HTML);
    expect(row).not.toBeNull();
    expect(row?.observedAt.toISOString()).toBe('2026-06-05T09:30:00.000Z');
  });

  test('storage volume converted from 千m³ to m³', () => {
    const row = parseTurutaHtml(SAMPLE_HTML);
    expect(row?.storageVolumeM3).toBe(3_543_000);
  });

  test('storageRate as decimal ratio', () => {
    const row = parseTurutaHtml(SAMPLE_HTML);
    expect(row?.storageRate).toBeCloseTo(0.035);
  });

  test('inflow and outflow parsed correctly', () => {
    const row = parseTurutaHtml(SAMPLE_HTML);
    expect(row?.inflowM3s).toBeCloseTo(119.17);
    expect(row?.outflowM3s).toBeCloseTo(119.0);
  });

  test('rainfall parsed correctly', () => {
    const row = parseTurutaHtml(SAMPLE_HTML);
    expect(row?.rainfallMm).toBeCloseTo(0.0);
  });

  test('returns null for empty HTML', () => {
    expect(parseTurutaHtml('')).toBeNull();
    expect(parseTurutaHtml('<HTML></HTML>')).toBeNull();
  });

  test('returns null when all numeric fields are missing', () => {
    const html = `<TABLE><TR>
      <TD>2026/06/05</TD><TD>18:30</TD>
      <TD></TD><TD></TD><TD></TD><TD></TD><TD></TD>
    </TR></TABLE>`;
    expect(parseTurutaHtml(html)).toBeNull();
  });
});
