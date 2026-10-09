import { describe, expect, test } from 'bun:test';
import { sql } from './client.ts';
import { connectionOptions, poolReconnectBackoffS } from './client_options.ts';

describe('connectionOptions', () => {
  test('sets statement_timeout when PG_STATEMENT_TIMEOUT_MS is set (web only)', () => {
    expect(connectionOptions({ PG_STATEMENT_TIMEOUT_MS: '30000' })).toEqual({
      statement_timeout: 30000,
    });
  });

  test('leaves the worker and migrations unbounded when it is unset', () => {
    expect(connectionOptions({})).toEqual({});
  });

  test('ignores a value that is not a positive integer', () => {
    expect(connectionOptions({ PG_STATEMENT_TIMEOUT_MS: 'abc' })).toEqual({});
    expect(connectionOptions({ PG_STATEMENT_TIMEOUT_MS: '0' })).toEqual({});
  });
});

describe('shared pool', () => {
  // A backend only frees the memory of its biggest plan when the connection
  // closes; a pool that never closes connections pins that memory forever.
  test('closes idle connections and recycles old ones', () => {
    expect(sql.options.idle_timeout).toBe(30);
    expect(sql.options.max_lifetime).toBe(600);
  });

  // A CNPG switchover refuses connects for ~8 s; postgres.js's defaults (30 s
  // connect timeout, backoff up to 20 s) kept the pool asleep long after.
  test('fails a hung connect after 3 s and reconnects within 1 s', () => {
    expect(sql.options.connect_timeout).toBe(3);
    expect(sql.options.backoff).toBe(poolReconnectBackoffS);
    expect([0, 1, 2, 3, 4, 10].map(poolReconnectBackoffS)).toEqual([0, 0.25, 0.5, 0.75, 1, 1]);
  });
});
