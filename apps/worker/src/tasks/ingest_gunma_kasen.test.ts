import { describe, expect, test } from 'bun:test';
import { parseGunmaHtml, parseGunmaTimestamp } from './ingest_gunma_kasen.ts';

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

describe('parseGunmaHtml', () => {
  test('parses all fields correctly', () => {
    const row = parseGunmaHtml(SAMPLE_HTML, '坂本ダム');
    expect(row).not.toBeNull();
    expect(row?.gunmaName).toBe('坂本ダム');
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
    const row = parseGunmaHtml(html, 'テストダム');
    expect(row?.waterLevelM).toBeCloseTo(100.0);
    expect(row?.storageVolumeM3).toBe(200 * 1000);
    expect(row?.inflowM3s).toBeCloseTo(5.0);
    expect(row?.outflowM3s).toBeCloseTo(4.5);
  });

  test('storageVolumeM3 multiplied by 1000', () => {
    const row = parseGunmaHtml(SAMPLE_HTML, '坂本ダム');
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
    const row = parseGunmaHtml(html, '坂本ダム');
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
    const row = parseGunmaHtml(html, '坂本ダム');
    expect(row?.waterLevelM).toBeNull();
    expect(row?.storageVolumeM3).toBeNull();
  });

  test('returns null when no timestamp', () => {
    expect(parseGunmaHtml('<TABLE></TABLE>', '坂本ダム')).toBeNull();
  });

  test('returns null when all measurements are null', () => {
    const html = `
      06月05日21時00分現在
      <TABLE>
        <TR><TD>貯水位 (m)</TD><TD>-</TD></TR>
        <TR><TD>流入量 (m3/s)</TD><TD>-</TD></TR>
        <TR><TD>放流量 (m3/s)</TD><TD>-</TD></TR>
      </TABLE>
    `;
    expect(parseGunmaHtml(html, '坂本ダム')).toBeNull();
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
    const row = parseGunmaHtml(html, '坂本ダム');
    expect(row?.storageVolumeM3).toBe(1_506_000);
  });
});
