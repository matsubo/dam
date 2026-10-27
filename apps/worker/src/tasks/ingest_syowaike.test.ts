// apps/worker/src/tasks/ingest_syowaike.test.ts
//
// Fixture is a verbatim capture (Windows-31J) of 昭和池防災情報管理システム
// public/DamData.jsp taken 2026-09-28 08:41 JST, 更新時刻 08:41:17: 貯水位
// 111.08 m, 貯水量 183800 m³, 貯水率 12 %, 流入水位 0.08 m, 流入量 0.06 m³/s,
// 越流量 0.00 m³/s, 時間雨量 0.0 mm.
//
// Fixture → universe entries, no database: binding and writing belong to the
// ingest run (apps/worker/src/ingest/run.test.ts).

import { describe, expect, test } from 'bun:test';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { Observed } from '../ingest/types.ts';
import { syowaikeEntries, syowaikeReading } from './ingest_syowaike.ts';

const FIXTURE = join(
  import.meta.dir,
  '..',
  '..',
  '..',
  '..',
  'tests/fixtures/syowaike/DamData_2026-09-28T0841.html',
);

async function fixture(): Promise<string> {
  return new TextDecoder('shift_jis').decode(await readFile(FIXTURE));
}

function observed(html: string): Observed {
  const r = syowaikeReading(html);
  if (r.state !== 'values' || !r.observations[0]) throw new Error(r.state);
  return r.observations[0];
}

describe('syowaikeEntries', () => {
  test('the one reservoir, pinned to NDI 1539 (兵庫県 昭和池, not 淡路市 1583)', async () => {
    const [e, ...rest] = syowaikeEntries(await fixture());
    expect(rest).toEqual([]);
    expect(e).toMatchObject({ key: '昭和池', name: '昭和池', pref: '28', bind: { ndi: '1539' } });
  });
});

describe('syowaikeReading', () => {
  test('reads level, m³ volume, inflow and hourly rain at the JST 更新時刻', async () => {
    const r = observed(await fixture());
    expect(r.observedAt.toISOString()).toBe('2026-09-27T23:41:00.000Z');
    expect(r.waterLevelM).toBe(111.08);
    // Already m³ (the header says 貯水量(m³)), not 千m³.
    expect(r.storageVolumeM3).toBe(183_800);
    // 流入量, not 流入水位 0.08 m.
    expect(r.inflowM3s).toBe(0.06);
    expect(r.rainfallMm).toBe(0);
  });

  test('a cell painted 無効/欠測 (#ff8080) reads as missing without touching the others', async () => {
    // Simulated outage on 貯水量; the live page shows none today.
    const html = (await fixture()).replace(
      '<td align="right" bgcolor="#ccccff"><b>183800<b>',
      '<td align="right" bgcolor="#ff8080"><b>183800<b>',
    );
    const r = observed(html);
    expect(r.storageVolumeM3).toBeNull();
    expect(r.waterLevelM).toBe(111.08);
    expect(r.inflowM3s).toBe(0.06);
  });

  test('every stored item painted #ff8080 is provider-marked empty', async () => {
    const html = (await fixture()).replaceAll('bgcolor="#ccccff"', 'bgcolor="#ff8080"');
    expect(syowaikeReading(html)).toEqual({
      state: 'empty',
      mark: '無効/欠測 on every stored item',
    });
  });

  test('a blank value cell reads as missing', async () => {
    const html = (await fixture()).replace('<b>111.08<b>', '<b><b>');
    expect(observed(html).waterLevelM).toBeNull();
  });

  test('an offline 0000/00/00 stamp is the system’s own mark; a page without 更新時刻 is unreadable', async () => {
    const offline = (await fixture()).replace('2026/09/28 08:41:17', '0000/00/00 00:00:00');
    expect(syowaikeReading(offline)).toEqual({
      state: 'empty',
      mark: '更新時刻 0000/00/00 (offline)',
    });
    expect(syowaikeReading('<html><body>メンテナンス中</body></html>')).toEqual({
      state: 'unreadable',
      why: 'no 更新時刻',
    });
  });
});
