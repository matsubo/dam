import { describe, expect, test } from 'bun:test';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { parseDamnetDetail } from './detail_parser.ts';

const FIXTURE = join(import.meta.dir, '..', '..', '..', '..', 'tests/fixtures/damnet/detail_yamba.html');

describe('parseDamnetDetail', () => {
  test('extracts metadata from attribute table', async () => {
    const html = await readFile(FIXTURE, 'utf8');
    const out = parseDamnetDetail(html, '1234');
    expect(out).toMatchObject({
      damnetId: '1234',
      name: '八ッ場ダム',
      nameKana: 'やんばだむ',
      prefCode: '10',
      manager: '国土交通省関東地方整備局',
      type: '重力式コンクリート',
      heightM: 116.0,
      totalCapacityM3: 107500000,
      effectiveCapacityM3: 90000000,
      floodCapacityM3: 65000000,
      completedYear: 2020,
      lat: 36.55,
      lng: 138.69,
    });
  });
});
