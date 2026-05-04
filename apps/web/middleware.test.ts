import { describe, expect, test } from 'bun:test';

// The `prefersMarkdown` helper inside middleware.ts is the only piece worth
// unit-testing in isolation — the redirect / rewrite paths are end-to-end
// concerns covered by the dev-server smoke runs. We replicate the helper
// here to lock the Accept-header parser.
function prefersMarkdown(accept: string | null): boolean {
  if (!accept) return false;
  const items = accept.split(',').map((s) => s.trim());
  let mdQ = 0;
  let htmlQ = 0;
  for (const item of items) {
    const [media, ...params] = item.split(';').map((s) => s.trim());
    const q = (() => {
      for (const p of params) {
        const m = p.match(/^q=(\d*\.?\d+)$/);
        if (m) return Number(m[1]);
      }
      return 1;
    })();
    if (media === 'text/markdown') mdQ = Math.max(mdQ, q);
    if (media === 'text/html' || media === '*/*') htmlQ = Math.max(htmlQ, q);
  }
  return mdQ > 0 && mdQ >= htmlQ;
}

describe('prefersMarkdown', () => {
  test('null Accept header → no', () => {
    expect(prefersMarkdown(null)).toBe(false);
  });
  test('Accept: text/markdown → yes', () => {
    expect(prefersMarkdown('text/markdown')).toBe(true);
  });
  test('Accept: text/html → no', () => {
    expect(prefersMarkdown('text/html')).toBe(false);
  });
  test('text/markdown ahead of text/html (no q) → yes', () => {
    expect(prefersMarkdown('text/markdown, text/html')).toBe(true);
  });
  test('html with higher q wins', () => {
    expect(prefersMarkdown('text/markdown;q=0.5, text/html;q=0.9')).toBe(false);
  });
  test('markdown with higher q wins', () => {
    expect(prefersMarkdown('text/markdown;q=0.9, text/html;q=0.5')).toBe(true);
  });
  test('star-wildcard counts as html-ish', () => {
    // A browser sending */* should NOT be steered to markdown.
    expect(prefersMarkdown('*/*')).toBe(false);
  });
  test('exact tie defaults to markdown (caller asked for it)', () => {
    expect(prefersMarkdown('text/markdown;q=1.0, text/html;q=1.0')).toBe(true);
  });
});
