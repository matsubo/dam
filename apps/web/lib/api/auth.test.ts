import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { sql } from '@dam/db/client';
import { issueKey } from '@dam/db/repo/api_keys';
import { authorize } from './auth.ts';

let plaintext: string;

beforeAll(async () => {
  await sql`DELETE FROM api_keys WHERE email = 'auth-test@example.com'`;
  const r = await issueKey({ email: 'auth-test@example.com', label: 'auth-test' });
  plaintext = r.plaintext;
});

afterAll(async () => {
  await sql`DELETE FROM api_keys WHERE email = 'auth-test@example.com'`;
});

function req(headers: Record<string, string> = {}): Request {
  return new Request('http://localhost/api/v1/dams', { headers });
}

describe('authorize (Stripe-style bearer)', () => {
  test('rejects requests with no auth', async () => {
    const r = await authorize(req());
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.status).toBe(401);
  });

  test('rejects unknown bearer', async () => {
    const r = await authorize(req({ authorization: 'Bearer aaaaaaaa_secret' }));
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.status).toBe(401);
  });

  test('accepts a valid Authorization: Bearer header', async () => {
    const r = await authorize(req({ authorization: `Bearer ${plaintext}` }));
    expect(r.ok).toBe(true);
  });

  test('accepts HTTP Basic with key as username (Stripe curl -u)', async () => {
    const basic = Buffer.from(`${plaintext}:`).toString('base64');
    const r = await authorize(req({ authorization: `Basic ${basic}` }));
    expect(r.ok).toBe(true);
  });

  test('accepts the legacy X-API-Key header for backwards compat', async () => {
    const r = await authorize(req({ 'x-api-key': plaintext }));
    expect(r.ok).toBe(true);
  });
});

describe('API_AUTH_BYPASS', () => {
  const saved = { bypass: process.env.API_AUTH_BYPASS, env: process.env.NODE_ENV };
  afterAll(() => {
    process.env.API_AUTH_BYPASS = saved.bypass;
    process.env.NODE_ENV = saved.env;
  });

  test('opens keyed routes outside production (dev server, E2E)', async () => {
    process.env.API_AUTH_BYPASS = '1';
    process.env.NODE_ENV = 'development';
    expect((await authorize(req())).ok).toBe(true);
  });

  test('is ignored in production, so a stray env var cannot open the API', async () => {
    process.env.API_AUTH_BYPASS = '1';
    process.env.NODE_ENV = 'production';
    const r = await authorize(req());
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.status).toBe(401);
  });
});
