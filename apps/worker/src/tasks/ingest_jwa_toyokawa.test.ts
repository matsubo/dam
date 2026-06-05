// apps/worker/src/tasks/ingest_jwa_toyokawa.test.ts

import { describe, expect, test } from 'bun:test';
import { parseTokyokawaTimestamp, parseToyokawaHtml } from './ingest_jwa_toyokawa.ts';

describe('parseTokyokawaTimestamp', () => {
  test('parses JST timestamp to UTC (subtract 9h)', () => {
    const d = parseTokyokawaTimestamp('観測時刻：2026年06月05日 09時40分');
    expect(d).not.toBeNull();
    // 09:40 JST = 00:40 UTC same day
    expect(d?.toISOString()).toBe('2026-06-05T00:40:00.000Z');
  });

  test('handles midnight crossover (JST hour < 9 wraps to previous UTC day)', () => {
    const d = parseTokyokawaTimestamp('観測時刻：2026年06月05日 08時00分');
    expect(d).not.toBeNull();
    // 08:00 JST = -1:00 UTC → JS Date normalizes to 23:00 UTC previous day
    expect(d?.toISOString()).toBe('2026-06-04T23:00:00.000Z');
  });

  test('returns null when no timestamp present', () => {
    expect(parseTokyokawaTimestamp('no timestamp here')).toBeNull();
  });
});

describe('parseToyokawaHtml', () => {
  const makeSection = (
    name: string,
    level: string,
    storage: string,
    inflow: string,
    outflow: string,
  ): string =>
    `<div class="dam-block">
      <h3>${name}</h3>
      <table>
        <tr><th>貯水位</th><td>${level} EL.m</td></tr>
        <tr><th>有効貯水量</th><td>${storage} m³</td></tr>
        <tr><th>流入量</th><td>${inflow} m³/s</td></tr>
        <tr><th>放流量</th><td>${outflow} m³/s</td></tr>
      </table>
    </div>`;

  const makeHtml = (sections: string): string =>
    `<html><body><p>観測時刻：2026年06月05日 09時40分</p>${sections}</body></html>`;

  test('extracts water level, storage, inflow, outflow from both dams', () => {
    const html = makeHtml(
      makeSection('宇連ダム', '222.65', '21,418,000', '4.94', '0.00') +
        makeSection('大島ダム', '234.19', '8,231,000', '0.95', '0.00'),
    );
    const { observedAt, rows } = parseToyokawaHtml(html);
    expect(observedAt?.toISOString()).toBe('2026-06-05T00:40:00.000Z');
    expect(rows).toHaveLength(2);

    const uren = rows.find((r) => r.toyoName === '宇連ダム');
    expect(uren?.waterLevelM).toBeCloseTo(222.65);
    expect(uren?.storageVolumeM3).toBe(21418000);
    expect(uren?.inflowM3s).toBeCloseTo(4.94);
    expect(uren?.outflowM3s).toBeCloseTo(0.0);

    const oshima = rows.find((r) => r.toyoName === '大島ダム');
    expect(oshima?.waterLevelM).toBeCloseTo(234.19);
    expect(oshima?.storageVolumeM3).toBe(8231000);
  });

  test('treats "cc" sensor values as null (communication cut)', () => {
    const html = makeHtml(
      makeSection('宇連ダム', 'cc', 'cc', 'cc', 'cc') +
        makeSection('大島ダム', '234.19', '8,231,000', '0.95', '0.00'),
    );
    const { rows } = parseToyokawaHtml(html);
    // 宇連 still included (not skipped) but with all nulls (storage null → skipped at upsert)
    // Actually the parser skips if both waterLevel AND storage are null.
    const uren = rows.find((r) => r.toyoName === '宇連ダム');
    expect(uren).toBeUndefined(); // skipped when both primary metrics are null
    expect(rows).toHaveLength(1);
  });

  test('skips unknown dam names', () => {
    const html = makeHtml(makeSection('謎ダム', '100.00', '5,000,000', '1.00', '0.50'));
    const { rows } = parseToyokawaHtml(html);
    expect(rows).toHaveLength(0);
  });

  test('returns null observedAt when no timestamp in HTML', () => {
    const html = `<div>${makeSection('宇連ダム', '222.65', '21,418,000', '4.94', '0.00')}</div>`;
    const { observedAt } = parseToyokawaHtml(html);
    expect(observedAt).toBeNull();
  });
});
