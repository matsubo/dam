import { describe, expect, test } from 'bun:test';
import { FAQ } from './faq.ts';

describe('FAQ', () => {
  test('ids are unique', () => {
    const ids = FAQ.map((f) => f.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  test('anchors linked from other pages exist', () => {
    // /dams/[slug] links #rate-origin, /sources links #source-choice.
    const ids = new Set(FAQ.map((f) => f.id));
    expect(ids.has('rate-origin')).toBe(true);
    expect(ids.has('source-choice')).toBe(true);
  });

  test('every entry has an answer', () => {
    for (const f of FAQ) expect(f.answer.join('').length).toBeGreaterThan(0);
  });
});
