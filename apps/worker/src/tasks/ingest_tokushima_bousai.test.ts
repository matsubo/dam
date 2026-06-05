// apps/worker/src/tasks/ingest_tokushima_bousai.test.ts

import { describe, expect, test } from 'bun:test';
import { parseTokushimaTable, parseTokushimaTimestamp } from './ingest_tokushima_bousai.ts';

// Minimal HTML fragment mimicking the Tokushima dam_status.html structure
function makeHtml(
  dams: {
    name: string;
    timestamp: string;
    level: string;
    inflow: string;
    outflow: string;
  }[],
): string {
  const damRows = dams
    .map(({ name, timestamp, level, inflow, outflow }) => {
      const makeCell = (val: string): string => {
        if (val === '***') return `<td class="ui-bar-g">***</td>`;
        if (val === '') return `<td class="ui-bar-g">&nbsp;</td>`;
        return `<td class="ui-bar-g cenval "><img height="13" width="13" src="../img/arrow/arw_r.gif">&nbsp;${val}</td>`;
      };
      return `<td colspan="4" class="ui-bar-f site"><span class="sitename">${name}</span></td>
<tr>
<th class="ui-bar-h">時刻</th><th class="ui-bar-h">貯水位</th><th class="ui-bar-h">流入量</th><th class="ui-bar-h">放流量</th>
</tr>
<tr>
<td class="ui-bar-g">${timestamp}</td>${makeCell(level)}${makeCell(inflow)}${makeCell(outflow)}
</tr>`;
    })
    .join('\n');

  return `<html><body><table>${damRows}</table></body></html>`;
}

describe('parseTokushimaTimestamp', () => {
  test('parses "MM/DD HH:MM" JST → UTC (subtract 9h)', () => {
    const d = parseTokushimaTimestamp('06/05 15:20', 2026);
    expect(d).not.toBeNull();
    // 15:20 JST = 06:20 UTC
    expect(d?.toISOString()).toBe('2026-06-05T06:20:00.000Z');
  });

  test('handles midnight crossover (JST hour < 9 → previous UTC day)', () => {
    const d = parseTokushimaTimestamp('06/05 08:00', 2026);
    expect(d).not.toBeNull();
    // 08:00 JST = 2026-06-04T23:00:00Z
    expect(d?.toISOString()).toBe('2026-06-04T23:00:00.000Z');
  });

  test('returns null for missing timestamp', () => {
    expect(parseTokushimaTimestamp('***', 2026)).toBeNull();
    expect(parseTokushimaTimestamp('', 2026)).toBeNull();
    expect(parseTokushimaTimestamp('bad string', 2026)).toBeNull();
  });

  test('handles &nbsp; separator in real HTML', () => {
    const d = parseTokushimaTimestamp('06/05 15:20', 2026);
    expect(d).not.toBeNull();
    expect(d?.toISOString()).toBe('2026-06-05T06:20:00.000Z');
  });
});

describe('parseTokushimaTable', () => {
  test('parses a single dam with all three values', () => {
    const html = makeHtml([
      {
        name: '長安口ダム',
        timestamp: '06/05 15:20',
        level: '221.99',
        inflow: '148.51',
        outflow: '137.08',
      },
    ]);
    const rows = parseTokushimaTable(html, 2026);
    expect(rows).toHaveLength(1);
    expect(rows[0]?.tokushimaName).toBe('長安口ダム');
    expect(rows[0]?.observedAt.toISOString()).toBe('2026-06-05T06:20:00.000Z');
    expect(rows[0]?.waterLevelM).toBeCloseTo(221.99);
    expect(rows[0]?.inflowM3s).toBeCloseTo(148.51);
    expect(rows[0]?.outflowM3s).toBeCloseTo(137.08);
  });

  test('parses multiple dams', () => {
    const html = makeHtml([
      {
        name: '長安口ダム',
        timestamp: '06/05 15:20',
        level: '221.99',
        inflow: '148.51',
        outflow: '137.08',
      },
      {
        name: '福井ダム',
        timestamp: '06/05 15:20',
        level: '43.46',
        inflow: '2.43',
        outflow: '2.70',
      },
      {
        name: '川口ダム',
        timestamp: '06/05 15:20',
        level: '94.22',
        inflow: '175.90',
        outflow: '175.90',
      },
    ]);
    const rows = parseTokushimaTable(html, 2026);
    expect(rows).toHaveLength(3);
    expect(rows.map((r) => r.tokushimaName)).toEqual(['長安口ダム', '福井ダム', '川口ダム']);
  });

  test('parses *** as null', () => {
    const html = makeHtml([
      {
        name: '宮川内ダム',
        timestamp: '06/05 15:10',
        level: '128.85',
        inflow: '***',
        outflow: '***',
      },
    ]);
    const rows = parseTokushimaTable(html, 2026);
    expect(rows).toHaveLength(1);
    expect(rows[0]?.waterLevelM).toBeCloseTo(128.85);
    expect(rows[0]?.inflowM3s).toBeNull();
    expect(rows[0]?.outflowM3s).toBeNull();
  });

  test('parses blank cell as null', () => {
    const html = makeHtml([
      { name: '棚野ダム', timestamp: '06/05 15:20', level: '', inflow: '', outflow: '33.80' },
    ]);
    const rows = parseTokushimaTable(html, 2026);
    expect(rows).toHaveLength(1);
    expect(rows[0]?.waterLevelM).toBeNull();
    expect(rows[0]?.inflowM3s).toBeNull();
    expect(rows[0]?.outflowM3s).toBeCloseTo(33.8);
  });

  test('dam name with parentheses is preserved', () => {
    const html = makeHtml([
      {
        name: '池田ダム(水)',
        timestamp: '06/05 15:20',
        level: '87.89',
        inflow: '220.59',
        outflow: '220.60',
      },
    ]);
    const rows = parseTokushimaTable(html, 2026);
    expect(rows[0]?.tokushimaName).toBe('池田ダム(水)');
  });

  test('midnight crossover in observedAt', () => {
    const html = makeHtml([
      {
        name: '長安口ダム',
        timestamp: '06/05 06:00',
        level: '221.50',
        inflow: '10.00',
        outflow: '9.00',
      },
    ]);
    const rows = parseTokushimaTable(html, 2026);
    // 06:00 JST = 2026-06-04T21:00:00Z
    expect(rows[0]?.observedAt.toISOString()).toBe('2026-06-04T21:00:00.000Z');
  });

  test('returns empty array when no dam sections found', () => {
    expect(parseTokushimaTable('<html></html>', 2026)).toHaveLength(0);
  });
});
