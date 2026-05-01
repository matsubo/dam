import { describe, expect, test } from 'bun:test';
import { scoreCandidate } from './score.ts';

describe('scoreCandidate', () => {
  test('weights name 0.5, location 0.4, manager 0.1', () => {
    const s = scoreCandidate({
      nameSim: 1,
      distanceM: 0,
      managerMatch: true,
    });
    expect(s).toBeCloseTo(1.0, 5);
  });

  test('zero everywhere is zero', () => {
    expect(scoreCandidate({ nameSim: 0, distanceM: 1_000_000, managerMatch: false })).toBe(0);
  });

  test('partial', () => {
    const s = scoreCandidate({ nameSim: 0.8, distanceM: 250, managerMatch: false });
    // name: 0.8*0.5 = 0.4
    // location: max(0, 1 - 250/500) * 0.4 = 0.5 * 0.4 = 0.2
    // manager: 0
    expect(s).toBeCloseTo(0.6, 5);
  });
});
