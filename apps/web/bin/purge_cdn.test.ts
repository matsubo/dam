import { describe, expect, test } from 'bun:test';
import { purgeCdn } from './purge_cdn.ts';

type Call = { url: string; init: RequestInit };

function fakeFetch(body: unknown, status = 200): { calls: Call[]; fetch: typeof fetch } {
  const calls: Call[] = [];
  const fn = (async (url: string, init: RequestInit) => {
    calls.push({ url, init });
    return new Response(JSON.stringify(body), { status });
  }) as unknown as typeof fetch;
  return { calls, fetch: fn };
}

describe('purgeCdn', () => {
  test("purges only the site's hostname with the bearer token", async () => {
    const { calls, fetch } = fakeFetch({ success: true });
    const result = await purgeCdn({ zoneId: 'z1', token: 't1', host: 'dam.teraren.com' }, fetch);
    expect(result).toBe('purged');
    expect(calls).toHaveLength(1);
    expect(calls[0]?.url).toBe('https://api.cloudflare.com/client/v4/zones/z1/purge_cache');
    expect(calls[0]?.init.method).toBe('POST');
    expect(new Headers(calls[0]?.init.headers).get('authorization')).toBe('Bearer t1');
    // The zone (teraren.com) is shared with other sites; never purge_everything.
    expect(JSON.parse(String(calls[0]?.init.body))).toEqual({ hosts: ['dam.teraren.com'] });
  });

  test('skips without calling Cloudflare when credentials are missing', async () => {
    const { calls, fetch } = fakeFetch({ success: true });
    expect(await purgeCdn({ zoneId: undefined, token: 't1', host: 'dam.teraren.com' }, fetch)).toBe(
      'skipped',
    );
    expect(await purgeCdn({ zoneId: 'z1', token: '', host: 'dam.teraren.com' }, fetch)).toBe(
      'skipped',
    );
    expect(calls).toHaveLength(0);
  });

  test('throws with the Cloudflare error when the purge is rejected', async () => {
    const { fetch } = fakeFetch(
      { success: false, errors: [{ code: 10000, message: 'Authentication error' }] },
      403,
    );
    await expect(
      purgeCdn({ zoneId: 'z1', token: 'bad', host: 'dam.teraren.com' }, fetch),
    ).rejects.toThrow('Authentication error');
  });
});
