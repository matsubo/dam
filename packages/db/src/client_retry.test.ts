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
import { sql } from './client.ts';
import { errorCode, withRetry } from './retry.ts';

const url = process.env.DATABASE_URL ?? 'postgres://dam:dam@localhost:5433/dam';

// The second connection that terminates the test client's backend, as a
// switchover's shutdown of the old primary does.
const admin = postgres(url, { max: 1 });
const opened: postgres.Sql[] = [];

/** A wrapped single-connection client whose backend can be found by name. */
function client(app: string) {
  const raw = postgres(url, { max: 1, connection: { application_name: app } });
  opened.push(raw);
  return withRetry(raw, { deadlineMs: 5_000 });
}

/** Terminates the client's backend once, while it runs a pg_sleep statement. */
async function killWhileSleeping(app: string): Promise<void> {
  for (;;) {
    const killed = await admin`
      SELECT pg_terminate_backend(pid) AS ok FROM pg_stat_activity
      WHERE application_name = ${app} AND state = 'active' AND query LIKE '%pg_sleep%'
    `;
    if (killed.length > 0) return;
    // The statement's state lives in the server, so poll it in real time.
    await Bun.sleep(50);
  }
}

let warn: Mock<typeof console.warn>;
beforeEach(() => {
  warn = spyOn(console, 'warn').mockImplementation(() => {});
});
afterEach(() => warn.mockRestore());
afterAll(async () => {
  await Promise.all([admin.end({ timeout: 1 }), ...opened.map((c) => c.end({ timeout: 1 }))]);
});

describe('a backend terminated mid-statement', () => {
  test('a read is retried on a new connection and resolves', async () => {
    const db = client('dam-retry-read');
    await db`SELECT 1`;
    const [rows] = await Promise.all([
      db<{ x: number }[]>`SELECT pg_sleep(1), 1 AS x`,
      killWhileSleeping('dam-retry-read'),
    ]);
    expect(rows.map((r) => r.x)).toEqual([1]);
    // The terminated statement fails with CONNECTION_CLOSED; under Bun the
    // next one on the reconnecting client can still see the 57P01.
    expect(warn).toHaveBeenCalledTimes(1);
    expect(String(warn.mock.calls[0]?.[0])).toMatch(
      /(CONNECTION_CLOSED|57P01): succeeded on attempt/,
    );
  }, 15_000);

  test('.values() is replayed on the retried query', async () => {
    const db = client('dam-retry-values');
    await db`SELECT 1`;
    const [rows] = await Promise.all([
      db`SELECT pg_sleep(1), 1 AS x`.values(),
      killWhileSleeping('dam-retry-values'),
    ]);
    expect(rows.map((r) => r[1])).toEqual([1]);
    expect(warn).toHaveBeenCalledTimes(1);
  }, 15_000);

  // The INSERT may have committed before the connection dropped; running it
  // again could duplicate it, so the error reaches the caller.
  test('a write is not retried', async () => {
    const db = client('dam-retry-write');
    await db`CREATE TEMP TABLE retry_probe (x int)`;
    const [error] = await Promise.all([
      db`INSERT INTO retry_probe SELECT 1 FROM pg_sleep(1)`.catch((e: unknown) => e),
      killWhileSleeping('dam-retry-write'),
    ]);
    // The server sends 57P01 admin_shutdown and closes the socket; postgres.js
    // 3.4.9 reports the close, CONNECTION_CLOSED, rather than the 57P01.
    expect(['57P01', 'CONNECTION_CLOSED']).toContain(errorCode(error) ?? '');
    expect(warn).not.toHaveBeenCalled();
  }, 15_000);
});

describe('the wrapped client behaves like postgres.js', () => {
  test('a nested fragment composes and is not run on its own', async () => {
    const y = 2;
    const rows = await sql<{ x: number }[]>`
      SELECT x FROM (VALUES (1), (2)) AS t (x) WHERE true ${sql`AND x = ${y}`}
    `;
    expect(rows.map((r) => r.x)).toEqual([2]);
  });

  test('sql(obj) and sql(array, ...cols) helpers insert rows', async () => {
    const db = client('dam-retry-helpers');
    await db`CREATE TEMP TABLE retry_helpers (a int, b text)`;
    await db`INSERT INTO retry_helpers ${db({ a: 1, b: 'one' })}`;
    await db`INSERT INTO retry_helpers ${db([{ a: 2, b: 'two' }], 'a', 'b')}`;
    const rows = await db<{ a: number; b: string }[]>`SELECT a, b FROM retry_helpers ORDER BY a`;
    expect(rows.map((r) => [r.a, r.b])).toEqual([
      [1, 'one'],
      [2, 'two'],
    ]);
  });

  test('.values(), sql.unsafe and sql.begin return results', async () => {
    expect([...(await sql`SELECT 1 AS a, 'b' AS b`.values())]).toEqual([[1, 'b']]);
    const unsafe = await sql.unsafe<{ x: number }[]>('SELECT $1::int AS x', [7]);
    expect(unsafe.map((r) => r.x)).toEqual([7]);
    const inTx = await sql.begin((tx) => tx<{ x: number }[]>`SELECT 3 AS x`);
    expect(inTx.map((r) => r.x)).toEqual([3]);
  });

  test('bigint parsing from client.ts still applies', async () => {
    const [row] = await sql<{ n: bigint }[]>`SELECT 9007199254740993::int8 AS n`;
    expect(row?.n).toBe(9007199254740993n);
  });
});
