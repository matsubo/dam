import { describe, expect, test } from 'bun:test';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { parseW01 } from './parse_w01.ts';

const FIXTURE = join(
  import.meta.dir,
  '..',
  '..',
  '..',
  '..',
  'tests/fixtures/ndi/w01_sample.geojson',
);

describe('parseW01', () => {
  test('extracts dam metadata and coordinates', async () => {
    const raw = await readFile(FIXTURE, 'utf8');
    const out = parseW01(raw);
    expect(out.length).toBe(2);
    expect(out[0]).toMatchObject({
      ndiId: '1234567890',
      name: '八ッ場ダム',
      prefCode: '10',
      manager: '国土交通省関東地方整備局',
      type: '重力式コンクリート',
      heightM: 116.0,
      totalCapacityM3: 107500000,
      effectiveCapacityM3: 90000000,
      floodCapacityM3: 65000000,
      completedYear: 2020,
      watershedCode: '01',
      lat: 36.55,
      lng: 138.69,
    });
  });

  test('handles missing optional fields', () => {
    const raw = JSON.stringify({
      type: 'FeatureCollection',
      features: [
        {
          type: 'Feature',
          properties: { W01_001: 'x', W01_002: 'X', W01_003: '01' },
          geometry: { type: 'Point', coordinates: [140, 36] },
        },
      ],
    });
    const out = parseW01(raw);
    expect(out[0]?.heightM).toBeNull();
  });

  test('skips features without coordinates', () => {
    const raw = JSON.stringify({
      type: 'FeatureCollection',
      features: [
        {
          type: 'Feature',
          properties: { W01_001: 'x', W01_002: 'X', W01_003: '01' },
          geometry: { type: 'Point', coordinates: [] },
        },
      ],
    });
    expect(parseW01(raw).length).toBe(0);
  });
});
