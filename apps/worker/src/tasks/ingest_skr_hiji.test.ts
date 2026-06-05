// apps/worker/src/tasks/ingest_skr_hiji.test.ts

import { describe, expect, test } from 'bun:test';
import { parseHijiIframeHtml, parseHijiTimestamp } from './ingest_skr_hiji.ts';

const SAMPLE_IFRAME_HTML = `
<HTML>
<HEAD>
<META http-equiv="Content-Type" content="text/html; charset=EUC-JP">
<TITLE>リアルタイムダム諸量一覧表</TITLE>
</HEAD>
<BODY bgcolor="#e6e6e6">
<TABLE border="0" width="800">
  <TBODY>
    <TR>
      <TD align="center" width='18%'>2026/06/05</TD>
      <TD align="center" width='7%'>18:50</TD>
      <TD align="right" width='12.5%'><FONT COLOR="#0000FF">0.0</FONT></TD>
      <TD align="right" width='12.5%'><FONT COLOR="#0000FF">10541</FONT></TD>
      <TD align="right" width='12.5%'><FONT COLOR="#0000FF">12.49</FONT></TD>
      <TD align="right" width='12.5%'><FONT COLOR="#0000FF">11.70</FONT></TD>
      <TD align="right" width='12.5%'><FONT COLOR="#0000FF">86.5</FONT></TD>
    </TR>
    <TR>
      <TD align="center" width='18%'>2026/06/05</TD>
      <TD align="center" width='7%'>18:40</TD>
      <TD align="right" width='12.5%'><FONT COLOR="#0000FF">0.0</FONT></TD>
      <TD align="right" width='12.5%'><FONT COLOR="#0000FF">10541</FONT></TD>
      <TD align="right" width='12.5%'><FONT COLOR="#0000FF">12.49</FONT></TD>
      <TD align="right" width='12.5%'><FONT COLOR="#0000FF">11.72</FONT></TD>
      <TD align="right" width='12.5%'><FONT COLOR="#0000FF">86.5</FONT></TD>
    </TR>
  </TBODY>
</TABLE>
</BODY>
</HTML>
`;

describe('parseHijiTimestamp', () => {
  test('parses "YYYY/MM/DD HH:MM" (JST) → UTC', () => {
    const d = parseHijiTimestamp('2026/06/05', '18:50');
    expect(d?.toISOString()).toBe('2026-06-05T09:50:00.000Z');
  });

  test('handles midnight crossover', () => {
    const d = parseHijiTimestamp('2026/06/06', '00:10');
    expect(d?.toISOString()).toBe('2026-06-05T15:10:00.000Z');
  });

  test('returns null for malformed input', () => {
    expect(parseHijiTimestamp('', '18:50')).toBeNull();
    expect(parseHijiTimestamp('2026/06/05', '')).toBeNull();
    expect(parseHijiTimestamp('bad', 'bad')).toBeNull();
  });
});

describe('parseHijiIframeHtml', () => {
  const OBS_ID = '1368080276020';

  test('returns most recent row (first TR with valid date)', () => {
    const row = parseHijiIframeHtml(OBS_ID, SAMPLE_IFRAME_HTML);
    expect(row).not.toBeNull();
    expect(row?.obsId).toBe(OBS_ID);
    expect(row?.observedAt.toISOString()).toBe('2026-06-05T09:50:00.000Z');
  });

  test('storage volume converted from 千m³ to m³', () => {
    const row = parseHijiIframeHtml(OBS_ID, SAMPLE_IFRAME_HTML);
    expect(row?.storageVolumeM3).toBe(10_541_000);
  });

  test('storageRate as decimal ratio', () => {
    const row = parseHijiIframeHtml(OBS_ID, SAMPLE_IFRAME_HTML);
    expect(row?.storageRate).toBeCloseTo(0.865);
  });

  test('inflow and outflow parsed correctly', () => {
    const row = parseHijiIframeHtml(OBS_ID, SAMPLE_IFRAME_HTML);
    expect(row?.inflowM3s).toBeCloseTo(12.49);
    expect(row?.outflowM3s).toBeCloseTo(11.7);
  });

  test('rainfall parsed correctly', () => {
    const row = parseHijiIframeHtml(OBS_ID, SAMPLE_IFRAME_HTML);
    expect(row?.rainfallMm).toBeCloseTo(0.0);
  });

  test('returns null for empty HTML', () => {
    expect(parseHijiIframeHtml(OBS_ID, '')).toBeNull();
    expect(parseHijiIframeHtml(OBS_ID, '<HTML></HTML>')).toBeNull();
  });

  test('returns null when all numeric fields are missing', () => {
    const html = `<TABLE><TR>
      <TD>2026/06/05</TD><TD>18:50</TD>
      <TD></TD><TD></TD><TD></TD><TD></TD><TD></TD>
    </TR></TABLE>`;
    expect(parseHijiIframeHtml(OBS_ID, html)).toBeNull();
  });

  test('obsId is preserved in returned row', () => {
    const row = parseHijiIframeHtml('1368080255010', SAMPLE_IFRAME_HTML);
    expect(row?.obsId).toBe('1368080255010');
  });
});
