// The upstream port: how a task reads a provider. The ingest run hands every
// scan one (`({ log, upstream }) => …`); tests hand it fixtureUpstream, so a
// scan runs on fixture bytes exactly as it runs live.
//
// One error mode for every provider: a network error, a timeout or a status
// outside 2xx (and outside `allow`) throws `<source>: HTTP <status> for <url>`
// (or `<source>: <reason> for <url>`). What a failure means — the job fails,
// or one entry is unreadable — stays the task's decision.

import { HttpClient, userAgent } from '@dam/core/http_client';

export type Charset = 'utf-8' | 'shift_jis' | 'euc-jp';

export interface UpstreamRequest {
  method?: 'GET' | 'POST';
  body?: string;
  headers?: Record<string, string>;
  /** Default 20 s; covers the body as well as the headers. */
  timeoutMs?: number;
  /** Statuses outside 2xx returned to the task instead of thrown (e.g. 404). */
  allow?: readonly number[];
}

export interface UpstreamResponse {
  readonly url: string;
  readonly status: number;
  readonly headers: Headers;
  readonly bytes: Uint8Array;
  /** The body decoded; UTF-8 (BOM dropped) unless the provider says otherwise. */
  text(charset?: Charset): string;
  json<T>(): T;
}

export interface Upstream {
  fetch(url: string, request?: UpstreamRequest): Promise<UpstreamResponse>;
}

export class UpstreamError extends Error {
  constructor(
    readonly url: string,
    readonly status: number | null,
    message: string,
  ) {
    super(message);
    this.name = 'UpstreamError';
  }
}

export const DEFAULT_TIMEOUT_MS = 20_000;

function respond(
  sourceId: string,
  url: string,
  status: number,
  headers: Headers,
  bytes: Uint8Array,
  allow: readonly number[] = [],
): UpstreamResponse {
  if ((status < 200 || status > 299) && !allow.includes(status)) {
    throw new UpstreamError(url, status, `${sourceId}: HTTP ${status} for ${url}`);
  }
  return {
    url,
    status,
    headers,
    bytes,
    text: (charset = 'utf-8') => new TextDecoder(charset).decode(bytes),
    json: <T>() => JSON.parse(new TextDecoder('utf-8').decode(bytes)) as T,
  };
}

/** The live adapter: one user agent (core's userAgent()), a 20 s default timeout. */
export function liveUpstream(sourceId: string): Upstream {
  const client = new HttpClient({ userAgent: userAgent(), timeoutMs: DEFAULT_TIMEOUT_MS });
  return {
    async fetch(url, request = {}) {
      let res: Awaited<ReturnType<HttpClient['request']>>;
      try {
        res = await client.request(url, {
          ...(request.method === undefined ? {} : { method: request.method }),
          ...(request.body === undefined ? {} : { body: request.body }),
          ...(request.headers === undefined ? {} : { headers: request.headers }),
          ...(request.timeoutMs === undefined ? {} : { timeoutMs: request.timeoutMs }),
        });
      } catch (err) {
        const reason =
          err instanceof Error && err.name === 'AbortError'
            ? `timed out after ${(request.timeoutMs ?? DEFAULT_TIMEOUT_MS) / 1000} s`
            : err instanceof Error
              ? err.message
              : String(err);
        throw new UpstreamError(url, null, `${sourceId}: ${reason} for ${url}`);
      }
      return respond(sourceId, url, res.status, res.headers, res.bodyBytes, request.allow);
    },
  };
}

/**
 * A fixture body: the bytes (or text) served with 200, or a full response.
 * Text is served as UTF-8 unless `charset` says how the provider encodes it.
 */
export type Fixture =
  | string
  | Uint8Array
  | {
      status?: number;
      body?: string | Uint8Array;
      charset?: Charset;
      headers?: Record<string, string>;
    };

const reverse = new Map<Charset, Map<string, number[]>>();

/** `text` in a legacy charset: a reverse of TextDecoder over its double-byte plane. */
function encode(text: string, charset: Charset): Uint8Array {
  if (charset === 'utf-8') return new TextEncoder().encode(text);
  let codes = reverse.get(charset);
  if (!codes) {
    codes = new Map();
    const decoder = new TextDecoder(charset);
    const [hiFrom, hiTo, loFrom, loTo] =
      charset === 'shift_jis' ? [0x81, 0xef, 0x40, 0xfc] : [0xa1, 0xfe, 0xa1, 0xfe];
    for (let hi = hiFrom; hi <= hiTo; hi++) {
      for (let lo = loFrom; lo <= loTo; lo++) {
        const ch = decoder.decode(new Uint8Array([hi, lo]));
        if (ch.length === 1 && ch !== '\uFFFD' && !codes.has(ch)) codes.set(ch, [hi, lo]);
      }
    }
    reverse.set(charset, codes);
  }
  const table = codes;
  return new Uint8Array(
    [...text].flatMap((ch) => {
      if (ch.charCodeAt(0) < 0x80) return [ch.charCodeAt(0)];
      const code = table.get(ch);
      if (!code) throw new Error(`no ${charset} code for ${ch}`);
      return code;
    }),
  );
}

/**
 * The test adapter: serves `routes[url]` (or the function's answer) through
 * the same status rule as the live one. An unknown URL is a test bug, so it
 * throws a plain Error rather than an upstream failure.
 */
export function fixtureUpstream(
  routes:
    | Readonly<Record<string, Fixture>>
    | ((
        url: string,
        request: UpstreamRequest,
      ) => Fixture | undefined | Promise<Fixture | undefined>),
  sourceId = 'fixture',
): Upstream {
  return {
    async fetch(url, request = {}) {
      const fixture = typeof routes === 'function' ? await routes(url, request) : routes[url];
      if (fixture === undefined) throw new Error(`no fixture for ${url}`);
      const full =
        typeof fixture === 'string' || fixture instanceof Uint8Array ? { body: fixture } : fixture;
      const body = full.body ?? '';
      // A plain Uint8Array, as the live adapter returns: a Node Buffer from
      // readFile is a subclass some parsers (unpdf) refuse.
      const bytes =
        typeof body === 'string'
          ? encode(body, full.charset ?? 'utf-8')
          : new Uint8Array(body.buffer, body.byteOffset, body.byteLength);
      return respond(
        sourceId,
        url,
        full.status ?? 200,
        new Headers(full.headers ?? {}),
        bytes,
        request.allow,
      );
    },
  };
}
