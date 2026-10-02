// Response headers for every route, applied in next.config.ts headers().
// No script-src CSP: the GTM / GA bootstraps and next/script are inline and
// would need per-request nonces. frame-ancestors alone is safe to send.
export const SECURITY_HEADERS: { key: string; value: string }[] = [
  { key: 'Strict-Transport-Security', value: 'max-age=31536000; includeSubDomains' },
  { key: 'X-Content-Type-Options', value: 'nosniff' },
  { key: 'X-Frame-Options', value: 'DENY' },
  { key: 'Content-Security-Policy', value: "frame-ancestors 'none'" },
  { key: 'Referrer-Policy', value: 'strict-origin-when-cross-origin' },
];
