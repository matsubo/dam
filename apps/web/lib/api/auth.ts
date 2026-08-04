import {
  hashKey,
  lookupByPrefix,
  recordUsage,
  touchLastUsed,
  usageInLastMinute,
  usageToday,
} from '@dam/db/repo/api_keys';

// Stripe-style bearer-token auth.
//   Authorization: Bearer <key>
// HTTP Basic auth with the key as the username (and empty password) is also
// accepted, matching Stripe's CLI / curl ergonomics — `curl -u sk_test_...:`.
//
// The legacy `X-API-Key: <key>` header is still honoured so existing clients
// keep working during a transition period.

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

function extractKey(req: Request): string | null {
  // 1. Authorization: Bearer <key>
  const auth = req.headers.get('authorization');
  if (auth) {
    const m = /^Bearer\s+(.+)$/i.exec(auth);
    if (m) return m[1]?.trim() ?? '';
    // 2. Basic auth with key as the username (Stripe-style `curl -u key:`)
    const basic = /^Basic\s+(.+)$/i.exec(auth);
    if (basic) {
      try {
        const decoded = atob(basic[1] ?? '');
        const colon = decoded.indexOf(':');
        return colon >= 0 ? decoded.slice(0, colon) : decoded;
      } catch {
        return null;
      }
    }
  }
  // 3. Legacy X-API-Key header — kept for backwards compatibility.
  return req.headers.get('x-api-key');
}

export async function authorize(req: Request): Promise<AuthResult> {
  if (ADMIN_BYPASS()) {
    return {
      ok: true,
      keyId: 0n,
      rate: { limit: 1_000_000, remaining: 1_000_000, resetAt: 0 },
    };
  }
  const key = extractKey(req);
  if (!key || !key.includes('_')) {
    return { ok: false, status: 401, reason: 'Missing Authorization: Bearer key' };
  }
  const prefix = key.slice(0, 8);
  const row = await lookupByPrefix(prefix);
  if (!row || !row.active) return { ok: false, status: 401, reason: 'Invalid key' };
  if (!timingSafeEqual(row.hash, hashKey(key))) {
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

export function makeUnauthorized(auth: Exclude<AuthResult, { ok: true }>): Response {
  const headers: Record<string, string> = { 'content-type': 'application/problem+json' };
  if (auth.rate) Object.assign(headers, rateLimitHeaders(auth.rate));
  if (auth.status === 401) {
    // RFC 6750 — bearer-token challenge so curl/HTTPie surfaces "WWW-Authenticate"
    headers['WWW-Authenticate'] = 'Bearer realm="dam.teraren.com"';
  }
  if (auth.status === 429 && auth.rate) {
    headers['Retry-After'] = String(
      Math.max(0, Math.ceil((auth.rate.resetAt - Date.now()) / 1000)),
    );
  }
  return new Response(
    JSON.stringify({ type: 'about:blank', title: auth.reason, status: auth.status }),
    { status: auth.status, headers },
  );
}
