// apps/worker/src/tasks/ingest_gifu_kasen.test.ts
//
// Page → universe entries, no database: binding and writing belong to the
// ingest run (apps/worker/src/ingest/run.test.ts).

import { describe, expect, test } from 'bun:test';
import type { Entry, Observed } from '../ingest/types.ts';
import { gifuEntries, parseGifuDatetime } from './ingest_gifu_kasen.ts';

function observed(e: Entry | undefined): Observed | undefined {
  const r = e?.reading;
  if (!r || typeof r === 'function' || r.state !== 'values') throw new Error('no values');
  return r.observations[0];
}
const states = (entries: Entry[]) =>
  entries.map((e) => [e.name, typeof e.reading === 'function' ? 'fn' : e.reading.state]);

describe('parseGifuDatetime', () => {
  test('parses "YYYY/MM/DD HH:MM現在" JST → UTC', () => {
    const d = parseGifuDatetime('2026/06/05 16:40現在');
    expect(d?.toISOString()).toBe('2026-06-05T07:40:00.000Z');
  });

  test('handles midnight crossover (JST < 09:00 → previous UTC day)', () => {
    const d = parseGifuDatetime('2026/06/05 08:00現在');
    expect(d?.toISOString()).toBe('2026-06-04T23:00:00.000Z');
  });

  test('returns null for malformed input', () => {
    expect(parseGifuDatetime('')).toBeNull();
    expect(parseGifuDatetime('2026/06/05 16:40')).toBeNull();
    expect(parseGifuDatetime('bad')).toBeNull();
  });
});

const SAMPLE_PAGE = `<Html><Head><Title>ダム諸量</Title></Head><Body>
<HR size=1>
2026/06/05 16:40現在
<HR size=1>
[<a href='Dam.html'>更新</a>]<br>
<HR size=1>
<pre>
[阿多岐ダム]
<Font size='1'>木曽川水系&nbsp;阿多岐川</Font>
<pre>
&nbsp;貯水量&nbsp;&nbsp;&nbsp;      499&nbsp;千m3
&nbsp;放流量&nbsp;&nbsp;&nbsp;    0.667&nbsp;m3/s
&nbsp;全流入量&nbsp;    0.638&nbsp;m3/s
</pre>
[大ヶ洞ダム]
<Font size='1'>木曽川水系&nbsp;大ケ洞川</Font>
<pre>
&nbsp;貯水量&nbsp;&nbsp;&nbsp;      ***&nbsp;千m3
&nbsp;放流量&nbsp;&nbsp;&nbsp;      ***&nbsp;m3/s
&nbsp;全流入量&nbsp;      ***&nbsp;m3/s
</pre>
[岩村ダム]
<Font size='1'>木曽川水系&nbsp;富田川</Font>
<pre>
&nbsp;貯水量&nbsp;&nbsp;&nbsp;     79.5&nbsp;千m3
&nbsp;放流量&nbsp;&nbsp;&nbsp;    0.068&nbsp;m3/s
&nbsp;全流入量&nbsp;    0.069&nbsp;m3/s
</pre>
[徳山ダム]
<Font size='1'>木曽川水系&nbsp;揖斐川</Font>
<pre>
&nbsp;貯水量&nbsp;&nbsp;&nbsp;   268028&nbsp;千m3
&nbsp;放流量&nbsp;&nbsp;&nbsp;    37.23&nbsp;m3/s
&nbsp;全流入量&nbsp;    13.74&nbsp;m3/s
</pre>
[牧尾ダム]
<Font size='1'>木曽川水系&nbsp;木曽川</Font>
<pre>
&nbsp;貯水量&nbsp;&nbsp;&nbsp;      ---&nbsp;千m3
&nbsp;放流量&nbsp;&nbsp;&nbsp;      ---&nbsp;m3/s
&nbsp;全流入量&nbsp;      ---&nbsp;m3/s
</pre>
</pre>
</Body></Html>`;

describe('gifuEntries', () => {
  const entries = gifuEntries(SAMPLE_PAGE);
  const named = (n: string) => entries.find((e) => e.name === n);

  test('every dam section is an entry, keyed by name; *** and --- everywhere are marked empty', () => {
    expect(states(entries)).toEqual([
      ['阿多岐ダム', 'values'],
      ['大ヶ洞ダム', 'empty'], // all *** (欠測)
      ['岩村ダム', 'values'],
      ['徳山ダム', 'values'],
      ['牧尾ダム', 'empty'], // all --- (無効)
    ]);
    expect(entries.map((e) => e.key)).toEqual(entries.map((e) => e.name));
  });

  test('all rows share the same observedAt timestamp', () => {
    for (const n of ['阿多岐ダム', '岩村ダム', '徳山ダム']) {
      expect(observed(named(n))?.observedAt.toISOString()).toBe('2026-06-05T07:40:00.000Z');
    }
  });

  test('converts 貯水量 千m³ → m³ (× 1000)', () => {
    expect(observed(named('阿多岐ダム'))?.storageVolumeM3).toBe(499_000);
  });

  test('parses fractional values correctly', () => {
    const iwamura = observed(named('岩村ダム'));
    expect(iwamura?.storageVolumeM3).toBe(79_500);
    expect(iwamura?.outflowM3s).toBeCloseTo(0.068);
    expect(iwamura?.inflowM3s).toBeCloseTo(0.069);
  });

  test('徳山ダム large storage value', () => {
    const tokuyama = observed(named('徳山ダム'));
    expect(tokuyama?.storageVolumeM3).toBe(268_028_000);
    expect(tokuyama?.outflowM3s).toBeCloseTo(37.23);
    expect(tokuyama?.inflowM3s).toBeCloseTo(13.74);
  });

  test('does not match the [更新] link bracket', () => {
    expect(entries.find((e) => e.name.includes('更新'))).toBeUndefined();
  });

  test('a page without its timestamp lists the dams but reads none', () => {
    const undated = SAMPLE_PAGE.replace('2026/06/05 16:40現在', '');
    expect(states(gifuEntries(undated)).map(([, s]) => s)).toEqual([
      'unreadable',
      'empty',
      'unreadable',
      'unreadable',
      'empty',
    ]);
  });

  test('lists nothing for a page with no dam section', () => {
    expect(gifuEntries('<html><body>no data</body></html>')).toHaveLength(0);
    expect(gifuEntries('')).toHaveLength(0);
  });
});

describe('gifuEntries prefecture (#79)', () => {
  // ダム便覧 has two 岩村: NDI 97 in 北海道 and NDI 925, the 富田川 dam this
  // page reports, in 岐阜. The page also carries upper-Kiso and Yahagi dams
  // outside 岐阜 (/h/Dam.html, 2026-09-27); ダム便覧 files them under 長野
  // and 愛知.
  test('岩村ダム is searched in 岐阜; 牧尾 and 味噌川 in 長野, 矢作 in 愛知', () => {
    const page = (name: string) =>
      `2026/06/05 16:40現在\n[${name}]\n<pre>\n 貯水量    1 千m3\n 放流量    1 m3/s\n 全流入量  1 m3/s\n</pre>`;
    const pref = (name: string) => gifuEntries(page(name))[0]?.pref;
    expect(pref('岩村ダム')).toBe('21');
    expect(pref('牧尾ダム')).toBe('20');
    expect(pref('味噌川ダム')).toBe('20');
    expect(pref('矢作ダム')).toBe('23');
  });
});
