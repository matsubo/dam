import { describe, expect, test } from 'bun:test';
import { jsonLd } from './json-ld.ts';

describe('jsonLd', () => {
  test('a scraped name holding </script> cannot close the tag', () => {
    const out = jsonLd({ name: '悪意</script><script>alert(1)</script>' });
    expect(out).not.toContain('</script');
    expect(out).not.toContain('<');
  });

  test('still parses back to the same value', () => {
    const value = { name: 'a<b>&c', n: 1, list: ['</script>'] };
    expect(JSON.parse(jsonLd(value))).toEqual(value);
  });
});
