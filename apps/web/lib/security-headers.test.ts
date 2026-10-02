import { describe, expect, test } from 'bun:test';
import { SECURITY_HEADERS } from './security-headers.ts';

const get = (key: string) => SECURITY_HEADERS.find((h) => h.key === key)?.value;

describe('SECURITY_HEADERS', () => {
  test('pages cannot be framed (clickjacking on /account/keys)', () => {
    expect(get('X-Frame-Options')).toBe('DENY');
    expect(get('Content-Security-Policy')).toBe("frame-ancestors 'none'");
  });

  test('browsers stick to HTTPS and do not sniff types', () => {
    expect(get('Strict-Transport-Security')).toMatch(/max-age=\d{7,}/);
    expect(get('X-Content-Type-Options')).toBe('nosniff');
  });

  test('cross-site referrers carry the origin only', () => {
    expect(get('Referrer-Policy')).toBe('strict-origin-when-cross-origin');
  });
});
