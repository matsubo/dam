// Retries queries that fail because no writable primary was reachable, e.g.
// during a CloudNativePG switchover or failover. See client.ts for why.
import { setTimeout as sleep } from 'node:timers/promises';

/** Errors raised before the statement could have had any effect: retried for any statement. */
export const NEVER_SENT_CODES: Record<string, true> = {
  ECONNREFUSED: true,
  ENOTFOUND: true,
  EAI_AGAIN: true,
  EHOSTUNREACH: true,
  ENETUNREACH: true,
  CONNECT_TIMEOUT: true, // postgres.js: no connection within connect_timeout
  '57P03': true, // cannot_connect_now: server starting up / shutting down
  '25006': true, // read_only_sql_transaction: hit a standby or demoted primary
};

/**
 * Errors after which the statement may or may not have run: retried only for
 * read statements. Every SQLSTATE of class 08 (connection_exception) counts too.
 */
export const OUTCOME_UNKNOWN_CODES: Record<string, true> = {
  '57P01': true, // admin_shutdown
  '57P02': true, // crash_shutdown
  CONNECTION_CLOSED: true, // postgres.js; also what a terminated backend surfaces as
  CONNECTION_ENDED: true,
  CONNECTION_DESTROYED: true,
  ECONNRESET: true,
  EPIPE: true,
  ETIMEDOUT: true,
};

export type RetryClass = 'never-sent' | 'outcome-unknown';

export function errorCode(err: unknown): string | undefined {
  return err instanceof Object && 'code' in err && typeof err.code === 'string'
    ? err.code
    : undefined;
}

export function classifyError(err: unknown): RetryClass | null {
  const code = errorCode(err);
  if (code === undefined) return null;
  if (NEVER_SENT_CODES[code] === true) return 'never-sent';
  if (OUTCOME_UNKNOWN_CODES[code] === true || /^08[0-9A-Z]{3}$/.test(code)) {
    return 'outcome-unknown';
  }
  return null;
}

const LEADING_NOISE = /^(?:\s+|--[^\n]*(?:\n|$)|\/\*[\s\S]*?\*\/)*/;
const READ_START = /^(?:select|with|values|table|show)\b/i;
// The write keywords, plus INTO (SELECT INTO creates a table), pg_notify and
// graphile_worker (the admin route enqueues with SELECT add_job). A match
// anywhere disqualifies (FOR UPDATE, a column named "lock", ...): a false
// "write" only costs a retry.
const WRITE_WORD =
  /\b(?:insert|update|delete|merge|call|copy|lock|refresh|nextval|setval|into|pg_notify|graphile_worker)\b|\bpg_advisory/i;

/**
 * A statement is a read when it starts (after whitespace and comments) with
 * SELECT, WITH, VALUES, TABLE or SHOW and contains none of the write words.
 * A SELECT of a user function that writes cannot be told apart; none of this
 * repo's own functions write.
 */
export function isReadStatement(text: string): boolean {
  const body = text.replace(LEADING_NOISE, '');
  return READ_START.test(body) && !WRITE_WORD.test(body);
}

export interface RetryOptions {
  /** Total time budget across attempts, measured from the first attempt. */
  deadlineMs?: number;
}

const DEFAULT_DEADLINE_MS = 20_000;
const FIRST_DELAY_MS = 100;
const MAX_DELAY_MS = 1_000;

const REPLAYED = ['values', 'raw', 'simple'] as const;
// After these the query is streamed, described or already executing on its
// own terms; it is left exactly as postgres.js runs it.
const UNRETRIED = ['forEach', 'cursor', 'describe', 'execute', 'readable', 'writable'] as const;

// The slice of a postgres.js Query this module touches.
interface RawQuery extends Promise<unknown> {
  strings: readonly string[];
  args: unknown[];
}
// The Query methods this module overrides per instance or calls on the prototype.
type QueryMethods = Record<
  (typeof REPLAYED)[number] | (typeof UNRETRIED)[number] | 'then' | 'catch' | 'finally',
  (...args: unknown[]) => unknown
>;
type RawSql = ((...args: unknown[]) => RawQuery) & {
  unsafe: (...args: unknown[]) => RawQuery;
  begin: (...args: unknown[]) => Promise<unknown>;
};

/**
 * Wraps a postgres.js `sql` so awaited tagged-template and `unsafe` queries,
 * and `begin` calls, are re-issued after a retryable connection error. Every
 * other property and call (helpers, fragments, reserve, listen, ...) passes
 * through untouched; `tx` inside `begin` is postgres.js's own.
 */
