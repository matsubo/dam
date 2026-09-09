import { afterEach, describe, expect, test } from 'bun:test';
import { GET } from './route.ts';

const ENV_KEY = 'NEXT_PUBLIC_ADSENSE_CLIENT';
const original = process.env[ENV_KEY];

function setClient(value: string | undefined): void {
  if (value === undefined) delete process.env[ENV_KEY];
  else process.env[ENV_KEY] = value;
}

afterEach(() => {
  setClient(original);
});

describe('GET /ads.txt — opted out', () => {
  test('404s when no AdSense client is configured', async () => {
    setClient(undefined);
    const res = GET();
    expect(res.status).toBe(404);
    // An *empty* ads.txt would tell buyers nobody may sell this inventory,
    // which is worse than serving none at all.
    expect(await res.text()).not.toBe('');
  });

  test('404s when the client id is blank', async () => {
    setClient('');
    expect(GET().status).toBe(404);
  });
});

describe('GET /ads.txt — opted in', () => {
  test('emits the Google authorisation line with the ca- prefix stripped', async () => {
    setClient('ca-pub-1234567890123456');
    const res = GET();
    expect(res.status).toBe(200);
    expect(await res.text()).toBe('google.com, pub-1234567890123456, DIRECT, f08c47fec0942fa0\n');
  });

  test('accepts an id that already lacks the ca- prefix', async () => {
    setClient('pub-1234567890123456');
    expect(await GET().text()).toBe('google.com, pub-1234567890123456, DIRECT, f08c47fec0942fa0\n');
  });

  test('strips only a leading ca-, never one inside the id', async () => {
    setClient('ca-pub-ca-9');
    expect(await GET().text()).toBe('google.com, pub-ca-9, DIRECT, f08c47fec0942fa0\n');
  });

  test('serves plain text so crawlers parse it', async () => {
    setClient('ca-pub-1234567890123456');
    expect(GET().headers.get('content-type')).toBe('text/plain; charset=utf-8');
  });
});
