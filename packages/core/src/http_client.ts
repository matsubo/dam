export interface HttpClientOptions {
  userAgent: string;
  minIntervalMs?: number;
  maxRetries?: number;
  backoffBaseMs?: number;
  timeoutMs?: number;
}

export interface GetOptions {
  ifNoneMatch?: string | undefined;
  headers?: Record<string, string>;
}

export interface HttpResponse {
  status: number;
  bodyText: string;
  bodyBytes: Uint8Array;
  etag?: string | undefined;
  headers: Headers;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export class HttpClient {
  private readonly opts: Required<HttpClientOptions>;
  private lastFetchAt = 0;

  constructor(options: HttpClientOptions) {
    this.opts = {
      minIntervalMs: 0,
      maxRetries: 0,
      backoffBaseMs: 250,
      timeoutMs: 30_000,
      ...options,
    };
  }

  async get(url: string, options: GetOptions = {}): Promise<HttpResponse> {
    await this.throttle();
    const headers: Record<string, string> = {
      'user-agent': this.opts.userAgent,
      ...(options.headers ?? {}),
    };
    if (options.ifNoneMatch) headers['if-none-match'] = options.ifNoneMatch;

    let attempt = 0;
    while (true) {
      try {
        const ctrl = new AbortController();
        const t = setTimeout(() => ctrl.abort(), this.opts.timeoutMs);
        const res = await fetch(url, { headers, signal: ctrl.signal });
        clearTimeout(t);
        if (res.status === 304) {
          return {
            status: 304,
            bodyText: '',
            bodyBytes: new Uint8Array(),
            etag: res.headers.get('etag') ?? undefined,
            headers: res.headers,
          };
        }
        if (res.status >= 500 && attempt < this.opts.maxRetries) {
          attempt++;
          await sleep(this.opts.backoffBaseMs * 2 ** (attempt - 1));
          continue;
        }
        const bytes = new Uint8Array(await res.arrayBuffer());
        return {
          status: res.status,
          bodyBytes: bytes,
          bodyText: new TextDecoder('utf-8').decode(bytes),
          etag: res.headers.get('etag') ?? undefined,
          headers: res.headers,
        };
      } catch (err) {
        if (attempt < this.opts.maxRetries) {
          attempt++;
          await sleep(this.opts.backoffBaseMs * 2 ** (attempt - 1));
          continue;
        }
        throw err;
      }
    }
  }

  private async throttle(): Promise<void> {
    const interval = this.opts.minIntervalMs;
    if (interval <= 0) return;
    const now = Date.now();
    const wait = this.lastFetchAt + interval - now;
    if (wait > 0) await sleep(wait);
    this.lastFetchAt = Date.now();
  }
}
