// apps/worker/src/tasks/ingest_aichi_kasen.test.ts
//
// Page → universe entries, no database: binding and writing belong to the
// ingest run (apps/worker/src/ingest/run.test.ts).

import { describe, expect, test } from 'bun:test';
import type { Entry, Observed } from '../ingest/types.ts';
import { aichiEntries, parseAichiRefYear, parseAichiRowTimestamp } from './ingest_aichi_kasen.ts';

function observations(e: Entry | undefined): readonly Observed[] {
  const r = e?.reading;
  if (!r || typeof r === 'function' || r.state !== 'values') throw new Error('no values');
  return r.observations;
}
const state = (e: Entry | undefined) =>
  e && typeof e.reading !== 'function' ? e.reading.state : undefined;

describe('parseAichiRefYear', () => {
  test('extracts year from <span id="timestamp"> element', () => {
    expect(parseAichiRefYear('<span id="timestamp">2026年06月05日 16時50分</span>')).toBe(2026);
  });

  test('returns null when timestamp element is absent', () => {
    expect(parseAichiRefYear('<html><body>no timestamp</body></html>')).toBeNull();
  });
});

describe('parseAichiRowTimestamp', () => {
  // Reference: 2026-06-05 16:50 JST = 2026-06-05T07:50Z
  const REF = new Date('2026-06-05T07:50:00.000Z');

  test('parses MM/DD HH:MM JST → UTC (subtract 9h)', () => {
    const d = parseAichiRowTimestamp('06/05', '16:00', 2026, REF);
    expect(d?.toISOString()).toBe('2026-06-05T07:00:00.000Z');
  });

  test('handles midnight crossover (JST < 09:00 → previous UTC day)', () => {
    const d = parseAichiRowTimestamp('06/05', '08:00', 2026, REF);
    expect(d?.toISOString()).toBe('2026-06-04T23:00:00.000Z');
  });

  test('year rollover: Dec row when reference is Jan 1', () => {
    const refJan = new Date('2027-01-01T01:00:00.000Z'); // 2027-01-01 10:00 JST
    const d = parseAichiRowTimestamp('12/31', '23:50', 2027, refJan);
    // 2027-12-31 23:50 JST would be ~365 days in future → use 2026
    expect(d?.toISOString()).toBe('2026-12-31T14:50:00.000Z');
  });

  test('returns null for malformed input', () => {
    expect(parseAichiRowTimestamp('bad', '16:00', 2026, REF)).toBeNull();
    expect(parseAichiRowTimestamp('06/05', 'bad', 2026, REF)).toBeNull();
  });
});

// Minimal sample page covering normal values, 欠測 (雨山 missing), and
// a fully-null row that should be skipped entirely.
const SAMPLE_PAGE = `<!DOCTYPE html>
<html lang="ja">
<head><title>愛知県 川の防災情報</title></head>
<body>
<span id="timestamp">2026年06月05日 16時40分</span>
<div id="data-contents">
<table id="data-contents-table">
<tr class="even">
<th>06/05 16:00</th>
<td class="getData">
    <span>269.42</span>
</td>
<td class="getData">
    <span>81.1</span>
</td>
<td class="getData">
    <span>0.183</span>
</td>
<td class="getData">
    <span>0.180</span>
</td>
<td class="getData">
    <span>193.27</span>
</td>
<td class="getData">
    <span>195.7</span>
</td>
<td class="getData">
    <span>0.209</span>
</td>
<td class="getData">
    <span>0.181</span>
</td>
</tr>
<tr class="odd">
<th>06/05 15:50</th>
<td class="getData">
    <span>**</span>
    <span class="label">欠測</span>
</td>
<td class="getData">
    <span>**</span>
    <span class="label">欠測</span>
</td>
<td class="getData">
    <span>**</span>
    <span class="label">欠測</span>
</td>
<td class="getData">
    <span>**</span>
    <span class="label">欠測</span>
</td>
<td class="getData">
    <span>193.25</span>
</td>
<td class="getData">
    <span>195.4</span>
</td>
<td class="getData">
    <span>0.196</span>
</td>
<td class="getData">
    <span>0.174</span>
</td>
</tr>
<tr class="even">
<th>06/05 15:40</th>
<td class="getData">
    <span>--</span>
    <span class="label">未収集</span>
</td>
<td class="getData">
    <span>--</span>
    <span class="label">未収集</span>
</td>
<td class="getData">
    <span>--</span>
    <span class="label">未収集</span>
</td>
<td class="getData">
    <span>--</span>
    <span class="label">未収集</span>
</td>
<td class="getData">
    <span>--</span>
    <span class="label">未収集</span>
</td>
<td class="getData">
    <span>--</span>
    <span class="label">未収集</span>
</td>
<td class="getData">
    <span>--</span>
    <span class="label">未収集</span>
</td>
<td class="getData">
    <span>--</span>
    <span class="label">未収集</span>
</td>
</tr>
</table>
</div>
</body></html>`;

