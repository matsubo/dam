import { describe, expect, test } from 'bun:test';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { readDbfRecords } from './dbf.ts';

const FIXTURE = join(
  import.meta.dir,
  '..',
  '..',
  '..',
  '..',
  'tests/fixtures/ndi/w05_stream_sample.dbf',
);

describe('readDbfRecords', () => {
  test('returns the requested character fields of every record, trimmed', async () => {
    const buf = new Uint8Array(await readFile(FIXTURE));
    const rows = readDbfRecords(buf, ['W05_001', 'W05_003']);
    expect(rows).toHaveLength(5);
    expect(rows[0]).toEqual({ W05_001: '830305', W05_003: '1' });
    expect(rows[2]).toEqual({ W05_001: '140019', W05_003: '3' });
    expect(rows[4]).toEqual({ W05_001: '130001', W05_003: '0' });
  });

  test('skips records flagged as deleted', async () => {
    const buf = new Uint8Array(await readFile(FIXTURE));
    // Header length lives at bytes 8-9 (LE), record length at 10-11 (LE).
    const u16 = (at: number) => (buf[at] ?? 0) | ((buf[at + 1] ?? 0) << 8);
    const headerLen = u16(8);
    const recordLen = u16(10);
    const withDeleted = Uint8Array.from(buf);
    withDeleted[headerLen + recordLen] = 0x2a; // '*' on the second record
    const rows = readDbfRecords(withDeleted, ['W05_001']);
    expect(rows.map((r) => r.W05_001)).toEqual(['830305', '140019', '140019', '130001']);
  });

  test('throws when a requested field does not exist', async () => {
    const buf = new Uint8Array(await readFile(FIXTURE));
    expect(() => readDbfRecords(buf, ['NOPE'])).toThrow(/NOPE/);
  });

  test('throws on a buffer too short to hold a DBF header', () => {
    expect(() => readDbfRecords(new Uint8Array(10), ['W05_001'])).toThrow();
  });
});
