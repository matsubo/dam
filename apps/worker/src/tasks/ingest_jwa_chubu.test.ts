// apps/worker/src/tasks/ingest_jwa_chubu.test.ts

import { describe, expect, test } from 'bun:test';
import { parseChubuDate, parseChubuHtml } from './ingest_jwa_chubu.ts';

describe('parseChubuDate', () => {
  test('parses YYYY年MM月DD日 to JST midnight (= UTC day-1 15:00)', () => {
    const d = parseChubuDate('中部管内水源状況 2026年06月04日（木）');
    expect(d).not.toBeNull();
    expect(d?.toISOString()).toBe('2026-06-03T15:00:00.000Z');
  });

  test('parses single-digit month and day', () => {
    const d = parseChubuDate('2026年1月5日');
    expect(d?.toISOString()).toBe('2026-01-04T15:00:00.000Z');
  });

  test('returns null when no date present', () => {
    expect(parseChubuDate('no date here')).toBeNull();
  });
});

describe('parseChubuHtml', () => {
  const makeDamSection = (
    name: string,
    vol: string,
    rate: string,
    inflow: string,
    outflow: string,
    level?: string,
  ): string =>
    `<div class="dam-block">
      <h3>${name}</h3>
      <table>
        ${level !== undefined ? `<tr><th>貯水位</th><td>${level} EL.m</td></tr>` : ''}
        <tr><th>貯水量</th><td>${vol}千m³</td></tr>
        <tr><th>貯水率</th><td>${rate}%</td></tr>
        <tr><th>流入量</th><td>${inflow}m³/s</td></tr>
        <tr><th>放流量</th><td>${outflow}m³/s</td></tr>
      </table>
    </div>`;

  const makeHtml = (sections: string): string =>
    `<html><body><p>2026年06月04日（木）</p>${sections}</body></html>`;

  test('extracts storage, rate, inflow, outflow from labeled blocks', () => {
    const html = makeHtml(
      makeDamSection('牧尾ダム', '55,660', '81.9', '22.59', '1.48') +
        makeDamSection('中里ダム', '6,565', '41.0', '3.52', '0.76'),
    );
    const { reportDate, rows } = parseChubuHtml(html);
    expect(reportDate?.toISOString()).toBe('2026-06-03T15:00:00.000Z');
    expect(rows).toHaveLength(2);

    const makio = rows.find((r) => r.chubuName === '牧尾ダム');
    expect(makio?.storageVolumeThouM3).toBe(55660);
    expect(makio?.storageRatePct).toBeCloseTo(81.9);
    expect(makio?.inflowM3s).toBeCloseTo(22.59);
    expect(makio?.outflowM3s).toBeCloseTo(1.48);
    expect(makio?.waterLevelM).toBeNull(); // no level in this section

    const nakazato = rows.find((r) => r.chubuName === '中里ダム');
    expect(nakazato?.storageVolumeThouM3).toBe(6565);
    expect(nakazato?.storageRatePct).toBeCloseTo(41.0);
  });

  test('extracts water level (EL.m) when present in section', () => {
    const html = makeHtml(makeDamSection('牧尾ダム', '55,660', '81.9', '22.59', '1.48', '875.61'));
    const { rows } = parseChubuHtml(html);
    const makio = rows.find((r) => r.chubuName === '牧尾ダム');
    expect(makio?.waterLevelM).toBeCloseTo(875.61);
  });

  test('skips unknown dam names', () => {
    const html = makeHtml(makeDamSection('未知ダム', '10,000', '50.0', '5.00', '5.00'));
    const { rows } = parseChubuHtml(html);
    expect(rows).toHaveLength(0);
  });

  test('handles missing inflow/outflow gracefully (null)', () => {
    const html = makeHtml(`<div>
      <h3>牧尾ダム</h3>
      <p>貯水量 55,660千m³</p>
      <p>貯水率 81.9%</p>
    </div>`);
    const { rows } = parseChubuHtml(html);
    expect(rows).toHaveLength(1);
    expect(rows[0]?.inflowM3s).toBeNull();
    expect(rows[0]?.outflowM3s).toBeNull();
  });

  test('skips dam if volume and rate cannot be parsed', () => {
    const html = makeHtml(`<div>
      <h3>牧尾ダム</h3>
      <p>データなし</p>
    </div>`);
    const { rows } = parseChubuHtml(html);
    expect(rows).toHaveLength(0);
  });

  test('returns reportDate null when no date in HTML', () => {
    const html = `<div>${makeDamSection('牧尾ダム', '55,660', '81.9', '22.59', '1.48')}</div>`;
    const { reportDate } = parseChubuHtml(html);
    expect(reportDate).toBeNull();
  });
});
