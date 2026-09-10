import { describe, expect, test } from 'bun:test';
import { AD_ELIGIBLE_ROUTES, isAdEligible } from './ad-eligibility.ts';

// Ad eligibility is a licence boundary, not a layout preference — see
// ad-eligibility.ts for why it is deny-by-default. These tests lock the
// "unknown route earns no ad" property, which is the part that protects us.

describe('isAdEligible — deny by default', () => {
  test('a route nobody listed earns no ad', () => {
    expect(isAdEligible('/something-nobody-thought-about')).toBe(false);
  });

  test('the empty path earns no ad', () => {
    expect(isAdEligible('')).toBe(false);
  });
});

describe('isAdEligible — まだ広告を出さないページ', () => {
  // W01 feeds the dam master (location / height / capacity / completed year),
  // W05 feeds watersheds.kind, W07 feeds watersheds.boundary. All NOT NULL,
  // so every one of these routes renders NLNI-derived values.
  test.each([
    ['homepage', '/'],
    ['dam list', '/dams'],
    ['watershed list', '/watersheds'],
    ['watershed detail', '/watersheds/天竜川'],
    ['map', '/map'],
    ['stats', '/stats'],
    ['search', '/search'],
    ['coverage', '/coverage'],
    ['prefecture', '/prefectures/13'],
    ['source detail', '/sources/ndi'],
    // /sources and /coverage only aggregate NLNI columns rather than printing
    // raw values. Aggregating does not launder the licence — they stay denied.
    ['source list', '/sources'],
    // /contribute counts rows in dams/watersheds. Same call as /coverage:
    // an aggregate over an NLNI-derived table is still a derived work.
    ['contribute', '/contribute'],
  ])('%s (%s) earns no ad', (_label, path) => {
    expect(isAdEligible(path)).toBe(false);
  });
});

describe('isAdEligible — ダム詳細ページ (貯水率ページ)', () => {
  test.each([
    ['早明浦', '/dams/sameura-39-2'],
    ['宇連', '/dams/ure-23'],
    ['slug with digits and hyphens', '/dams/okutadami-15'],
    ['percent-encoded slug', '/dams/%E5%A5%A5%E5%8F%AA%E8%A6%8B'],
  ])('%s (%s) is eligible', (_label, path) => {
    expect(isAdEligible(path)).toBe(true);
  });

  test('a trailing slash still matches', () => {
    expect(isAdEligible('/dams/sameura-39-2/')).toBe(true);
  });

  test('the /dams list itself is NOT a 貯水率 page', () => {
    expect(isAdEligible('/dams')).toBe(false);
  });

  test('nothing deeper than one slug segment matches', () => {
    expect(isAdEligible('/dams/sameura-39-2/history')).toBe(false);
    expect(isAdEligible('/dams/a/b/c')).toBe(false);
  });

  test('an empty slug does not match', () => {
    expect(isAdEligible('/dams/')).toBe(false);
  });

  test('watershed and prefecture detail pages stay out', () => {
    expect(isAdEligible('/watersheds/天竜川')).toBe(false);
    expect(isAdEligible('/prefectures/13')).toBe(false);
  });
});

describe('isAdEligible — allowlisted routes', () => {
  test('every allowlisted route is eligible', () => {
    for (const route of AD_ELIGIBLE_ROUTES) {
      expect(isAdEligible(route)).toBe(true);
    }
  });

  test('the exact-match allowlist never contains a watershed route or the home page', () => {
    for (const route of AD_ELIGIBLE_ROUTES) {
      expect(route.startsWith('/watersheds')).toBe(false);
      expect(route).not.toBe('/');
    }
  });
});

describe('isAdEligible — path normalisation', () => {
  test('a trailing slash does not change the verdict', () => {
    for (const route of AD_ELIGIBLE_ROUTES) {
      expect(isAdEligible(`${route}/`)).toBe(true);
    }
  });

  test('matching is exact, not prefix — a lookalike path earns no ad', () => {
    for (const route of AD_ELIGIBLE_ROUTES) {
      expect(isAdEligible(`${route}-not-really`)).toBe(false);
      expect(isAdEligible(`${route}/deeper`)).toBe(false);
    }
  });

  test('matching is case-sensitive — a differently-cased path earns no ad', () => {
    for (const route of AD_ELIGIBLE_ROUTES) {
      const shouted = route.toUpperCase();
      if (shouted !== route) expect(isAdEligible(shouted)).toBe(false);
    }
  });
});
