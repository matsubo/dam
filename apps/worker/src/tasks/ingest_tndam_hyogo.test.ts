// apps/worker/src/tasks/ingest_tndam_hyogo.test.ts
//
// Page → universe entries, no database: binding and writing belong to the
// ingest run (apps/worker/src/ingest/run.test.ts).

import { describe, expect, test } from 'bun:test';
import type { Observed } from '../ingest/types.ts';
import { fixtureUpstream } from '../ingest/upstream.ts';
import {
  extractDataMap,
  pageUrl,
  parseTndamTimestamp,
  tndamEntries,
  tndamReading,
} from './ingest_tndam_hyogo.ts';

// Sample page HTML matching the real tndam.pref.hyogo.lg.jp format.
function makeHtml(
  values: {
    waterLevel?: string;
    storageVol?: string;
    storageRate?: string;
    inflow?: string;
    overflow?: string;
    outflow?: string;
    rainfall?: string;
  },
  timestamp = '更新時刻：2026/06/22 20:00:55',
): string {
  const row = (label: string, value: string) =>
    `<tr>
      <td align="left" bgcolor="#aaffaa"><b>${label}</b></td>
      <td align="right" bgcolor="#aaffaa"><b>${value}<b>　</td>
    </tr>`;

  return `<html><body>
    <table>
      <tr><td bgcolor="#6666ff"><font><b>鍔市ダム　テレメータデータ</b></font></td></tr>
    </table>
    <table>
      ${row('貯水位(m)', values.waterLevel ?? '287.65')}
      ${row('貯水量(m<SUP>3</SUP>)', values.storageVol ?? '521250')}
      ${row('貯水率(%)', values.storageRate ?? '48.7')}
      ${row('流入量(m<SUP>3</SUP>/s)', values.inflow ?? '0.034')}
      ${row('越流量(m<SUP>3</SUP>/s)', values.overflow ?? '0.0000')}
      ${row('放流量(m<SUP>3</SUP>/s)', values.outflow ?? '0.0333')}
      ${row('時間雨量(mm)', values.rainfall ?? '0.0')}
    </table>
    <td colspan="2" bgcolor="#cccccc" align="center"><font color="#3333ff">${timestamp}</font></td>
  </body></html>`;
}

const OFFLINE_HTML = makeHtml(
  { waterLevel: '', storageVol: '', storageRate: '', inflow: '', outflow: '', rainfall: '' },
  '更新時刻：0000/00/00 00:00:00',
);

describe('parseTndamTimestamp', () => {
  test('parses JST timestamp → UTC', () => {
    const html = makeHtml({});
    // 20:00 JST = 11:00 UTC
    expect((parseTndamTimestamp(html) as Date).toISOString()).toBe('2026-06-22T11:00:00.000Z');
  });

  test('returns offline for "0000/00/00 00:00:00"', () => {
    expect(parseTndamTimestamp(OFFLINE_HTML)).toBe('offline');
  });

  test('handles midnight JST (00:00 → previous day 15:00 UTC)', () => {
    const html = makeHtml({}, '更新時刻：2026/06/22 00:00:55');
    // 00:00 JST = -9h UTC = June 21 15:00 UTC
    expect((parseTndamTimestamp(html) as Date).toISOString()).toBe('2026-06-21T15:00:00.000Z');
  });

  test('returns null when no timestamp pattern found', () => {
    expect(parseTndamTimestamp('<html>no timestamp</html>')).toBeNull();
  });
});

describe('extractDataMap', () => {
  test('extracts label-value pairs from aaffaa cells', () => {
    const html = makeHtml({ waterLevel: '287.65', storageVol: '521250' });
    const map = extractDataMap(html);
    expect(map.get('貯水位(m)')).toBe('287.65');
    expect(map.get('貯水量(m3)')).toBe('521250');
  });

  test('strips HTML tags from labels (SUP → plain text)', () => {
    const html = makeHtml({});
    const map = extractDataMap(html);
    // m<SUP>3</SUP> → m3
    expect(map.has('貯水量(m3)')).toBe(true);
    expect(map.has('流入量(m3/s)')).toBe(true);
    expect(map.has('放流量(m3/s)')).toBe(true);
  });

  test('returns empty map for HTML with no aaffaa cells', () => {
    const map = extractDataMap('<html><body>nothing</body></html>');
    expect(map.size).toBe(0);
  });
});

