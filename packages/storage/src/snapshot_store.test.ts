import { afterAll, describe, expect, test } from 'bun:test';
import { getSnapshot, putSnapshot, rawSnapshotKey } from './snapshot_store.ts';

const SOURCE = 'kasenbosai';
const TARGET = `test-${Date.now()}`;
const FETCHED = new Date('2026-05-01T05:00:00Z');

afterAll(async () => {
  // best-effort cleanup left to the bucket lifecycle
});

describe('rawSnapshotKey', () => {
  test('encodes UTC time and target id', () => {
    const k = rawSnapshotKey(SOURCE, TARGET, FETCHED, 'xml');
    expect(k).toBe(`raw/${SOURCE}/2026/05/01/05/${TARGET}.xml`);
  });
});

describe('snapshot store round trip', () => {
  test('put then get returns the same bytes', async () => {
    const key = rawSnapshotKey(SOURCE, TARGET, FETCHED, 'xml');
    const body = new TextEncoder().encode('<root>ok</root>');
    await putSnapshot(key, body, 'application/xml');
    const got = await getSnapshot(key);
    expect(new TextDecoder().decode(got)).toBe('<root>ok</root>');
  });
});
