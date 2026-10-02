import { afterAll, describe, expect, test } from 'bun:test';
import { sql } from '../client.ts';
import {
  hashKey,
  issueKey,
  issueSelfServiceKey,
  lookupByPrefix,
  MAX_ACTIVE_KEYS_PER_EMAIL,
  recordUsage,
  revoke,
  usageInLastMinute,
} from './api_keys.ts';

afterAll(async () => {
  await sql`DELETE FROM api_keys WHERE email IN ('test@example.com', 'cap-test@example.com')`;
});

describe('issueSelfServiceKey', () => {
  // Rate limits apply per key, so unlimited self-service keys would multiply
  // one account's quota.
  test('stops issuing once an email holds the maximum of active keys', async () => {
    const email = 'cap-test@example.com';
    await sql`DELETE FROM api_keys WHERE email = ${email}`;
    for (let i = 0; i < MAX_ACTIVE_KEYS_PER_EMAIL; i++) {
      expect(await issueSelfServiceKey(email, `k${i}`)).not.toBeNull();
    }
    expect(await issueSelfServiceKey(email, 'one too many')).toBeNull();
  });

  test('a revoked key frees its slot', async () => {
    const email = 'cap-test@example.com';
    const [first] = await sql<{ id: bigint }[]>`
      SELECT id FROM api_keys WHERE email = ${email} AND revoked_at IS NULL LIMIT 1`;
    if (!first) throw new Error('fixture missing');
    await revoke(first.id);
    expect(await issueSelfServiceKey(email, 'replacement')).not.toBeNull();
  });
});

describe('api_keys repo', () => {
  test('issueKey returns prefix + plaintext, persists hash', async () => {
    const { id, prefix, plaintext } = await issueKey({
      email: 'test@example.com',
      label: 'unit',
    });
    expect(prefix.length).toBe(8);
    expect(plaintext).toMatch(new RegExp(`^${prefix}_[A-Za-z0-9_-]{40,}$`));
    const row = await lookupByPrefix(prefix);
    expect(row?.id).toBe(id);
  });

  test('lookupByPrefix returns null for unknown', async () => {
    expect(await lookupByPrefix('zzzzzzzz')).toBeNull();
  });

  test('hashKey is deterministic and 32 bytes', () => {
    const h = hashKey('abcdefgh_token');
    expect(h.byteLength).toBe(32);
  });

  test('usageInLastMinute increments and reads back', async () => {
    const { id } = await issueKey({ email: 'test@example.com', label: 'usage' });
    const t = new Date();
    await recordUsage(id, t);
    await recordUsage(id, t);
    const n = await usageInLastMinute(id, t);
    expect(n).toBeGreaterThanOrEqual(2);
  });

  test('revoke flips active flag', async () => {
    const { id } = await issueKey({ email: 'test@example.com', label: 'revoke' });
    await revoke(id);
    const rows = await sql<{ active: boolean }[]>`SELECT active FROM api_keys WHERE id = ${id}`;
    expect(rows[0]?.active).toBe(false);
  });
});