describe('aichiEntries', () => {
  const [amayama, kise] = aichiEntries(SAMPLE_PAGE);
  const at = (os: readonly Observed[], iso: string) =>
    os.find((o) => o.observedAt.toISOString() === iso);

  test('both fixed columns are entries, keyed by name', () => {
    expect(aichiEntries(SAMPLE_PAGE).map((e) => [e.key, e.pref])).toEqual([
      ['雨山ダム', '23'],
      ['木瀬ダム', '23'],
    ]);
  });

  test('a row is an observation only where it carries a value: 3 in all', () => {
    // Row 0: both dams have data; row 1: 雨山 all ** but 木瀬 has data;
    // row 2: all -- for both.
    expect(observations(amayama).map((o) => o.observedAt.toISOString())).toEqual([
      '2026-06-05T07:00:00.000Z',
    ]);
    expect(observations(kise).map((o) => o.observedAt.toISOString())).toEqual([
      '2026-06-05T07:00:00.000Z',
      '2026-06-05T06:50:00.000Z',
    ]);
  });

  test('row 0 雨山ダム: all fields present with correct timestamp', () => {
    const r = at(observations(amayama), '2026-06-05T07:00:00.000Z');
    expect(r?.waterLevelM).toBeCloseTo(269.42);
    expect(r?.storageVolumeM3).toBe(81_100);
    expect(r?.inflowM3s).toBeCloseTo(0.183);
    expect(r?.outflowM3s).toBeCloseTo(0.18);
  });

  test('converts 貯水量 千m³ → m³ (× 1000)', () => {
    expect(at(observations(kise), '2026-06-05T07:00:00.000Z')?.storageVolumeM3).toBe(195_700);
  });

  test('row 1 木瀬ダム has data (partial row is kept)', () => {
    expect(at(observations(kise), '2026-06-05T06:50:00.000Z')?.storageVolumeM3).toBe(195_400);
  });

  test('a dam marked ** / -- in every row is provider-marked empty', () => {
    // Drop row 0, the only row where 雨山 carries values.
    const page = SAMPLE_PAGE.replace(/<tr class="even">\s*<th>06\/05 16:00[\s\S]*?<\/tr>/, '');
    const [a, k] = aichiEntries(page);
    expect(state(a)).toBe('empty');
    expect(state(k)).toBe('values');
  });

  test('an unparsed cell is not a mark: the dam is unreadable', () => {
    const page = SAMPLE_PAGE.replace(
      /<tr class="even">\s*<th>06\/05 16:00[\s\S]*?<\/tr>/,
      '',
    ).replace('<span>**</span>', '<span>?</span>');
    expect(state(aichiEntries(page)[0])).toBe('unreadable');
  });

  test('a page without its timestamp leaves both dams unreadable', () => {
    for (const html of ['<html><body>no data</body></html>', '']) {
      expect(aichiEntries(html).map(state)).toEqual(['unreadable', 'unreadable']);
    }
  });
});