export function withRetry<T extends object>(sql: T, options: RetryOptions = {}): T {
  // T is postgres.js's Sql, generic over its type map; only these call shapes matter here.
  const raw = sql as unknown as RawSql;
  const deadlineMs = options.deadlineMs ?? DEFAULT_DEADLINE_MS;

  function wrap(query: RawQuery, reissue: () => RawQuery, statement: () => string): RawQuery {
    const proto: QueryMethods = Object.getPrototypeOf(query);
    // Its own methods are replaced below; the prototype keeps the originals.
    const own = query as unknown as QueryMethods;
    const replay: (typeof REPLAYED)[number][] = [];
    let retrying = true;
    let result: Promise<unknown> | undefined;

    const run = () => {
      result ??= retry(
        () => proto.then.call(query) as Promise<unknown>,
        () => {
          const next = reissue();
          for (const m of replay) proto[m].call(next);
          return proto.then.call(next) as Promise<unknown>;
        },
        (cls) => cls === 'never-sent' || isReadStatement(statement()),
        deadlineMs,
        statement,
      );
      return result;
    };

    for (const m of REPLAYED) {
      own[m] = () => {
        replay.push(m);
        proto[m].call(query);
        return query;
      };
    }
    for (const m of UNRETRIED) {
      own[m] = (...args) => {
        retrying = false;
        return proto[m].apply(query, args);
      };
    }
    // Only awaiting runs a query, so a query used as a fragment of another
    // never reaches these and is never executed on its own.
    // biome-ignore lint/suspicious/noThenProperty: overriding the Query's thenable is the mechanism.
    own.then = (onFulfilled, onRejected) =>
      retrying
        ? run().then(onFulfilled as never, onRejected as never)
        : proto.then.call(query, onFulfilled, onRejected);
    own.catch = (onRejected) =>
      retrying ? run().catch(onRejected as never) : proto.catch.call(query, onRejected);
    own.finally = (onFinally) =>
      retrying ? run().finally(onFinally as never) : proto.finally.call(query, onFinally);
    return query;
  }

  function unsafe(...args: unknown[]): RawQuery {
    return wrap(
      raw.unsafe(...args),
      () => raw.unsafe(...args),
      () => String(args[0]),
    );
  }

  // Only the never-sent class: the connection could not be reserved, or a
  // statement hit a read-only server and the transaction rolled back.
  function begin(...args: unknown[]): Promise<unknown> {
    return retry(
      () => raw.begin(...args),
      () => raw.begin(...args),
      (cls) => cls === 'never-sent',
      deadlineMs,
      () => 'BEGIN',
    );
  }

  return new Proxy(sql, {
    apply(_target, thisArg, args: unknown[]) {
      const query = Reflect.apply(raw, thisArg, args);
      const strings = args[0];
      // sql(obj), sql(array, ...cols), sql('identifier'): helpers, not queries.
      const tagged = strings instanceof Object && 'raw' in strings && Array.isArray(strings.raw);
      if (!tagged) return query;
      return wrap(
        query,
        () => Reflect.apply(raw, thisArg, args),
        () => statementText(query, Object.getPrototypeOf(query)),
      );
    },
    get(target, prop) {
      if (prop === 'unsafe') return unsafe;
      if (prop === 'begin') return begin;
      return Reflect.get(target, prop);
    },
  });
}

/** Template text of a query, with the text of nested query fragments inlined. */
function statementText(query: RawQuery, proto: object): string {
  let text = query.strings.join(' ');
  for (const arg of query.args) {
    if (arg instanceof Object && Object.getPrototypeOf(arg) === proto) {
      text += ` ${statementText(arg as RawQuery, proto)}`;
    }
  }
  return text;
}

async function retry<R>(
  first: () => Promise<R>,
  again: () => Promise<R>,
  eligible: (cls: RetryClass) => boolean,
  deadlineMs: number,
  statement: () => string,
): Promise<R> {
  const start = performance.now();
  let delay = FIRST_DELAY_MS;
  let attempts = 1;
  let lastCode: string | undefined;
  let attempt = first();
  for (;;) {
    try {
      const value = await attempt;
      if (attempts > 1) {
        console.warn(
          `[db] ${lastCode}: succeeded on attempt ${attempts}: ${describe(statement())}`,
        );
      }
      return value;
    } catch (err) {
      const cls = classifyError(err);
      const code = errorCode(err);
      if (cls === null || !eligible(cls)) {
        if (attempts > 1) {
          console.warn(
            `[db] ${code}: giving up after ${attempts} attempts: ${describe(statement())}`,
          );
        }
        throw err;
      }
      if (performance.now() - start + delay > deadlineMs) {
        console.warn(
          `[db] ${code}: giving up after ${attempts} attempts (deadline ${deadlineMs} ms): ${describe(statement())}`,
        );
        throw err;
      }
      lastCode = code;
      await sleep(delay);
      delay = Math.min(delay * 2, MAX_DELAY_MS);
      attempts += 1;
      attempt = again();
    }
  }
}

function describe(statement: string): string {
  const text = statement.replace(/\s+/g, ' ').trim();
  return text.length > 80 ? `${text.slice(0, 80)}…` : text;
}
