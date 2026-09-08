/**
 * Minimal dBASE III (.dbf) reader — just enough to pull character fields out
 * of the attribute tables that ship inside 国土数値情報 shapefile ZIPs.
 * No geometry, no numeric/date decoding, no memo files.
 */

const HEADER_SIZE = 32;
const FIELD_DESCRIPTOR_SIZE = 32;
const FIELD_TERMINATOR = 0x0d;
const DELETED_FLAG = 0x2a; // '*'

interface DbfField {
  readonly name: string;
  readonly offset: number; // byte offset inside a record (after the deletion flag)
  readonly length: number;
}

interface DbfLayout {
  readonly recordCount: number;
  readonly headerLength: number;
  readonly recordLength: number;
  readonly fields: readonly DbfField[];
}

const ascii = new TextDecoder('latin1');

function readUint16(buf: Uint8Array, at: number): number {
  return (buf[at] ?? 0) | ((buf[at + 1] ?? 0) << 8);
}

function readUint32(buf: Uint8Array, at: number): number {
  return (readUint16(buf, at) | (readUint16(buf, at + 2) << 16)) >>> 0;
}

function readLayout(buf: Uint8Array): DbfLayout {
  if (buf.length < HEADER_SIZE + 1) throw new Error('DBF: buffer too short for a header');
  const recordCount = readUint32(buf, 4);
  const headerLength = readUint16(buf, 8);
  const recordLength = readUint16(buf, 10);
  const fields: DbfField[] = [];
  let offset = 1; // byte 0 of each record is the deletion flag
  for (
    let at = HEADER_SIZE;
    at < headerLength && buf[at] !== FIELD_TERMINATOR;
    at += FIELD_DESCRIPTOR_SIZE
  ) {
    const nameBytes = buf.subarray(at, at + 11);
    const nul = nameBytes.indexOf(0);
    const name = ascii.decode(nul === -1 ? nameBytes : nameBytes.subarray(0, nul));
    const length = buf[at + 16] ?? 0;
    fields.push({ name, offset, length });
    offset += length;
  }
  return { recordCount, headerLength, recordLength, fields };
}

function pickFields(layout: DbfLayout, wanted: readonly string[]): DbfField[] {
  return wanted.map((name) => {
    const field = layout.fields.find((f) => f.name === name);
    if (!field) throw new Error(`DBF: field ${name} not found`);
    return field;
  });
}

/**
 * Read `fields` (character columns) from every live record. Values are
 * decoded as latin1 — fine for the ASCII codes this project reads; do not
 * use it for Shift_JIS name columns.
 */
export function readDbfRecords(
  buf: Uint8Array,
  fields: readonly string[],
): Record<string, string>[] {
  const layout = readLayout(buf);
  const picked = pickFields(layout, fields);
  const rows: Record<string, string>[] = [];
  for (let i = 0; i < layout.recordCount; i++) {
    const start = layout.headerLength + i * layout.recordLength;
    if (start + layout.recordLength > buf.length) break;
    if (buf[start] === DELETED_FLAG) continue;
    const row: Record<string, string> = {};
    for (const f of picked) {
      row[f.name] = ascii
        .decode(buf.subarray(start + f.offset, start + f.offset + f.length))
        .trim();
    }
    rows.push(row);
  }
  return rows;
}
