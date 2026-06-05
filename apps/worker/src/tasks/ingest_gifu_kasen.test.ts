// apps/worker/src/tasks/ingest_gifu_kasen.test.ts

import { describe, expect, test } from 'bun:test';
import { parseGifuDatetime, parseGifuPage } from './ingest_gifu_kasen.ts';

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

describe('parseGifuPage', () => {
  test('parses all valid dam sections', () => {
    const rows = parseGifuPage(SAMPLE_PAGE);
    // 大ヶ洞 (all ***) and 牧尾 (all ---) are both skipped
    expect(rows).toHaveLength(3);
    expect(rows.map((r) => r.gifuName)).toEqual(['阿多岐ダム', '岩村ダム', '徳山ダム']);
  });

  test('all rows share the same observedAt timestamp', () => {
    const rows = parseGifuPage(SAMPLE_PAGE);
    const ts = '2026-06-05T07:40:00.000Z';
    for (const r of rows) {
      expect(r.observedAt.toISOString()).toBe(ts);
    }
  });

  test('converts 貯水量 千m³ → m³ (× 1000)', () => {
    const rows = parseGifuPage(SAMPLE_PAGE);
    const atagi = rows.find((r) => r.gifuName === '阿多岐ダム');
    expect(atagi?.storageVolumeM3).toBe(499_000);
  });

  test('parses fractional values correctly', () => {
    const rows = parseGifuPage(SAMPLE_PAGE);
    const iwamura = rows.find((r) => r.gifuName === '岩村ダム');
    expect(iwamura?.storageVolumeM3).toBe(79_500);
    expect(iwamura?.outflowM3s).toBeCloseTo(0.068);
    expect(iwamura?.inflowM3s).toBeCloseTo(0.069);
  });

  test('徳山ダム large storage value', () => {
    const rows = parseGifuPage(SAMPLE_PAGE);
    const tokuyama = rows.find((r) => r.gifuName === '徳山ダム');
    expect(tokuyama?.storageVolumeM3).toBe(268_028_000);
    expect(tokuyama?.outflowM3s).toBeCloseTo(37.23);
    expect(tokuyama?.inflowM3s).toBeCloseTo(13.74);
  });

  test('skips dams with all *** (欠測) values', () => {
    const rows = parseGifuPage(SAMPLE_PAGE);
    expect(rows.find((r) => r.gifuName === '大ヶ洞ダム')).toBeUndefined();
  });

  test('skips dams with all --- (無効) values', () => {
    const rows = parseGifuPage(SAMPLE_PAGE);
    expect(rows.find((r) => r.gifuName === '牧尾ダム')).toBeUndefined();
  });

  test('does not match the [更新] link bracket', () => {
    const rows = parseGifuPage(SAMPLE_PAGE);
    expect(rows.find((r) => r.gifuName.includes('更新'))).toBeUndefined();
  });

  test('returns empty array for page with no timestamp', () => {
    expect(parseGifuPage('<html><body>no data</body></html>')).toHaveLength(0);
  });

  test('returns empty array for empty string', () => {
    expect(parseGifuPage('')).toHaveLength(0);
  });
});
