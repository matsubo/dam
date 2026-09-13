import { describe, expect, test } from 'bun:test';
import { APP_VERSION } from './version.ts';

// APP_VERSION is the single source of truth for the publicly-visible version
// (footer, /roadmap, OpenAPI `info.version`), but the root package.json has to
// carry the same number so tooling that only reads the manifest agrees with the
// running site. Nothing derives one from the other — this test is the guard
// that keeps the two literals from drifting apart.
const MANIFEST = new URL('../../../package.json', import.meta.url);

describe('APP_VERSION', () => {
  test('is a semver triple', () => {
    expect(APP_VERSION).toMatch(/^\d+\.\d+\.\d+$/);
  });

  test('matches the version declared in the root package.json', async () => {
    const manifest = await Bun.file(MANIFEST).json();
    expect(manifest.version).toBe(APP_VERSION);
  });
});
