import { describe, expect, test } from 'bun:test';
import { SOURCES } from './sources.ts';

describe('SOURCES', () => {
  // The sync writes one source_priorities row per declaration; a repeated id
  // would make the last one silently win.
  test('declares each source id once', () => {
    const ids = SOURCES.map((s) => s.id);
    expect(ids.filter((id, i) => ids.indexOf(id) !== i)).toEqual([]);
  });

  // /sources shows these fields for every source. A license nobody has
  // checked is an explicit null (shown as 未確認), never an empty string.
  test('every source has its editorial details', () => {
    const incomplete = SOURCES.filter(
      (s) =>
        !s.details.upstream.trim() ||
        !s.details.cadence.trim() ||
        !s.details.what.trim() ||
        s.details.license === '',
    ).map((s) => s.id);
    expect(incomplete).toEqual([]);
  });

  // Migration 0045 retired the synthetic placeholder from every public
  // surface; declaring it would put it back on /sources and in the gate.
  test('does not declare synthetic', () => {
    expect(SOURCES.some((s) => s.id === 'synthetic')).toBe(false);
  });
});
