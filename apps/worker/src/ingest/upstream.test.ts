import { afterAll, describe, expect, test } from 'bun:test';
import { userAgent } from '@dam/core/http_client';
import { fixtureUpstream, liveUpstream, UpstreamError } from './upstream.ts';

// 「貯水率」 in Shift_JIS and EUC-JP.
const SJIS = new Uint8Array([0x92, 0x99, 0x90, 0x85, 0x97, 0xa6]);
const EUC = new Uint8Array([0xc3, 0xf9, 0xbf, 0xe5, 0xce, 0xa8]);

let seenAgent: string | null = null;
const server = Bun.serve({
  port: 0,
  async fetch(req) {
    const path = new URL(req.url).pathname;
    seenAgent = req.headers.get('user-agent');
    if (path === '/stall') {
      // Headers now, the body never: the timeout must cover the body.
      return new Response(
        new ReadableStream({
          start(c) {
            c.enqueue(new TextEncoder().encode('x'));
          },
        }),
      );
    }
    if (path === '/gone') return new Response('gone', { status: 404 });
    if (path === '/echo') return new Response(`${req.method} ${await req.text()}`);
    return new Response(SJIS, { headers: { 'last-modified': 'Mon, 26 Oct 2026 01:00:00 GMT' } });
  },
});
afterAll(() => server.stop(true));
const at = (path: string) => `http://localhost:${server.port}${path}`;

describe('the live upstream', () => {
  const up = liveUpstream('test-source');

  test('sends our user agent and returns bytes, headers and decoded text', async () => {
    const res = await up.fetch(at('/sjis'));
    expect(seenAgent).toBe(userAgent());
    expect(res.text('shift_jis')).toBe('貯水率');
    expect(res.headers.get('last-modified')).toBe('Mon, 26 Oct 2026 01:00:00 GMT');
  });

  test('a status outside 2xx throws one error naming the source and URL', async () => {
    const err = await up.fetch(at('/gone')).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(UpstreamError);
    expect((err as Error).message).toBe(`test-source: HTTP 404 for ${at('/gone')}`);
    expect((await up.fetch(at('/gone'), { allow: [404] })).status).toBe(404);
  });

  test('the timeout covers a body that stalls', async () => {
    await expect(up.fetch(at('/stall'), { timeoutMs: 200 })).rejects.toThrow(
      `test-source: timed out after 0.2 s for ${at('/stall')}`,
    );
  });

  test('POST sends the body', async () => {
    const res = await up.fetch(at('/echo'), { method: 'POST', body: '{}' });
    expect(res.text()).toBe('POST {}');
  });
});

describe('the fixture upstream', () => {
  test('serves bytes through the same status rule', async () => {
    const up = fixtureUpstream({
      'https://a/sjis': SJIS,
      'https://a/euc': EUC,
      'https://a/down': { status: 503 },
    });
    expect((await up.fetch('https://a/sjis')).text('shift_jis')).toBe('貯水率');
    expect((await up.fetch('https://a/euc')).text('euc-jp')).toBe('貯水率');
    await expect(up.fetch('https://a/down')).rejects.toThrow('HTTP 503 for https://a/down');
  });

  test('an unknown URL is a test bug, not an upstream failure', async () => {
    const err = await fixtureUpstream({})
      .fetch('https://a/none')
      .catch((e: unknown) => e);
    expect(err).not.toBeInstanceOf(UpstreamError);
    expect((err as Error).message).toBe('no fixture for https://a/none');
  });
});
