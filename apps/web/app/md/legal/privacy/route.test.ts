import { afterAll, describe, expect, test } from 'bun:test';

// The site no longer carries advertising. A leftover NEXT_PUBLIC_ADSENSE_CLIENT
// in a deploy's environment must not bring the advertising clause back.
const ENV_KEY = 'NEXT_PUBLIC_ADSENSE_CLIENT';
const previous = process.env[ENV_KEY];

afterAll(() => {
  if (previous === undefined) delete process.env[ENV_KEY];
  else process.env[ENV_KEY] = previous;
});

describe('GET /md/legal/privacy', () => {
  test('never mentions advertising, even with a stale AdSense env var', async () => {
    process.env[ENV_KEY] = 'ca-pub-1234567890123456';
    const { GET } = await import('./route.ts');
    const body = await GET().text();
    expect(body).not.toContain('AdSense');
    expect(body).not.toContain('advertising');
  });
});
