import {
  afterAll,
  afterEach,
  beforeEach,
  describe,
  expect,
  type Mock,
  spyOn,
  test,
} from 'bun:test';
import postgres from 'postgres';
import { classifyError, isReadStatement, withRetry } from './retry.ts';

describe('isReadStatement', () => {
  test('reads start with SELECT, WITH, VALUES, TABLE or SHOW', () => {
    expect(isReadStatement('SELECT 1')).toBe(true);
    expect(isReadStatement('  with x AS (SELECT 1) SELECT * FROM x')).toBe(true);
    expect(isReadStatement('VALUES (1)')).toBe(true);
    expect(isReadStatement('TABLE dams')).toBe(true);
    expect(isReadStatement('show statement_timeout')).toBe(true);
  });

  test('leading comments and whitespace are skipped', () => {
    expect(isReadStatement('-- note\n  /* block\n */ SELECT 1')).toBe(true);
  });

  test('statements that do not start with a read keyword are writes', () => {
    expect(isReadStatement('INSERT INTO t VALUES (1)')).toBe(false);
    expect(isReadStatement('UPDATE t SET x = 1')).toBe(false);
    expect(isReadStatement('BEGIN')).toBe(false);
    expect(isReadStatement('SET LOCAL x = 1')).toBe(false);
    expect(isReadStatement('-- SELECT\nDELETE FROM t')).toBe(false);
  });

  test('a read keyword followed by a write word anywhere is a write', () => {
    expect(isReadStatement('WITH d AS (DELETE FROM t RETURNING *) SELECT * FROM d')).toBe(false);
    expect(isReadStatement('SELECT * FROM t FOR UPDATE')).toBe(false);
    expect(isReadStatement("SELECT nextval('s')")).toBe(false);
    expect(isReadStatement('SELECT pg_advisory_xact_lock(1)')).toBe(false);
    expect(isReadStatement('SELECT * INTO t2 FROM t')).toBe(false);
    expect(isReadStatement("SELECT graphile_worker.add_job('x')")).toBe(false);
    expect(isReadStatement('select 1; refresh materialized view m')).toBe(false);
  });

  test('write words only match whole words', () => {
    expect(isReadStatement('SELECT updated_at, deleted_flag, copy_count FROM t')).toBe(true);
  });
});

describe('classifyError', () => {
  test('errors before the statement reached a writable server are never-sent', () => {
    for (const code of [
      'ECONNREFUSED',
      'ENOTFOUND',
      'EAI_AGAIN',
      'EHOSTUNREACH',
      'ENETUNREACH',
      'CONNECT_TIMEOUT',
      '57P03',
      '25006',
    ]) {
      expect(classifyError({ code })).toBe('never-sent');
    }
  });

  test('errors after the statement may have run are outcome-unknown', () => {
    for (const code of [
      '57P01',
      '57P02',
      '08006',
      '08000',
      'CONNECTION_CLOSED',
      'CONNECTION_ENDED',
      'CONNECTION_DESTROYED',
      'ECONNRESET',
      'EPIPE',
      'ETIMEDOUT',
    ]) {
      expect(classifyError({ code })).toBe('outcome-unknown');
    }
  });

  test('everything else is not retried', () => {
    for (const code of ['42601', '23505', '57014', '40001', 'UNSAFE_TRANSACTION', 'toString']) {
      expect(classifyError({ code })).toBeNull();
    }
    expect(classifyError(new Error('boom'))).toBeNull();
    expect(classifyError(null)).toBeNull();
  });
});

describe('retry against a closed port', () => {
  const opened: postgres.Sql[] = [];
  let warn: Mock<typeof console.warn>;

  // Nothing listens on port 1, so every attempt fails with ECONNREFUSED. A
  // fresh client per test: postgres.js backs off its own reconnects more with
  // each failure until one succeeds, which would eat later tests' deadlines.
  function dead() {
    const raw = postgres('postgres://dam:dam@127.0.0.1:1/dam', { max: 1 });
    opened.push(raw);
    return withRetry(raw, { deadlineMs: 600 });
  }

  beforeEach(() => {
    warn = spyOn(console, 'warn').mockImplementation(() => {});
  });
  afterEach(() => warn.mockRestore());
  afterAll(() => Promise.all(opened.map((c) => c.end({ timeout: 0 }))));

  // Attempts start at ~0, ~130 and ~420 ms (our backoff plus postgres.js's
  // reconnect delay); the next 400 ms backoff would end past 600 ms.
  function attemptsLogged(): number {
    expect(warn).toHaveBeenCalledTimes(1);
    const match = String(warn.mock.calls[0]?.[0]).match(/giving up after (\d+) attempts/);
    return Number(match?.[1]);
  }

  // Errors are caught rather than asserted with expect().rejects: Bun's
  // rejects never calls then(), and a postgres.js query only runs on then().
  test('a read is retried until the deadline, then rejects', async () => {
    const error = await dead()`SELECT 1`.catch((e: unknown) => e);
    expect(error).toMatchObject({ code: 'ECONNREFUSED' });
    expect(attemptsLogged()).toBeGreaterThanOrEqual(2);
  });

  test('an INSERT that never reached the server is retried too', async () => {
    const error = await dead()`INSERT INTO t VALUES (1)`.catch((e: unknown) => e);
    expect(error).toMatchObject({ code: 'ECONNREFUSED' });
    expect(attemptsLogged()).toBeGreaterThanOrEqual(2);
  });

  test('sql.unsafe is retried', async () => {
    const error = await dead()
      .unsafe('DELETE FROM t WHERE x = $1', [1])
      .catch((e: unknown) => e);
    expect(error).toMatchObject({ code: 'ECONNREFUSED' });
    expect(attemptsLogged()).toBeGreaterThanOrEqual(2);
  });

  test('sql.begin is retried when no connection can be reserved', async () => {
    const error = await dead()
      .begin((tx) => tx`SELECT 1`)
      .catch((e: unknown) => e);
    expect(error).toMatchObject({ code: 'ECONNREFUSED' });
    expect(attemptsLogged()).toBeGreaterThanOrEqual(2);
  });
});
