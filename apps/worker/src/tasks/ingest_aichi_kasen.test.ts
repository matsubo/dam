// apps/worker/src/tasks/ingest_aichi_kasen.test.ts

import { describe, expect, test } from 'bun:test';
import { parseAichiPage, parseAichiRefYear, parseAichiRowTimestamp } from './ingest_aichi_kasen.ts';

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

describe('parseAichiPage', () => {
  test('parses 3 rows × 2 dams, skipping fully-null row → 3 results', () => {
    const rows = parseAichiPage(SAMPLE_PAGE);
    // Row 0: both dams have data (2 rows)
    // Row 1: 雨山 all **(null) but 木瀬 has data (1 row)
    // Row 2: all -- → both dams fully null → skipped (0 rows)
    expect(rows).toHaveLength(3);
  });

  test('row 0 雨山ダム: all fields present with correct timestamp', () => {
    const rows = parseAichiPage(SAMPLE_PAGE);
    const r = rows.find(
      (x) => x.damName === '雨山ダム' && x.observedAt.toISOString() === '2026-06-05T07:00:00.000Z',
    );
    expect(r).toBeDefined();
    expect(r?.waterLevelM).toBeCloseTo(269.42);
    expect(r?.storageVolumeM3).toBe(81_100);
    expect(r?.inflowM3s).toBeCloseTo(0.183);
    expect(r?.outflowM3s).toBeCloseTo(0.18);
  });

  test('converts 貯水量 千m³ → m³ (× 1000)', () => {
    const rows = parseAichiPage(SAMPLE_PAGE);
    const r = rows.find(
      (x) => x.damName === '木瀬ダム' && x.observedAt.toISOString() === '2026-06-05T07:00:00.000Z',
    );
    expect(r?.storageVolumeM3).toBe(195_700);
  });

  test('row 1 雨山ダム all ** → skipped entirely', () => {
    const rows = parseAichiPage(SAMPLE_PAGE);
    const ts = '2026-06-05T06:50:00.000Z'; // 15:50 JST
    expect(
      rows.find((x) => x.damName === '雨山ダム' && x.observedAt.toISOString() === ts),
    ).toBeUndefined();
  });

  test('row 1 木瀬ダム has data (partial row is kept)', () => {
    const rows = parseAichiPage(SAMPLE_PAGE);
    const ts = '2026-06-05T06:50:00.000Z';
    const r = rows.find((x) => x.damName === '木瀬ダム' && x.observedAt.toISOString() === ts);
    expect(r).toBeDefined();
    expect(r?.storageVolumeM3).toBe(195_400);
  });

  test('row 2 all -- → both dams skipped', () => {
    const rows = parseAichiPage(SAMPLE_PAGE);
    const ts = '2026-06-05T06:40:00.000Z'; // 15:40 JST
    expect(rows.find((x) => x.observedAt.toISOString() === ts)).toBeUndefined();
  });

  test('returns empty array when no timestamp element found', () => {
    expect(parseAichiPage('<html><body>no data</body></html>')).toHaveLength(0);
  });

  test('returns empty array for empty string', () => {
    expect(parseAichiPage('')).toHaveLength(0);
  });
});
