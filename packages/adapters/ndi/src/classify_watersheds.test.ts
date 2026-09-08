import { describe, expect, test } from 'bun:test';
import { classifyWatersheds, renderWatershedKindMigration } from './classify_watersheds.ts';

const CODELIST = new Map<string, string>([
  ['830303', '利根川'],
  ['020036', '堤川'],
  ['010952', '堤川'],
  ['850509', '木曽川'],
  ['260010', '吉野川'],
  ['880807', '吉野川'],
  ['130001', '八ツ瀬川'],
]);

const SECTIONS = new Map<string, ReadonlySet<string>>([
  ['020036', new Set(['3', '4'])],
  ['010952', new Set(['4'])],
  ['260010', new Set(['3'])],
]);

const rows = (...names: [string, string[]][]) =>
  names.map(([name, prefCodes]) => ({ code: `W01-${name}`, name, prefCodes }));

describe('classifyWatersheds', () => {
  test('a 一級 code is first and carries its 水系域コード', () => {
    const [r] = classifyWatersheds(rows(['利根川', ['10', '08']]), CODELIST, SECTIONS);
    expect(r).toMatchObject({ code: 'W01-利根川', ndiCode: '830303', kind: 'first' });
  });

  test('a prefecture system with 二級 sections is second', () => {
    const [r] = classifyWatersheds(rows(['堤川', ['02']]), CODELIST, SECTIONS);
    expect(r).toMatchObject({ ndiCode: '020036', kind: 'second' });
  });

  test('W01 glyph variants still match the codelist', () => {
    const [r] = classifyWatersheds(rows(['木曾川', ['21']]), CODELIST, SECTIONS);
    expect(r).toMatchObject({ ndiCode: '850509', kind: 'first' });
  });

  test('names absent from the codelist stay other with no code', () => {
    const [r] = classifyWatersheds(rows(['集水路', ['42']]), CODELIST, SECTIONS);
    expect(r).toMatchObject({ ndiCode: null, kind: 'other', candidates: [] });
  });

  test('a code with no W05 evidence is other', () => {
    const [r] = classifyWatersheds(rows(['八ッ瀬川', ['13']]), CODELIST, SECTIONS);
    expect(r).toMatchObject({ ndiCode: '130001', kind: 'other' });
  });

  test('same-named systems are disambiguated and all candidates reported', () => {
    const [r] = classifyWatersheds(rows(['吉野川', ['36', '39']]), CODELIST, SECTIONS);
    expect(r).toMatchObject({ ndiCode: '880807', kind: 'first' });
    expect(r?.candidates.map((c) => c.code).sort()).toEqual(['260010', '880807']);
  });

  test('preserves input order and count', () => {
    const out = classifyWatersheds(rows(['堤川', ['02']], ['利根川', ['10']]), CODELIST, SECTIONS);
    expect(out.map((r) => r.code)).toEqual(['W01-堤川', 'W01-利根川']);
  });
});

describe('renderWatershedKindMigration', () => {
  const classified = classifyWatersheds(
    rows(['堤川', ['02']], ["O'Brien", ['13']]),
    CODELIST,
    SECTIONS,
  );

  test('adds the ndi_code column and updates kind + ndi_code by code', () => {
    const sql = renderWatershedKindMigration(classified, 'test note');
    expect(sql).toContain('ALTER TABLE watersheds ADD COLUMN IF NOT EXISTS ndi_code TEXT');
    expect(sql).toContain("('W01-堤川', '020036', 'second')");
    expect(sql).toMatch(/UPDATE watersheds w[\s\S]*WHERE w\.code = v\.code/);
  });

  test('emits NULL for missing codes and escapes quotes', () => {
    const sql = renderWatershedKindMigration(classified, 'test note');
    expect(sql).toContain("('W01-O''Brien', NULL, 'other')");
  });

  test('puts the provenance note in a leading comment', () => {
    const sql = renderWatershedKindMigration(classified, 'test note');
    expect(sql.split('\n')[0]).toMatch(/^-- .*test note/);
  });

  test('with no rows it still adds the column and emits no UPDATE', () => {
    const sql = renderWatershedKindMigration([], 'empty');
    expect(sql).toContain('ADD COLUMN IF NOT EXISTS ndi_code');
    expect(sql).not.toContain('UPDATE');
  });
});
