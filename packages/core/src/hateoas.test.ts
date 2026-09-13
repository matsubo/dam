import { describe, expect, test } from 'bun:test';
import { buildLinks, type Link } from './hateoas.ts';

describe('buildLinks', () => {
  test('builds self link', () => {
    const links = buildLinks({ self: { href: '/api/v1/dams/yamba' } });
    expect(links.self).toEqual({ href: '/api/v1/dams/yamba' });
  });

  test('templated link is preserved', () => {
    const links = buildLinks({
      observations: { href: '/api/v1/dams/yamba/observations{?from,to}', templated: true },
    });
    expect((links.observations as Link).templated).toBe(true);
  });

  test('omits null values', () => {
    const links = buildLinks({ self: { href: '/x' }, optional: null });
    expect('optional' in links).toBe(false);
  });
});
