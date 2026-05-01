import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { sql } from '@dam/db/client';
import { issueKey, revoke } from '@dam/db/repo/api_keys';
import { authorize } from './auth.ts';

let plaintext: string;
let id: bigint;

beforeAll(async () => {
  await sql`DELETE FROM api_keys WHERE email = 'auth-test@example.com'`;
  const r = await issueKey({ email: 'auth-test@example.com', label: 'auth-test' });
  id = r.id;
  plaintext = r.plaintext;
});

afterAll(async () => {
  await sql`DELETE FROM api_keys WHERE email = 'auth-test@example.com'`;
});

function req(headers: Record<string, string> = {}): Request {
  return new Request('http://localhost/api/v1/dams', { headers });
}

describe('authorize', () => {
  test('rejects requests with no header', async () => {
    const r = await authorize(req());
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.status).toBe(401);
  });

  test('rejects unknown key', async () => {
    const r = await authorize(req({ 'x-api-key': 'zzzzzzzz_secret' }));
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.status).toBe(401);
  });

  test('rejects wrong secret', async () => {
    const r = await authorize(req({ 'x-api-key': `${plaintext.slice(0, 8)}_wrongsecret` }));
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.status).toBe(401);
  });

  test('accepts a valid key and returns rate state', async () => {
    const r = await authorize(req({ 'x-api-key': plaintext }));
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.keyId).toBe(id);
      expect(r.rate.limit).toBe(60);
      expect(r.rate.remaining).toBeGreaterThanOrEqual(0);
    }
  });

  test('blocks when over rate limit', async () => {
    // burn the key down to 0 by issuing 60 lookups
    for (let i = 0; i < 60; i++) await authorize(req({ 'x-api-key': plaintext }));
    const r = await authorize(req({ 'x-api-key': plaintext }));
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.status).toBe(429);
  });

  test('rejects revoked key', async () => {
    await revoke(id);
    const r = await authorize(req({ 'x-api-key': plaintext }));
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.status).toBe(401);
  });
});
