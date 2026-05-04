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

  test('Wikipedia thumbnail → CC-BY-SA credit', () => {
    const c = imageCredit(
      'https://upload.wikimedia.org/wikipedia/commons/thumb/a/ab/Test.jpg/800px-Test.jpg',
    );
    expect(c?.text).toBe('Photo: Wikipedia');
    expect(c?.license).toContain('CC-BY-SA');
    expect(c?.href).toContain('commons.wikimedia.org');
  });

  test('ja.wikipedia.org page-image thumbnail → CC-BY-SA credit', () => {
    const c = imageCredit('https://ja.wikipedia.org/static/foo.jpg');
    expect(c?.text).toBe('Photo: Wikipedia');
  });

  test('Unknown host → null (no fake attribution)', () => {
    expect(imageCredit('https://example.com/foo.jpg')).toBeNull();
  });

  test('Malformed URL → null (no throw)', () => {
    expect(imageCredit('not-a-url')).toBeNull();
  });
});
