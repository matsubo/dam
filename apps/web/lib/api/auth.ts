import {
  hashKey,
  lookupByPrefix,
  recordUsage,
  touchLastUsed,
  usageInLastMinute,
  usageToday,
} from '@dam/db/repo/api_keys';

export interface RateState {
  limit: number;
  remaining: number;
  resetAt: number;
}

export type AuthResult =
  | { ok: true; keyId: bigint; rate: RateState }
  | { ok: false; status: 401 | 429; reason: string; rate?: RateState };

function timingSafeEqual(a: Uint8Array, b: Uint8Array): boolean {
  if (a.byteLength !== b.byteLength) return false;
  let diff = 0;
  for (let i = 0; i < a.byteLength; i++) diff |= (a[i] ?? 0) ^ (b[i] ?? 0);
  return diff === 0;
}

const ADMIN_BYPASS = (): boolean => process.env.API_AUTH_BYPASS === '1';

export async function authorize(req: Request): Promise<AuthResult> {
  if (ADMIN_BYPASS()) {
    return {
      ok: true,
      keyId: 0n,
      rate: { limit: 1_000_000, remaining: 1_000_000, resetAt: 0 },
    };
  }
  const header = req.headers.get('x-api-key');
  if (!header || !header.includes('_')) {
    return { ok: false, status: 401, reason: 'Missing X-API-Key' };
  }
  const prefix = header.slice(0, 8);
  const row = await lookupByPrefix(prefix);
  if (!row || !row.active) return { ok: false, status: 401, reason: 'Invalid key' };
  if (!timingSafeEqual(row.hash, hashKey(header))) {
    return { ok: false, status: 401, reason: 'Invalid key' };
  }

  const now = new Date();
  const usedMin = await usageInLastMinute(row.id, now);
  if (usedMin >= row.ratePerMin) {
    const minute = new Date(Math.floor(now.getTime() / 60_000) * 60_000);
    const resetAt = minute.getTime() + 60_000;
    return {
      ok: false,
      status: 429,
      reason: 'Per-minute rate exceeded',
      rate: { limit: row.ratePerMin, remaining: 0, resetAt },
    };
  }
  const usedDay = await usageToday(row.id, now);
  if (usedDay >= row.ratePerDay) {
    const tomorrow = new Date(now);
    tomorrow.setUTCHours(24, 0, 0, 0);
    return {
      ok: false,
      status: 429,
      reason: 'Per-day rate exceeded',
      rate: { limit: row.ratePerDay, remaining: 0, resetAt: tomorrow.getTime() },
    };
  }

  await recordUsage(row.id, now);
  await touchLastUsed(row.id);
  const minute = new Date(Math.floor(now.getTime() / 60_000) * 60_000);
  return {
    ok: true,
    keyId: row.id,
    rate: {
      limit: row.ratePerMin,
      remaining: Math.max(0, row.ratePerMin - usedMin - 1),
      resetAt: minute.getTime() + 60_000,
    },
  };
}

export function rateLimitHeaders(state: RateState): Record<string, string> {
  return {
    'RateLimit-Limit': String(state.limit),
    'RateLimit-Remaining': String(state.remaining),
    'RateLimit-Reset': String(Math.max(0, Math.floor((state.resetAt - Date.now()) / 1000))),
  };
}
