import { describe, expect, test } from 'bun:test';
import { markdownSibling, prefersMarkdown } from './proxy.ts';

// The redirect / rewrite paths are end-to-end concerns covered by
// proxy.e2e.test.ts against a running server; these lock the pure helpers.

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

describe('markdownSibling', () => {
  test('home maps to /md/index', () => {
    expect(markdownSibling('/')).toBe('/md/index');
  });
  test('a dam page maps to its /md twin, slug kept as sent', () => {
    expect(markdownSibling('/dams/%E5%AE%AE%E3%83%B6%E7%80%AC')).toBe(
      '/md/dams/%E5%AE%AE%E3%83%B6%E7%80%AC',
    );
  });
  test('pages without a twin stay HTML', () => {
    expect(markdownSibling('/dams')).toBeNull();
    expect(markdownSibling('/dams/x/opengraph-image')).toBeNull();
    expect(markdownSibling('/watersheds/x')).toBeNull();
    expect(markdownSibling('/constructor')).toBeNull();
  });
});
