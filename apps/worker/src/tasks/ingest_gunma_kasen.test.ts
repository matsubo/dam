// apps/worker/src/tasks/ingest_gunma_kasen.test.ts
//
// Page → universe entries, no database: binding and writing belong to the
// ingest run (apps/worker/src/ingest/run.test.ts).

import { describe, expect, test } from 'bun:test';
import type { Observed, Reading } from '../ingest/types.ts';
import { fixtureUpstream } from '../ingest/upstream.ts';
import { gunmaEntries, gunmaReading, pageUrl, parseGunmaTimestamp } from './ingest_gunma_kasen.ts';

const NOW = new Date('2026-06-05T12:00:00Z');

function observed(r: Reading): Observed | undefined {
  if (r.state !== 'values') throw new Error(r.state);
  return r.observations[0];
}

describe('parseGunmaTimestamp', () => {
  const now = new Date('2026-06-05T12:00:00Z');

  test('parses "MM月DD日HH時mm分現在" (JST) → UTC', () => {
    const d = parseGunmaTimestamp('06月05日21時00分現在', now);
    expect(d?.toISOString()).toBe('2026-06-05T12:00:00.000Z');
  });

  test('single-digit month', () => {
    const d = parseGunmaTimestamp('6月5日21時00分現在', now);
    expect(d?.toISOString()).toBe('2026-06-05T12:00:00.000Z');
  });

  test('midnight JST crosses to previous UTC day', () => {
    const d = parseGunmaTimestamp('06月05日00時00分現在', now);
    expect(d?.toISOString()).toBe('2026-06-04T15:00:00.000Z');
  });

  test('future date uses previous year', () => {
    // If parsed date is more than 24 hours in the future, use previous year
    const past = new Date('2026-01-01T00:00:00Z');
    const d = parseGunmaTimestamp('12月31日21時00分現在', past);
    expect(d?.getFullYear()).toBe(2025);
  });

  test('returns null for malformed strings', () => {
    expect(parseGunmaTimestamp('')).toBeNull();
    expect(parseGunmaTimestamp('bad')).toBeNull();
    expect(parseGunmaTimestamp('2026-06-05')).toBeNull();
  });
});

// Sample HTML mimicking the structure of the Gunma river system pages
const SAMPLE_HTML = `
<HTML>
<BODY>
<DIV align="center">坂本ダム</DIV>
06月05日21時00分現在
<TABLE>
<TR>
  <TD>貯水位 (m)</TD>
  <TD>520.60→</TD>
</TR>
<TR>
  <TD>貯水量 (千m3)</TD>
  <TD>506</TD>
</TR>
<TR>
  <TD>流入量 (m3/s)</TD>
  <TD>1.39→</TD>
</TR>
<TR>
  <TD>放流量 (m3/s)</TD>
  <TD>1.39↓</TD>
</TR>
</TABLE>
</BODY>
</HTML>
`;

