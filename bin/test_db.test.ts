import { describe, expect, test } from 'bun:test';
import { scratchDatabaseUrl } from './test_db.ts';

const DEV = 'postgres://dam:dam@localhost:5433/dam';

describe('scratchDatabaseUrl', () => {
  test('keeps credentials, host and port, and swaps only the database', () => {
    const url = new URL(scratchDatabaseUrl(DEV, '/work/dam'));
    expect(url.username).toBe('dam');
    expect(url.password).toBe('dam');
    expect(url.host).toBe('localhost:5433');
    expect(url.pathname).toMatch(/^\/dam_test_dam_[0-9a-f]{8}$/);
  });

  test('gives each worktree its own database', () => {
    const a = scratchDatabaseUrl(DEV, '/work/dam');
    const b = scratchDatabaseUrl(DEV, '/work/dam-wt-57');
    expect(a).not.toBe(b);
  });

  test('two worktrees with the same directory name still differ', () => {
    const a = scratchDatabaseUrl(DEV, '/a/dam');
    const b = scratchDatabaseUrl(DEV, '/b/dam');
    expect(a).not.toBe(b);
  });

  test('is stable for the same worktree', () => {
    expect(scratchDatabaseUrl(DEV, '/work/dam')).toBe(scratchDatabaseUrl(DEV, '/work/dam'));
  });

  test('yields a plain identifier within the 63-byte limit', () => {
    const url = new URL(scratchDatabaseUrl(DEV, `/work/${'ダム-Very.Long'.repeat(10)}`));
    const name = url.pathname.slice(1);
    expect(name).toMatch(/^[a-z0-9_]+$/);
    expect(name.length).toBeLessThanOrEqual(63);
  });
});
