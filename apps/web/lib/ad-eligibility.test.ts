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

describe('isAdEligible — 国土数値情報由来のページは不可', () => {
  // W01 feeds the dam master (location / height / capacity / completed year),
  // W05 feeds watersheds.kind, W07 feeds watersheds.boundary. All NOT NULL,
  // so every one of these routes renders NLNI-derived values.
  test.each([
    ['homepage', '/'],
    ['dam list', '/dams'],
    ['dam detail', '/dams/sameura-39-2'],
    ['watershed list', '/watersheds'],
    ['watershed detail', '/watersheds/天竜川'],
    ['map', '/map'],
    ['stats', '/stats'],
    ['search', '/search'],
  ])('%s (%s) earns no ad', (_label, path) => {
    expect(isAdEligible(path)).toBe(false);
  });
});

describe('isAdEligible — allowlisted routes', () => {
  test('every allowlisted route is eligible', () => {
    for (const route of AD_ELIGIBLE_ROUTES) {
      expect(isAdEligible(route)).toBe(true);
    }
  });

  test('the allowlist never contains a dam or watershed route', () => {
    for (const route of AD_ELIGIBLE_ROUTES) {
      expect(route.startsWith('/dams')).toBe(false);
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
