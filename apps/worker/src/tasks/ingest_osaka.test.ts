import { describe, expect, it } from 'bun:test';
import fixture from '../../../../tests/fixtures/osaka/choryuryo_2026-06-05.json';
import { chooseMaster, normalizeName, parseOsakaItems, parseOsakaTimestamp } from './ingest_osaka';

describe('parseOsakaTimestamp', () => {
  it('converts JST YYYYMMDDHHMM to UTC', () => {
    const d = parseOsakaTimestamp('202606050833');
    expect(d?.toISOString()).toBe('2026-06-04T23:33:00.000Z');
  });

  it('handles midnight rollover', () => {
    const d = parseOsakaTimestamp('202601010000');
    expect(d?.toISOString()).toBe('2025-12-31T15:00:00.000Z');
  });

  it('returns null for garbage', () => {
    expect(parseOsakaTimestamp('bad')).toBeNull();
  });
});

describe('normalizeName', () => {
  it('strips ダム suffix', () => {
    expect(normalizeName('安威川ダム')).toBe('安威川');
    expect(normalizeName('箕面川ダム')).toBe('箕面川');
    expect(normalizeName('狭山池ダム')).toBe('狭山池');
  });

  it('strips annotations', () => {
    expect(normalizeName('狭山池（再）')).toBe('狭山池');
    expect(normalizeName('狭山池（元）')).toBe('狭山池');
  });
});

describe('parseOsakaItems', () => {
  it('filters to typeId=3 dams only', () => {
    const rows = parseOsakaItems(fixture as Parameters<typeof parseOsakaItems>[0]);
    expect(rows.length).toBe(3);
    expect(rows.every((r) => r.facilityNm.includes('ダム'))).toBe(true);
  });

  it('parses storageData as m³', () => {
    const rows = parseOsakaItems(fixture as Parameters<typeof parseOsakaItems>[0]);
    const awai = rows.find((r) => r.facilityNm === '安威川ダム');
    expect(awai).toBeDefined();
    expect(awai?.storageVolumeM3).toBeGreaterThan(0);
  });

  it('converts storageRate to 0-1 fraction', () => {
    const rows = parseOsakaItems(fixture as Parameters<typeof parseOsakaItems>[0]);
    for (const r of rows) {
      if (r.storageRate != null) {
        expect(r.storageRate).toBeGreaterThanOrEqual(0);
        expect(r.storageRate).toBeLessThanOrEqual(1);
      }
    }
  });

  it('uses displayDt for observedAt', () => {
    const rows = parseOsakaItems(fixture as Parameters<typeof parseOsakaItems>[0]);
    expect(rows[0]?.observedAt).toBeInstanceOf(Date);
  });
});

describe('chooseMaster', () => {
  const masters = [
    { id: 10171n, name: '狭山池（元）' },
    { id: 10172n, name: '狭山池（再）' },
    { id: 10175n, name: '安威川' },
    { id: 10176n, name: '箕面川' },
  ];

  it('prefers （再）over （元）for same stem', () => {
    // 狭山池ダム → stem=狭山池 → should match 狭山池（再）not 狭山池（元）
    expect(chooseMaster('狭山池', masters)).toBe(10172n);
  });

  it('matches 安威川 exactly', () => {
    expect(chooseMaster('安威川', masters)).toBe(10175n);
  });

  it('matches 箕面川 exactly', () => {
    expect(chooseMaster('箕面川', masters)).toBe(10176n);
  });

  it('returns null for no match', () => {
    expect(chooseMaster('存在しない', masters)).toBeNull();
  });
});
