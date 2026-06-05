// apps/worker/src/tasks/ingest_jwa_yoshino.test.ts

import { describe, expect, test } from 'bun:test';
import { parseYoshinoHtml, parseYoshinoTimestamp } from './ingest_jwa_yoshino.ts';

describe('parseYoshinoTimestamp', () => {
  test('parses JST timestamp to UTC (subtract 9h)', () => {
    const d = parseYoshinoTimestamp('観測日時：2026年06月05日 10時00分');
    expect(d).not.toBeNull();
    // 10:00 JST = 01:00 UTC same day
    expect(d?.toISOString()).toBe('2026-06-05T01:00:00.000Z');
  });

  test('handles midnight crossover (JST hour < 9 wraps to previous UTC day)', () => {
    const d = parseYoshinoTimestamp('観測日時：2026年06月05日 08時00分');
    expect(d).not.toBeNull();
    // 08:00 JST = -1:00 UTC → 23:00 UTC previous day
    expect(d?.toISOString()).toBe('2026-06-04T23:00:00.000Z');
  });

  test('returns null when no timestamp present', () => {
    expect(parseYoshinoTimestamp('no timestamp here')).toBeNull();
  });
});

describe('parseYoshinoHtml', () => {
  const makeDamSection = (name: string, level: string, inflow: string, outflow: string): string =>
    `<div class="str-data2" id="str-x">${name}</div>
    <div class="list-data">
      <table>
        <tr><th>貯水位(<span class='unit'>EL.m</span>)</th><td>${level}</td></tr>
        <tr><th>流入量(<span class='unit'>m³/s</span>)</th><td>${inflow}</td></tr>
        <tr><th>全放流量(<span class='unit'>m³/s</span>)</th><td>${outflow}</td></tr>
      </table>
    </div>`;

  const makeSameuraHeader = (rate: string): string =>
    `<table>
      <tr><th>本日０時の早明浦ダム利水貯水率(<span class='unit'>％</span>)</th><td>100.0</td></tr>
      <tr><th>本日０時の早明浦ダム利水貯水量(<span class='unit'>千m³</span>)</th><td>147000</td></tr>
      <tr><th>早明浦ダム利水貯水率[速報値](<span class='unit'>％</span>)</th><td>${rate}</td></tr>
    </table>`;

  const makeHtml = (body: string): string =>
    `<html><body>
      <div>観測日時：<span id="data-time">2026年06月05日 10時00分</span></div>
      ${body}
    </body></html>`;

  test('extracts water level, inflow, outflow for all 5 dams', () => {
    const html = makeHtml(
      makeDamSection('池田ダム', '87.88', '243.35', '247.88') +
        makeSameuraHeader('100.0') +
        makeDamSection('早明浦ダム', '328.66', '114.62', '59.00') +
        makeDamSection('新宮ダム', '233.71', '26.28', '21.20') +
        makeDamSection('富郷ダム', '444.70', '19.42', '14.01') +
        makeDamSection('柳瀬ダム', '289.35', '25.03', '30.57'),
    );
    const { observedAt, rows } = parseYoshinoHtml(html);
    expect(observedAt?.toISOString()).toBe('2026-06-05T01:00:00.000Z');
    expect(rows).toHaveLength(5);

    const ikeda = rows.find((r) => r.yoshinoName === '池田ダム');
    expect(ikeda?.waterLevelM).toBeCloseTo(87.88);
    expect(ikeda?.inflowM3s).toBeCloseTo(243.35);
    expect(ikeda?.outflowM3s).toBeCloseTo(247.88);
    expect(ikeda?.storageRatePct).toBeNull();

    const sameura = rows.find((r) => r.yoshinoName === '早明浦ダム');
    expect(sameura?.waterLevelM).toBeCloseTo(328.66);
    expect(sameura?.storageRatePct).toBeCloseTo(100.0);
    expect(sameura?.inflowM3s).toBeCloseTo(114.62);
    expect(sameura?.outflowM3s).toBeCloseTo(59.0);
  });

  test('treats "CC" sensor values as null and skips dam when water level is CC', () => {
    const html = makeHtml(
      makeSameuraHeader('100.0') +
        makeDamSection('早明浦ダム', 'CC', 'CC', 'CC') +
        makeDamSection('富郷ダム', '444.70', '19.42', '14.01'),
    );
    const { rows } = parseYoshinoHtml(html);
    // 早明浦 skipped (water level null); 富郷 remains
    const sameura = rows.find((r) => r.yoshinoName === '早明浦ダム');
    expect(sameura).toBeUndefined();
    expect(rows).toHaveLength(1);
    expect(rows[0]?.yoshinoName).toBe('富郷ダム');
  });

  test('skips unknown dam names', () => {
    const html = makeHtml(makeDamSection('謎ダム', '100.00', '5.00', '3.00'));
    const { rows } = parseYoshinoHtml(html);
    expect(rows).toHaveLength(0);
  });

  test('returns null observedAt when no timestamp in HTML', () => {
    const html = `<div>${makeDamSection('富郷ダム', '444.70', '19.42', '14.01')}</div>`;
    const { observedAt, rows } = parseYoshinoHtml(html);
    expect(observedAt).toBeNull();
    expect(rows).toHaveLength(1); // still parses dam data
  });
});
