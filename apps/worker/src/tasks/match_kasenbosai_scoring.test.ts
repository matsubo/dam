import { describe, expect, test } from 'bun:test';
import { normalizeJaName } from '@dam/core/similarity';
import {
  CROSS_PREF_EXACT_SCORE,
  CROSS_PREF_MAX_DISTANCE_M,
  MATCH_THRESHOLD,
  type MasterBinding,
  pickBest,
  pickStationPerMaster,
  REVIEW_THRESHOLD,
  type ScoreCandidate,
  scoreCandidate,
} from './match_kasenbosai_scoring.ts';

function cand(name: string, distanceM: number, prefCode: string | null): ScoreCandidate {
  return { name, distanceM, prefCode };
}

describe('scoreCandidate — same prefecture', () => {
  test('exact normalised name scores 1.0', () => {
    const s = scoreCandidate(cand('宮ヶ瀬', 120, '14'), normalizeJaName('宮ケ瀬ダム'), '14');
    expect(s.score).toBe(1);
    expect(s.reason).toBe('exact-name');
  });

  test('a plain containment still scores 0.8', () => {
    const s = scoreCandidate(cand('上大須', 300, '21'), normalizeJaName('大須ダム'), '21');
    expect(s.score).toBe(0.8);
    expect(s.reason).toBe('name-contains');
  });

  test('an ordinal only the catalogue carries means it names a different dam', () => {
    // 矢作 ⊂ 矢作第2 — these are two separate structures. Binding the station
    // to the generic parent corrupts whichever row loses the race, so it must
    // fall below the threshold.
    const s = scoreCandidate(cand('矢作', 2678, '23'), normalizeJaName('矢作第２ダム'), '23');
    expect(s.score).toBeLessThan(MATCH_THRESHOLD);
    expect(s.reason).toBe('sibling-name-mismatch');
  });

  test('an ordinal only the master carries is an embankment split, and still binds', () => {
    // 平荘ダム is one reservoir behind three numbered embankments; the master
    // stores 平荘第1/第2/第3 and no plain 平荘 row, so MLIT's single station
    // has nowhere else to go.
    const s = scoreCandidate(cand('平荘第1', 41, '28'), normalizeJaName('平荘ダム'), '28');
    expect(s.score).toBeGreaterThanOrEqual(MATCH_THRESHOLD);
    expect(s.score).toBeLessThan(REVIEW_THRESHOLD); // still queued for review
    expect(s.reason).toBe('name-contains-ordinal');
  });

  test('distance-only under 500 m scores 0.6', () => {
    const s = scoreCandidate(cand('まったく別名', 420, '13'), normalizeJaName('無関係ダム'), '13');
    expect(s.score).toBe(0.6);
  });

  test('distance-only over 500 m scores 0.4', () => {
    const s = scoreCandidate(cand('まったく別名', 4200, '13'), normalizeJaName('無関係ダム'), '13');
    expect(s.score).toBe(0.4);
  });

  test('a null master pref_code is never treated as cross-prefecture', () => {
    const s = scoreCandidate(cand('遠野第2', 50, null), normalizeJaName('遠野第二ダム'), '03');
    expect(s.score).toBe(1);
  });
});

describe('scoreCandidate — cross prefecture', () => {
  test('exact name just over the border binds, but only at review confidence', () => {
    // 奥只見: master row is pref 15 (新潟), MLIT files the station under
    // 福島 (kbPref 701 → JIS 07). Coordinates differ by ~60 m.
    const s = scoreCandidate(cand('奥只見', 60, '15'), normalizeJaName('奥只見ダム'), '07');
    expect(s.score).toBe(CROSS_PREF_EXACT_SCORE);
    expect(s.score).toBeGreaterThanOrEqual(MATCH_THRESHOLD);
    expect(s.score).toBeLessThan(0.8); // still staged for human review
    expect(s.reason).toBe('exact-name-cross-pref');
  });

  test('exact name beyond the distance cap is rejected', () => {
    // 新池 exists 18× nationwide; a far cross-border namesake must not bind.
    const s = scoreCandidate(
      cand('新池', CROSS_PREF_MAX_DISTANCE_M + 1, '30'),
      normalizeJaName('新池'),
      '38',
    );
    expect(s.score).toBe(0);
    expect(s.reason).toContain('cross-pref');
  });

  test('a non-exact cross-prefecture name is always rejected', () => {
    const s = scoreCandidate(cand('上大須', 100, '21'), normalizeJaName('大須ダム'), '24');
    expect(s.score).toBe(0);
    expect(s.reason).toContain('cross-pref');
  });
});

describe('pickBest', () => {
  test('the nearby exact sibling beats the distant partial containment', () => {
    // Regression for the 矢作 collision: MLIT 矢作第２ used to bind to master
    // 矢作 2,678 m away because name-contains (0.8) outranked distance (0.6).
    const best = pickBest(
      [cand('矢作', 2678, '23'), cand('矢作第二', 50, '23')],
      normalizeJaName('矢作第２ダム'),
      '23',
    );
    expect(best?.candidate.name).toBe('矢作第二');
    expect(best?.score).toBe(1);
  });

  test('the same collision for 遠野 resolves to the sibling row', () => {
    const best = pickBest(
      [cand('遠野', 1565, '03'), cand('遠野第2', 40, '03')],
      normalizeJaName('遠野第二ダム'),
      '03',
    );
    expect(best?.candidate.name).toBe('遠野第2');
  });

  test('equal scores are broken by distance, not input order', () => {
    const best = pickBest(
      [cand('新池', 900, '30'), cand('新池', 120, '30')],
      normalizeJaName('新池'),
      '30',
    );
    expect(best?.candidate.distanceM).toBe(120);
  });

  test('returns null for an empty candidate list', () => {
    expect(pickBest([], '奥只見', '07')).toBeNull();
  });

  test('a rejected cross-prefecture candidate never wins', () => {
    const best = pickBest(
      [cand('大須', 80, '24'), cand('上大須', 300, '21')],
      normalizeJaName('大須ダム'),
      '21',
    );
    expect(best?.candidate.name).toBe('上大須');
  });
});

describe('pickStationPerMaster', () => {
  const binding = (id: number | null, score: number, distanceM: number): MasterBinding => ({
    damId: id == null ? null : BigInt(id),
    score,
    distanceM,
  });

  test('the higher-scoring station keeps a contested master', () => {
    // 小瀬川 is a joint 広島県・山口県 dam, so MLIT files a station under each
    // prefecture office. Only one may own external_ids.kasenbosai, and it must
    // be decided by score — not by whichever prefecture file is read last.
    const exact = binding(10719, 1, 203);
    const crossPref = binding(10719, 0.75, 98);
    const winners = pickStationPerMaster([exact, crossPref]);
    expect(winners.has(exact)).toBe(true);
    expect(winners.has(crossPref)).toBe(false);
  });

  test('equal scores are broken by distance', () => {
    // 浄土寺川ダム and its 貯砂ダム both score an exact 1.0 on the same master.
    const near = binding(9725, 1, 53);
    const far = binding(9725, 1, 580);
    const winners = pickStationPerMaster([far, near]);
    expect(winners.has(near)).toBe(true);
    expect(winners.has(far)).toBe(false);
  });

  test('distinct masters all win', () => {
    const a = binding(1, 1, 10);
    const b = binding(2, 0.6, 400);
    expect(pickStationPerMaster([a, b]).size).toBe(2);
  });

  test('unmatched stations are never winners', () => {
    const none = binding(null, 0, 0);
    expect(pickStationPerMaster([none]).size).toBe(0);
  });
});
