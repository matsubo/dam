// apps/worker/src/tasks/ingest_skr_hiji.test.ts
//
// Fixture → universe entries, no database: binding and writing belong to the
// ingest run (apps/worker/src/ingest/run.test.ts).

import { describe, expect, test } from 'bun:test';
import type { Reading } from '../ingest/types.ts';
import { hijiEntries, hijiIframeUrl, hijiReading, parseHijiTimestamp } from './ingest_skr_hiji.ts';

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

// The outer DspDamData.exe page, trimmed to its IFRAME (captured 2026-10-27).
const OUTER_HTML = `<TD>
<IFRAME src="/html/frm/DamFree10Data202610270048543126096.html" scrolling="AUTO" width="840" height="65%" align="middle" frameborder="0"></IFRAME>
</TD>`;

const EXPECT_AT = '2026-06-05T09:50:00.000Z';
const EXPECT_M3 = 10_541_000;
const EXPECT_RATE = 0.865;
const EXPECT_IN = 12.49;
const EXPECT_OUT = 11.7;

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

function observed(r: Reading) {
  if (r.state !== 'values') throw new Error(`expected values, got ${r.state}`);
  const [o] = r.observations;
  if (!o) throw new Error('no observation');
  return o;
}

describe('hijiReading', () => {
  test('reads the most recent row (first TR)', () => {
    expect(observed(hijiReading(SAMPLE_IFRAME_HTML)).observedAt.toISOString()).toBe(EXPECT_AT);
  });

  test('storage volume converted from 千m³ to m³', () => {
    expect(observed(hijiReading(SAMPLE_IFRAME_HTML)).storageVolumeM3).toBe(EXPECT_M3);
  });

  test('storageRate as decimal ratio', () => {
    expect(observed(hijiReading(SAMPLE_IFRAME_HTML)).storageRate).toBeCloseTo(EXPECT_RATE);
  });

  test('inflow and outflow parsed correctly', () => {
    const o = observed(hijiReading(SAMPLE_IFRAME_HTML));
    expect(o.inflowM3s).toBeCloseTo(EXPECT_IN);
    expect(o.outflowM3s).toBeCloseTo(EXPECT_OUT);
  });

  test('rainfall parsed correctly', () => {
    expect(observed(hijiReading(SAMPLE_IFRAME_HTML)).rainfallMm).toBeCloseTo(0.0);
  });

  test('skips a newest row with no stored value for the next one', () => {
    const html = `<TABLE><TR>
      <TD>2026/06/05</TD><TD>19:00</TD>
      <TD></TD><TD></TD><TD></TD><TD></TD><TD></TD>
    </TR></TABLE>${SAMPLE_IFRAME_HTML}`;
    expect(observed(hijiReading(html)).observedAt.toISOString()).toBe(EXPECT_AT);
  });

  test('an empty page is unreadable', () => {
    expect(hijiReading('').state).toBe('unreadable');
    expect(hijiReading('<HTML></HTML>').state).toBe('unreadable');
  });

  test('a row with blank numeric cells is unreadable', () => {
    const html = `<TABLE><TR>
      <TD>2026/06/05</TD><TD>18:30</TD>
      <TD></TD><TD></TD><TD></TD><TD></TD><TD></TD>
    </TR></TABLE>`;
    expect(hijiReading(html).state).toBe('unreadable');
  });

  test('欠測 in every stored column of every row is provider-marked empty', () => {
    const html = `<TABLE><TR>
      <TD>2026/06/05</TD><TD>18:30</TD>
      <TD>欠測</TD><TD>欠測</TD><TD>欠測</TD><TD>欠測</TD><TD>欠測</TD>
    </TR></TABLE>`;
    expect(hijiReading(html)).toEqual({
      state: 'empty',
      mark: '欠測 in every stored column of every row',
    });
  });
});

describe('hijiEntries', () => {
  test('lists 野村 and 鹿野川 by 観測所 id in 愛媛, each read via its outer page and IFRAME', async () => {
    const urls: string[] = [];
    const entries = hijiEntries(async (url) => {
      urls.push(url);
      return url.includes('DspDamData.exe') ? OUTER_HTML : SAMPLE_IFRAME_HTML;
    });
    expect(entries.map((e) => [e.key, e.name, e.pref])).toEqual([
      ['1368080276020', '野村ダム', '38'],
      ['1368080255010', '鹿野川ダム', '38'],
    ]);
    const nomura = entries[0];
    if (typeof nomura?.reading !== 'function') throw new Error('expected a reading function');
    expect((await nomura.reading(null)).state).toBe('values');
    expect(urls).toEqual([
      'http://www1.river.go.jp/cgi-bin/DspDamData.exe?ID=1368080276020&KIND=3&PAGE=0',
      'http://www1.river.go.jp/html/frm/DamFree10Data202610270048543126096.html',
    ]);
  });

  test('an outer page without an IFRAME is unreadable', async () => {
    const [nomura] = hijiEntries(async () => '<HTML></HTML>');
    if (typeof nomura?.reading !== 'function') throw new Error('expected a reading function');
    expect((await nomura.reading(null)).state).toBe('unreadable');
  });

  test('a page that fails to load makes the reading throw (the run records it unreadable)', async () => {
    const [nomura] = hijiEntries(() => Promise.reject(new Error('HTTP 503')));
    if (typeof nomura?.reading !== 'function') throw new Error('expected a reading function');
    await expect(Promise.resolve(nomura.reading(null))).rejects.toThrow('HTTP 503');
  });

  test('hijiIframeUrl returns null without an IFRAME', () => {
    expect(hijiIframeUrl('')).toBeNull();
  });
});
