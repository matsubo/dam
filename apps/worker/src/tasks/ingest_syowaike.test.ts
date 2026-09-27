// apps/worker/src/tasks/ingest_syowaike.test.ts
//
// Fixture is a verbatim capture (Windows-31J) of 昭和池防災情報管理システム
// public/DamData.jsp taken 2026-09-28 08:41 JST, 更新時刻 08:41:17: 貯水位
// 111.08 m, 貯水量 183800 m³, 貯水率 12 %, 流入水位 0.08 m, 流入量 0.06 m³/s,
// 越流量 0.00 m³/s, 時間雨量 0.0 mm.

import { describe, expect, test } from 'bun:test';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { parseSyowaikeHtml } from './ingest_syowaike.ts';

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

describe('parseSyowaikeHtml', () => {
  test('reads level, m³ volume, inflow and hourly rain at the JST 更新時刻', async () => {
    const r = parseSyowaikeHtml(await fixture());
    expect(r?.observedAt.toISOString()).toBe('2026-09-27T23:41:00.000Z');
    expect(r?.waterLevelM).toBe(111.08);
    // Already m³ (the header says 貯水量(m³)), not 千m³.
    expect(r?.storageVolumeM3).toBe(183_800);
    // 流入量, not 流入水位 0.08 m.
    expect(r?.inflowM3s).toBe(0.06);
    expect(r?.rainfallMm).toBe(0);
  });

  test('a cell painted 無効/欠測 (#ff8080) reads as missing without touching the others', async () => {
    // Simulated outage on 貯水量; the live page shows none today.
    const html = (await fixture()).replace(
      '<td align="right" bgcolor="#ccccff"><b>183800<b>',
      '<td align="right" bgcolor="#ff8080"><b>183800<b>',
    );
    const r = parseSyowaikeHtml(html);
    expect(r?.storageVolumeM3).toBeNull();
    expect(r?.waterLevelM).toBe(111.08);
    expect(r?.inflowM3s).toBe(0.06);
  });

  test('a blank value cell reads as missing', async () => {
    const html = (await fixture()).replace('<b>111.08<b>', '<b><b>');
    expect(parseSyowaikeHtml(html)?.waterLevelM).toBeNull();
  });

  test('returns null for an offline 0000/00/00 stamp or a page without 更新時刻', async () => {
    const offline = (await fixture()).replace('2026/09/28 08:41:17', '0000/00/00 00:00:00');
    expect(parseSyowaikeHtml(offline)).toBeNull();
    expect(parseSyowaikeHtml('<html><body>メンテナンス中</body></html>')).toBeNull();
  });
});
