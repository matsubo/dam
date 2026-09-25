import { describe, expect, test } from 'bun:test';
import { readOpenApiSpec } from './export_openapi.ts';

const MANIFEST = new URL('../../../package.json', import.meta.url);

describe('readOpenApiSpec', () => {
  test('returns the served OpenAPI document, versioned from package.json', async () => {
    const manifest = await Bun.file(MANIFEST).json();
    const spec = await readOpenApiSpec();
    expect(spec.openapi).toBe('3.1.0');
    expect(spec.info.version).toBe(manifest.version);
  });
});