function observed(html: string): Observed {
  const r = tndamReading(html);
  if (r.state !== 'values' || !r.observations[0]) throw new Error(r.state);
  return r.observations[0];
}

describe('tndamReading', () => {
  test('an offline dam (0000/00/00 timestamp) is provider-marked empty', () => {
    expect(tndamReading(OFFLINE_HTML)).toEqual({
      state: 'empty',
      mark: '更新時刻 0000/00/00 (offline)',
    });
  });

  test('parses waterLevelM correctly', () => {
    expect(observed(makeHtml({ waterLevel: '287.65' })).waterLevelM).toBeCloseTo(287.65);
  });

  test('storageVolumeM3 is direct m³ (no ×1000 conversion)', () => {
    // 521250 is already m³
    expect(observed(makeHtml({ storageVol: '521250' })).storageVolumeM3).toBe(521250);
  });

  test('storageRate: % ÷ 100 → fraction', () => {
    expect(observed(makeHtml({ storageRate: '48.7' })).storageRate).toBeCloseTo(0.487);
  });

  test('storageRate: 100% → 1.0', () => {
    expect(observed(makeHtml({ storageRate: '100.0' })).storageRate).toBeCloseTo(1.0);
  });

  test('inflowM3s and outflowM3s parse correctly', () => {
    const r = observed(makeHtml({ inflow: '0.034', outflow: '0.0333' }));
    expect(r.inflowM3s).toBeCloseTo(0.034);
    expect(r.outflowM3s).toBeCloseTo(0.0333);
  });

  test('越流量 (spillway) is ignored — does not appear in reading', () => {
    // The reading has no spillway field; overflow should not affect other fields
    expect(observed(makeHtml({ overflow: '99.9' })).outflowM3s).toBeCloseTo(0.0333); // still 放流量
  });

  test('rainfallMm parses correctly', () => {
    expect(observed(makeHtml({ rainfall: '12.5' })).rainfallMm).toBeCloseTo(12.5);
  });

  test('observedAt converts JST to UTC', () => {
    const r = observed(makeHtml({}, '更新時刻：2026/06/22 20:00:55'));
    expect(r.observedAt.toISOString()).toBe('2026-06-22T11:00:00.000Z');
  });

  test('"-" in every item is provider-marked empty', () => {
    const html = makeHtml({
      waterLevel: '-',
      storageVol: '-',
      storageRate: '-',
      inflow: '-',
      outflow: '-',
      rainfall: '-',
    });
    expect(tndamReading(html)).toEqual({ state: 'empty', mark: '- in every item' });
  });

  test('unreadable when every data field is blank', () => {
    const html = makeHtml({
      waterLevel: '',
      storageVol: '',
      storageRate: '',
      inflow: '',
      outflow: '',
      rainfall: '',
    });
    expect(tndamReading(html)).toEqual({ state: 'unreadable', why: 'no readable value' });
  });

  test('unreadable when values carry no 更新時刻', () => {
    expect(tndamReading(makeHtml({}, ''))).toEqual({ state: 'unreadable', why: 'no 更新時刻' });
  });
});

describe('tndamEntries', () => {
  test('the six pages, keyed by PSNO, each read from its own page', async () => {
    const asked: string[] = [];
    const entries = tndamEntries(
      fixtureUpstream((url) => {
        asked.push(url);
        return {
          body: url === pageUrl(2) ? OFFLINE_HTML : makeHtml({}),
          charset: 'shift_jis',
        };
      }),
    );
    expect(entries.map((e) => [e.key, e.name, e.pref])).toEqual([
      ['1', '鍔市ダム', '28'],
      ['2', '八幡谷ダム', '28'],
      ['3', '藤岡ダム', '28'],
      ['4', '佐仲ダム', '28'],
      ['5', '黒石ダム', '28'],
      ['6', '大杉ダム', '28'],
    ]);
    const [, yawata] = entries;
    if (typeof yawata?.reading !== 'function') throw new Error('expected a page reading');
    expect((await yawata.reading(null)).state).toBe('empty');
    expect(asked).toEqual([pageUrl(2)]);
  });
});
