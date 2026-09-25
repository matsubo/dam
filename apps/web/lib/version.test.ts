import { describe, expect, test } from 'bun:test';
import { APP_VERSION } from './version.ts';

// The root package.json is the only place the version is written; version.ts
// re-exports it. The second test fails if someone reintroduces a literal here.
const MANIFEST = new URL('../../../package.json', import.meta.url);

describe('APP_VERSION', () => {
  test('is a semver triple', () => {
    expect(APP_VERSION).toMatch(/^\d+\.\d+\.\d+$/);
  });

  test('is read from the root package.json', async () => {
    const manifest = await Bun.file(MANIFEST).json();
    expect(APP_VERSION).toBe(manifest.version);
  });
});
