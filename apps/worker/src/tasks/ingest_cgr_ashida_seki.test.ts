// apps/worker/src/tasks/ingest_cgr_ashida_seki.test.ts
//
// Fixture is a verbatim capture (UTF-8 with BOM) of 福山河川国道事務所
// mobile_ashidagawa/sekisyoryou.php taken 2026-09-27 21:40 JST, 観測日時
// 21:30: 流入量 5.89 / 放流量 5.97 m³/s, 貯水量 4988 千m³, 堰上水位 2.01 m,
// 堰下水位 1.30 m, 堰取水量 1.04 m³/s.

import { describe, expect, test } from 'bun:test';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { parseAshidaSekiHtml } from './ingest_cgr_ashida_seki.ts';

const FIXTURE = join(
  import.meta.dir,
  '..',
  '..',
  '..',
  '..',
  'tests/fixtures/cgr_ashida_seki/sekisyoryou_2026-09-27T2130.html',
);

describe('parseAshidaSekiHtml', () => {
  test('reads the weir pool level, 千m³ volume and flows at the JST 観測日時', async () => {
    const r = parseAshidaSekiHtml(await readFile(FIXTURE, 'utf8'));
    expect(r?.observedAt.toISOString()).toBe('2026-09-27T12:30:00.000Z');
    // 堰上水位 (pool side), not 堰下水位 1.30 m.
    expect(r?.waterLevelM).toBe(2.01);
    expect(r?.inflowM3s).toBe(5.89);
    // 放流量, not 堰取水量 1.04 m³/s.
    expect(r?.outflowM3s).toBe(5.97);
    expect(r?.storageVolumeM3).toBe(4_988_000);
  });

  test('a non-numeric cell reads as missing without touching the others', async () => {
    // Simulated outage marker on 貯水量; the live page shows none today.
    const html = (await readFile(FIXTURE, 'utf8')).replace(
      '<td class="data"　align="right">4988</td>',
      '<td class="data"　align="right">欠測</td>',
    );
    const r = parseAshidaSekiHtml(html);
    expect(r?.storageVolumeM3).toBeNull();
    expect(r?.waterLevelM).toBe(2.01);
  });

  test('returns null for a page without 観測日時', () => {
    expect(parseAshidaSekiHtml('<html><body>メンテナンス中</body></html>')).toBeNull();
  });
});
