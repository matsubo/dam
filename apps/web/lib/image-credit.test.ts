import { describe, expect, test } from 'bun:test';
import { imageCredit } from './image-credit.ts';

describe('imageCredit', () => {
  test('null / undefined / empty → null', () => {
    expect(imageCredit(null)).toBeNull();
    expect(imageCredit(undefined)).toBeNull();
    expect(imageCredit('')).toBeNull();
  });

  test('Damnet wp-content thumbnail → ダム便覧 credit with damnet ID link', () => {
    const c = imageCredit(
      'https://dambinran.damnet.or.jp/wp-content/uploads/2026/02/0699DC0100AO1L.jpg',
    );
    expect(c?.text).toBe('© ダム便覧');
    expect(c?.href).toContain('/dams/japan/0699/');
    expect(c?.license).toContain('撮影者');
  });

  test('Damnet URL without 4-digit prefix falls back to root', () => {
    const c = imageCredit('https://dambinran.damnet.or.jp/wp-content/uploads/2026/02/no-id.jpg');
    expect(c?.text).toBe('© ダム便覧');
    expect(c?.href).toBe('https://dambinran.damnet.or.jp/');
  });

  test('Wikimedia commons thumbnail → resolves to the Commons file page', () => {
    const c = imageCredit(
      'https://upload.wikimedia.org/wikipedia/commons/thumb/a/ab/Test_Dam.jpg/800px-Test_Dam.jpg',
    );
    expect(c?.text).toBe('Photo: Wikimedia');
    expect(c?.license).toContain('CC-BY-SA');
    expect(c?.href).toBe('https://commons.wikimedia.org/wiki/File:Test_Dam.jpg');
  });

  test('Wikimedia full-size (no thumb segment) URL also resolves', () => {
    const c = imageCredit('https://upload.wikimedia.org/wikipedia/commons/a/ab/Foo.png');
    expect(c?.href).toBe('https://commons.wikimedia.org/wiki/File:Foo.png');
  });

  test('Per-language Wikipedia file → links to that language wiki, not Commons', () => {
    const c = imageCredit(
      'https://upload.wikimedia.org/wikipedia/ja/thumb/a/ab/Local.jpg/800px-Local.jpg',
    );
    expect(c?.href).toBe('https://ja.wikipedia.org/wiki/File:Local.jpg');
  });

  test('Wikipedia URL with non-decodable path falls back to commons root', () => {
    // Cannot match the regex → returned href is the Commons root, not null.
    const c = imageCredit('https://ja.wikipedia.org/static/foo.jpg');
    expect(c?.text).toBe('Photo: Wikimedia');
    expect(c?.href).toBe('https://commons.wikimedia.org/');
  });

  test('Unknown host → null (no fake attribution)', () => {
    expect(imageCredit('https://example.com/foo.jpg')).toBeNull();
  });

  test('Malformed URL → null (no throw)', () => {
    expect(imageCredit('not-a-url')).toBeNull();
  });
});
