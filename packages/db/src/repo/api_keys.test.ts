import { afterAll, describe, expect, test } from 'bun:test';
import { sql } from '../client.ts';
import {
  hashKey,
  issueKey,
  lookupByPrefix,
  recordUsage,
  revoke,
  usageInLastMinute,
} from './api_keys.ts';

afterAll(async () => {
  await sql`DELETE FROM api_keys WHERE email = 'test@example.com'`;
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
