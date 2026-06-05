import { describe, expect, test } from 'bun:test';
import { parseYamaguchiHtml, parseYamaguchiTimestamp } from './ingest_yamaguchi_bousai.ts';

describe('parseYamaguchiTimestamp', () => {
  test('parses "YYYY/MM/DD HH:MM" (JST) → UTC', () => {
    const d = parseYamaguchiTimestamp('2026/06/05 21:00');
    expect(d?.toISOString()).toBe('2026-06-05T12:00:00.000Z');
  });

  test('midnight crossover: JST 00:00 → previous UTC day', () => {
    const d = parseYamaguchiTimestamp('2026/06/05 00:00');
    expect(d?.toISOString()).toBe('2026-06-04T15:00:00.000Z');
  });

  test('returns null for malformed strings', () => {
    expect(parseYamaguchiTimestamp('')).toBeNull();
    expect(parseYamaguchiTimestamp('2026-06-05 21:00')).toBeNull();
    expect(parseYamaguchiTimestamp('bad')).toBeNull();
  });
});

// Sample HTML with two hourly rows — second is more recent
const SAMPLE_HTML = `
<table>
<tr class="hour_20 ">
  <td class="plus-hour">2026/06/05<br />20:00</td>
  <td>213.40</td>
  <td>64.0</td>
  <td>4.50</td>
  <td>5.00</td>
  <td>0.50</td>
</tr>
<tr class="dotted minute_20 ">
  <td class="inner-date">2026/06/05<br />20:10</td>
  <td>213.39</td>
  <td>63.9</td>
  <td>3.80</td>
  <td>4.90</td>
  <td>1.10</td>
</tr>
<tr class="hour_21 ">
  <td class="plus-hour">2026/06/05<br />21:00</td>
  <td>213.33</td>
  <td>63.7</td>
  <td>3.89</td>
  <td>4.83</td>
  <td>0.94</td>
</tr>
</table>
`;

describe('parseYamaguchiHtml', () => {
  test('returns the most recent hourly row (last hour_XX)', () => {
    const row = parseYamaguchiHtml(SAMPLE_HTML, '小瀬川ダム');
    expect(row).toBeDefined();
    expect(row?.yamaguchiName).toBe('小瀬川ダム');
    expect(row?.observedAt.toISOString()).toBe('2026-06-05T12:00:00.000Z');
    expect(row?.waterLevelM).toBeCloseTo(213.33);
    expect(row?.storageRate).toBeCloseTo(63.7);
    expect(row?.inflowM3s).toBeCloseTo(3.89);
    expect(row?.outflowM3s).toBeCloseTo(4.83);
  });

  test('minute rows are not chosen as the latest', () => {
    const row = parseYamaguchiHtml(SAMPLE_HTML, '小瀬川ダム');
    // Latest hour row is hour_21 at 21:00, not the minute_20 at 20:10
    expect(row?.observedAt.toISOString()).toBe('2026-06-05T12:00:00.000Z');
  });

  test('handles <br> without slash', () => {
    const html = `
      <tr class="hour_21 ">
        <td>2026/06/05<br>21:30</td>
        <td>210.00</td><td>55.0</td><td>2.0</td><td>3.0</td><td>1.0</td>
      </tr>
    `;
    const row = parseYamaguchiHtml(html, 'テストダム');
    expect(row?.observedAt.toISOString()).toBe('2026-06-05T12:30:00.000Z');
  });

  test('returns null for missing values when all measurements null', () => {
    const html = `
      <tr class="hour_21 ">
        <td>2026/06/05<br />21:00</td>
        <td>-</td><td>-</td><td>-</td><td>-</td><td>-</td>
      </tr>
    `;
    expect(parseYamaguchiHtml(html, 'テストダム')).toBeNull();
  });

  test('returns null for empty HTML', () => {
    expect(parseYamaguchiHtml('', 'テストダム')).toBeNull();
    expect(parseYamaguchiHtml('<table></table>', 'テストダム')).toBeNull();
  });

  test('"-" values parse as null', () => {
    const html = `
      <tr class="hour_21 ">
        <td>2026/06/05<br />21:00</td>
        <td>213.33</td><td>-</td><td>-</td><td>4.83</td><td>-</td>
      </tr>
    `;
    const row = parseYamaguchiHtml(html, 'テストダム');
    expect(row?.waterLevelM).toBeCloseTo(213.33);
    expect(row?.storageRate).toBeNull();
    expect(row?.inflowM3s).toBeNull();
    expect(row?.outflowM3s).toBeCloseTo(4.83);
  });
});
