import { describe, expect, test } from 'bun:test';
import { sql } from './client.ts';
import { connectionOptions } from './client_options.ts';

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
});
