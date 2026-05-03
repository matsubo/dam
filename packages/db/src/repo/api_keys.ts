import { createHash, randomBytes } from 'node:crypto';
import { sql } from '../client.ts';

const ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';

function randomFromAlphabet(n: number): string {
  const bytes = randomBytes(n);
  let out = '';
  for (let i = 0; i < n; i++) {
    const b = bytes[i] ?? 0;
    const idx = b % ALPHABET.length;
    out += ALPHABET[idx];
  }
  return out;
}

export function hashKey(plaintext: string): Uint8Array {
  return new Uint8Array(createHash('sha256').update(plaintext).digest());
}

export interface IssueInput {
  email: string;
  label?: string | undefined;
  tier?: 'free' | 'partner' | 'admin' | undefined;
}

export interface IssuedKey {
  id: bigint;
  prefix: string;
  plaintext: string;
}

export async function issueKey(input: IssueInput): Promise<IssuedKey> {
  let prefix = randomFromAlphabet(8);
  // retry on improbable collision
  for (let i = 0; i < 5; i++) {
    const exists = await sql<{ n: number }[]>`SELECT 1 AS n FROM api_keys WHERE prefix = ${prefix}`;
    if (exists.length === 0) break;
    prefix = randomFromAlphabet(8);
  }
  const secret = randomFromAlphabet(40);
  const plaintext = `${prefix}_${secret}`;
  const hash = hashKey(plaintext);
  const rows = await sql<{ id: bigint }[]>`
    INSERT INTO api_keys (prefix, hash, email, label, tier)
    VALUES (${prefix}, ${Buffer.from(hash)}, ${input.email}, ${input.label ?? null}, ${
      input.tier ?? 'free'
    })
    RETURNING id
  `;
  const id = rows[0]?.id;
  if (id === undefined) throw new Error('issueKey returned no row');
  return { id, prefix, plaintext };
}

export interface KeyRow {
  id: bigint;
  prefix: string;
  hash: Uint8Array;
  ratePerMin: number;
  ratePerDay: number;
  active: boolean;
}

export async function lookupByPrefix(prefix: string): Promise<KeyRow | null> {
  const rows = await sql<
    {
      id: bigint;
      prefix: string;
      hash: Buffer;
      rate_per_min: number;
      rate_per_day: number;
      active: boolean;
    }[]
  >`
    SELECT id, prefix, hash, rate_per_min, rate_per_day, active
    FROM api_keys WHERE prefix = ${prefix}
  `;
  const r = rows[0];
  if (!r) return null;
  return {
    id: r.id,
    prefix: r.prefix,
    hash: new Uint8Array(r.hash),
    ratePerMin: r.rate_per_min,
    ratePerDay: r.rate_per_day,
    active: r.active,
  };
}

export async function revoke(id: bigint): Promise<void> {
  await sql`UPDATE api_keys SET active = FALSE, revoked_at = NOW() WHERE id = ${id}`;
}

export interface KeyListItem {
  id: bigint;
  prefix: string;
  label: string | null;
  tier: 'free' | 'partner' | 'admin';
  ratePerMin: number;
  ratePerDay: number;
  active: boolean;
  createdAt: Date;
  lastUsedAt: Date | null;
  revokedAt: Date | null;
}

/** All keys for an email, newest first (revoked included so the UI can grey them). */
export async function listKeysByEmail(email: string): Promise<KeyListItem[]> {
  return sql<KeyListItem[]>`
    SELECT id, prefix, label, tier,
           rate_per_min AS "ratePerMin",
           rate_per_day AS "ratePerDay",
           active,
           created_at   AS "createdAt",
           last_used_at AS "lastUsedAt",
           revoked_at   AS "revokedAt"
    FROM api_keys
    WHERE email = ${email}
    ORDER BY created_at DESC
  `;
}

/** Revoke a key only if it belongs to the given email. Returns rows updated. */
export async function revokeForEmail(id: bigint, email: string): Promise<number> {
  const r = await sql`
    UPDATE api_keys SET active = FALSE, revoked_at = NOW()
    WHERE id = ${id} AND email = ${email} AND revoked_at IS NULL
  `;
  return r.count;
}

export async function touchLastUsed(id: bigint): Promise<void> {
  await sql`UPDATE api_keys SET last_used_at = NOW() WHERE id = ${id}`;
}

export async function recordUsage(id: bigint, at: Date): Promise<void> {
  const minute = new Date(Math.floor(at.getTime() / 60_000) * 60_000);
  await sql`
    INSERT INTO api_key_usage (api_key_id, bucket_minute, count)
    VALUES (${id}, ${minute}, 1)
    ON CONFLICT (api_key_id, bucket_minute)
    DO UPDATE SET count = api_key_usage.count + 1
  `;
}

export async function usageInLastMinute(id: bigint, at: Date): Promise<number> {
  const minute = new Date(Math.floor(at.getTime() / 60_000) * 60_000);
  const rows = await sql<{ count: number }[]>`
    SELECT count FROM api_key_usage WHERE api_key_id = ${id} AND bucket_minute = ${minute}
  `;
  return rows[0]?.count ?? 0;
}

export async function usageToday(id: bigint, at: Date): Promise<number> {
  const dayStart = new Date(at);
  dayStart.setUTCHours(0, 0, 0, 0);
  const rows = await sql<{ total: bigint }[]>`
    SELECT COALESCE(SUM(count), 0)::BIGINT AS total
    FROM api_key_usage
    WHERE api_key_id = ${id} AND bucket_minute >= ${dayStart}
  `;
  return Number(rows[0]?.total ?? 0);
}
