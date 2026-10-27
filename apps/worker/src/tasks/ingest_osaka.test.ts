// Fixture → universe entries, no database: binding and writing belong to the
// ingest run (apps/worker/src/ingest/run.test.ts).

import { describe, expect, it } from 'bun:test';
import fixture from '../../../../tests/fixtures/osaka/choryuryo_2026-06-05.json';
import type { Reading } from '../ingest/types.ts';
import { type OsakaResponse, osakaEntries, parseOsakaTimestamp } from './ingest_osaka';

const entries = () => osakaEntries(fixture as OsakaResponse);

function observation(r: unknown) {
  const reading = r as Reading | undefined;
  if (reading?.state !== 'values') throw new Error('no values');
  const o = reading.observations[0];
  if (!o) throw new Error('no observation');
  return o;
}

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

describe('osakaEntries', () => {
  it('lists typeId=3 dams only, keyed by facilityId', () => {
    const list = entries();
    expect(list.map((e) => [e.key, e.name])).toEqual([
      ['35', '安威川ダム'],
      ['36', '箕面川ダム'],
      ['37', '狭山池ダム'],
    ]);
    expect(list.every((e) => e.pref === '27')).toBe(true);
  });

  it('parses storageData as m³', () => {
    const awai = entries().find((e) => e.name === '安威川ダム');
    expect(observation(awai?.reading).storageVolumeM3).toBe(2_690_000);
  });

  it('converts storageRate to 0-1 fraction', () => {
    for (const e of entries()) {
      const rate = observation(e.reading).storageRate;
      expect(rate).toBeGreaterThanOrEqual(0);
      expect(rate).toBeLessThanOrEqual(1);
    }
  });

  it('uses displayDt for observedAt', () => {
    expect(observation(entries()[0]?.reading).observedAt.toISOString()).toBe(
      '2026-06-04T23:34:00.000Z',
    );
  });

  it('names 狭山池（再）outright, even if its completion year were blank (#79)', () => {
    // 狭山池（再） was completed in 2001, but its row has no ダム便覧 link to
    // refresh the year from; the binding must not depend on it.
    const sayama = entries().find((e) => e.key === '37');
    expect(sayama?.bind).toEqual({ name: '狭山池（再）' });
    expect(entries().find((e) => e.key === '35')?.bind).toBeUndefined();
  });

  it('an unparseable displayDt makes every dam unreadable, not dropped', () => {
    const list = osakaEntries({ ...(fixture as OsakaResponse), displayDt: 'bad' });
    expect(list.map((e) => (e.reading as Reading).state)).toEqual([
      'unreadable',
      'unreadable',
      'unreadable',
    ]);
  });
});