describe('gunmaReading', () => {
  test('parses all fields correctly', () => {
    const row = observed(gunmaReading(SAMPLE_HTML, NOW));
    expect(row?.observedAt.toISOString()).toBe('2026-06-05T12:00:00.000Z');
    expect(row?.waterLevelM).toBeCloseTo(520.6);
    expect(row?.storageVolumeM3).toBe(506 * 1000);
    expect(row?.inflowM3s).toBeCloseTo(1.39);
    expect(row?.outflowM3s).toBeCloseTo(1.39);
  });

  test('strips arrow indicators (→ ↑ ↓) from values', () => {
    const html = `
      06月05日21時00分現在
      <TABLE>
        <TR><TD>貯水位 (m)</TD><TD>100.00↑</TD></TR>
        <TR><TD>貯水量 (千m3)</TD><TD>200↓</TD></TR>
        <TR><TD>流入量 (m3/s)</TD><TD>5.00→</TD></TR>
        <TR><TD>放流量 (m3/s)</TD><TD>4.50←</TD></TR>
      </TABLE>
    `;
    const row = observed(gunmaReading(html, NOW));
    expect(row?.waterLevelM).toBeCloseTo(100.0);
    expect(row?.storageVolumeM3).toBe(200 * 1000);
    expect(row?.inflowM3s).toBeCloseTo(5.0);
    expect(row?.outflowM3s).toBeCloseTo(4.5);
  });

  test('storageVolumeM3 multiplied by 1000', () => {
    const row = observed(gunmaReading(SAMPLE_HTML, NOW));
    expect(row?.storageVolumeM3).toBe(506_000);
  });

  test('"-" values parse as null', () => {
    const html = `
      06月05日21時00分現在
      <TABLE>
        <TR><TD>貯水位 (m)</TD><TD>520.60</TD></TR>
        <TR><TD>貯水量 (千m3)</TD><TD>-</TD></TR>
        <TR><TD>流入量 (m3/s)</TD><TD>-</TD></TR>
        <TR><TD>放流量 (m3/s)</TD><TD>1.39</TD></TR>
      </TABLE>
    `;
    const row = observed(gunmaReading(html, NOW));
    expect(row?.waterLevelM).toBeCloseTo(520.6);
    expect(row?.storageVolumeM3).toBeNull();
    expect(row?.inflowM3s).toBeNull();
    expect(row?.outflowM3s).toBeCloseTo(1.39);
  });

  test('"***" / "****" values parse as null', () => {
    const html = `
      06月05日21時00分現在
      <TABLE>
        <TR><TD>貯水位 (m)</TD><TD>****</TD></TR>
        <TR><TD>貯水量 (千m3)</TD><TD>***</TD></TR>
        <TR><TD>流入量 (m3/s)</TD><TD>1.00</TD></TR>
        <TR><TD>放流量 (m3/s)</TD><TD>1.00</TD></TR>
      </TABLE>
    `;
    const row = observed(gunmaReading(html, NOW));
    expect(row?.waterLevelM).toBeNull();
    expect(row?.storageVolumeM3).toBeNull();
  });

  test('a value without its timestamp is unreadable', () => {
    expect(gunmaReading('<TABLE></TABLE>', NOW).state).toBe('unreadable');
    const html = SAMPLE_HTML.replace('06月05日21時00分現在', '');
    expect(gunmaReading(html, NOW).state).toBe('unreadable');
  });

  test('"-" in every value is provider-marked empty', () => {
    const html = `
      06月05日21時00分現在
      <TABLE>
        <TR><TD>貯水位 (m)</TD><TD>-</TD></TR>
        <TR><TD>流入量 (m3/s)</TD><TD>-</TD></TR>
        <TR><TD>放流量 (m3/s)</TD><TD>-</TD></TR>
      </TABLE>
    `;
    expect(gunmaReading(html, NOW).state).toBe('empty');
  });

  test('commas in numbers are stripped', () => {
    const html = `
      06月05日21時00分現在
      <TABLE>
        <TR><TD>貯水位 (m)</TD><TD>520.60</TD></TR>
        <TR><TD>貯水量 (千m3)</TD><TD>1,506</TD></TR>
        <TR><TD>流入量 (m3/s)</TD><TD>1.39</TD></TR>
        <TR><TD>放流量 (m3/s)</TD><TD>1.39</TD></TR>
      </TABLE>
    `;
    const row = observed(gunmaReading(html, NOW));
    expect(row?.storageVolumeM3).toBe(1_506_000);
  });
});

describe('gunmaEntries', () => {
  test('the 7-station catalogue keyed by name; a failed page throws for the run', async () => {
    const page = { body: SAMPLE_HTML, charset: 'shift_jis' } as const;
    const entries = gunmaEntries(
      fixtureUpstream((url) => (url === pageUrl(1) ? page : { status: 500 })),
    );
    expect(entries.map((e) => e.key)).toEqual([
      '坂本ダム',
      '霧積ダム',
      '塩沢ダム',
      '四万川ダム',
      '道平川ダム',
      '大仁田ダム',
      '桐生川ダム',
    ]);
    expect(entries[0]?.pref).toBe('10');
    const read = (i: number) => {
      const r = entries[i]?.reading;
      if (typeof r !== 'function') throw new Error('expected a page reading');
      return r(null);
    };
    expect((await read(0)).state).toBe('values');
    await expect(read(1)).rejects.toThrow(`HTTP 500 for ${pageUrl(2)}`);
  });
});
