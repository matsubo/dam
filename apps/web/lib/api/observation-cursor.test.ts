import { describe, expect, test } from 'bun:test';
import { decodeObservationCursor, encodeObservationCursor } from './observation-cursor.ts';

const cursor = {
  observedAt: new Date('2026-09-01T07:00:00.000Z'),
  damId: 8852n,
  sourceId: 'kasenbosai',
};

describe('observation cursor', () => {
  test('round trips through an opaque token', () => {
    const token = encodeObservationCursor(cursor);
    // Opaque to clients: no readable timestamp, URL-safe, no padding.
    expect(token).toMatch(/^[A-Za-z0-9_-]+$/);
    const back = decodeObservationCursor(token);
    expect(back?.observedAt.toISOString()).toBe(cursor.observedAt.toISOString());
    expect(back?.damId).toBe(cursor.damId);
    expect(back?.sourceId).toBe(cursor.sourceId);
  });

  test('returns null for tokens it did not mint', () => {
    expect(decodeObservationCursor('')).toBeNull();
    expect(decodeObservationCursor('not-base64-$$$')).toBeNull();
    expect(decodeObservationCursor(btoa('only|two'))).toBeNull();
    expect(decodeObservationCursor(btoa('nope|1|kasenbosai'))).toBeNull();
    expect(decodeObservationCursor(btoa('2026-09-01T07:00:00Z|abc|kasenbosai'))).toBeNull();
  });
});
