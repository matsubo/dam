import { describe, expect, test } from 'bun:test';
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
