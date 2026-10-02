import { describe, expect, test } from 'bun:test';
import { HttpClient } from './http_client.ts';

function mockServer(handler: (req: Request) => Response | Promise<Response>) {
  const server = Bun.serve({ port: 0, fetch: (req) => handler(req) });
  return {
    url: `http://127.0.0.1:${server.port}`,
    stop: () => server.stop(true),
  };
}

describe('HttpClient', () => {
  test('times out a response whose body stalls after the headers', async () => {
    // Headers arrive at once, then the body never finishes. The timeout used
    // to be cleared as soon as fetch() resolved, so this hung the task.
    const srv = mockServer(
      () =>
        new Response(
          new ReadableStream({
            start(controller) {
              controller.enqueue(new TextEncoder().encode('partial'));
            },
          }),
        ),
    );
    const c = new HttpClient({ userAgent: 'test/1.0', timeoutMs: 200 });
    const t0 = Date.now();
    await expect(c.get(srv.url)).rejects.toThrow();
    srv.stop();
    expect(Date.now() - t0).toBeLessThan(2_000);
  }, 5_000);

  test('respects min interval between requests', async () => {
    let count = 0;
    const srv = mockServer(() => {
      count++;
      return new Response('ok');
    });
    const c = new HttpClient({ minIntervalMs: 200, userAgent: 'test/1.0' });
    const t0 = Date.now();
    await c.get(srv.url);
    await c.get(srv.url);
    const elapsed = Date.now() - t0;
    srv.stop();
    expect(count).toBe(2);
    expect(elapsed).toBeGreaterThanOrEqual(200);
  });

  test('returns 304 with cached body when ETag matches', async () => {
    const srv = mockServer((req) => {
      if (req.headers.get('if-none-match') === '"abc"') {
        return new Response(null, { status: 304 });
      }
      return new Response('hello', { headers: { etag: '"abc"' } });
    });
    const c = new HttpClient({ minIntervalMs: 0, userAgent: 'test/1.0' });
    const r1 = await c.get(srv.url);
    expect(r1.status).toBe(200);
    expect(r1.bodyText).toBe('hello');
    const r2 = await c.get(srv.url, { ifNoneMatch: r1.etag });
    expect(r2.status).toBe(304);
    srv.stop();
  });

  test('retries on 5xx with backoff', async () => {
    let count = 0;
    const srv = mockServer(() => {
      count++;
      if (count < 3) return new Response('boom', { status: 500 });
      return new Response('ok');
    });
    const c = new HttpClient({
      minIntervalMs: 0,
      userAgent: 'test/1.0',
      maxRetries: 3,
      backoffBaseMs: 10,
    });
    const r = await c.get(srv.url);
    srv.stop();
    expect(count).toBe(3);
    expect(r.status).toBe(200);
  });
});
