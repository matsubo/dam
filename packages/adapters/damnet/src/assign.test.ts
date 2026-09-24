import { describe, expect, test } from 'bun:test';
import { assignCaptures, damnetNameKey, type MasterRef } from './assign.ts';

const cap = (damNumber: string, name: string, prefecture = '福島県') => ({
  damNumber,
  name,
  prefecture,
});
const master = (
  id: string,
  name: string,
  damnet: string | null = null,
  prefCode = '07',
): MasterRef => ({
  id,
  name,
  prefCode,
  damnet,
});

describe('damnetNameKey', () => {
  test('keeps the （元）/（再） marker so the two Damnet records stay apart', () => {
    expect(damnetNameKey('千五沢ダム（元）')).toBe('千五沢|元');
    expect(damnetNameKey('千五沢（元）')).toBe('千五沢|元');
    expect(damnetNameKey('千五沢ダム（再）')).toBe('千五沢|再');
  });
  test('folds full-width digits and half-width parens', () => {
    expect(damnetNameKey('尾口第１ダム（元）')).toBe(damnetNameKey('尾口第1(元)'));
  });
  test('any trailing parenthesised qualifier is a marker', () => {
    expect(damnetNameKey('山梨ダム（上）')).toBe('山梨|上');
  });
  test('strips the ダム / 貯水池 / 池 suffix', () => {
    expect(damnetNameKey('道志ダム')).toBe('道志|');
    expect(damnetNameKey('八ッ場貯水池')).toBe('八ッ場|');
    expect(damnetNameKey('香六池')).toBe(damnetNameKey('香六'));
  });
});

describe('assignCaptures', () => {
  test('元/再 pairs bind to the record with the same marker, overriding a swapped stamp', () => {
    const { assignments } = assignCaptures(
      [master('1', '千五沢（元）', '3284'), master('2', '千五沢（再）', '0515')],
      [cap('0515', '千五沢ダム（元）'), cap('3284', '千五沢ダム（再）')],
    );
    const got = Object.fromEntries(assignments.map((a) => [a.masterId, a.capture.damNumber]));
    expect(got).toEqual({ '1': '0515', '2': '3284' });
  });

  test('a lone （再） master never takes the （元） record', () => {
    const { assignments } = assignCaptures(
      [master('1', '美田（再）', '1750', '32')],
      [cap('1750', '美田ダム（元）', '島根県'), cap('3287', '美田ダム（再）', '島根県')],
    );
    expect(assignments.map((a) => [a.masterId, a.capture.damNumber])).toEqual([['1', '3287']]);
  });

  test('参考掲載 (S-prefixed) records are never assigned', () => {
    const { assignments } = assignCaptures(
      [master('1', '湯西川', 'S003', '09')],
      [cap('S003', '湯西川ダム', '栃木県'), cap('0584', '湯西川ダム', '栃木県')],
    );
    expect(assignments.map((a) => a.capture.damNumber)).toEqual(['0584']);
  });

  test('same-name dams in one prefecture keep their existing stamps', () => {
    const { assignments, ambiguous } = assignCaptures(
      [master('1', '芦別', '0050', '01'), master('2', '芦別', '0042', '01')],
      [cap('0042', '芦別ダム', '北海道'), cap('0050', '芦別ダム', '北海道')],
    );
    const got = Object.fromEntries(assignments.map((a) => [a.masterId, a.capture.damNumber]));
    expect(got).toEqual({ '1': '0050', '2': '0042' });
    expect(ambiguous).toEqual([]);
  });

  test('same-name dams without stamps are reported, not guessed', () => {
    const { assignments, ambiguous } = assignCaptures(
      [master('1', '芦別', null, '01'), master('2', '芦別', null, '01')],
      [cap('0042', '芦別ダム', '北海道'), cap('0050', '芦別ダム', '北海道')],
    );
    expect(assignments).toEqual([]);
    expect(ambiguous).toEqual([
      { key: '01|芦別|', masterIds: ['1', '2'], damNumbers: ['0042', '0050'] },
    ]);
  });

  test('one stamped namesake leaves a 1×1 remainder that binds', () => {
    const { assignments } = assignCaptures(
      [master('1', '芦別', '0050', '01'), master('2', '芦別', null, '01')],
      [cap('0042', '芦別ダム', '北海道'), cap('0050', '芦別ダム', '北海道')],
    );
    const got = Object.fromEntries(assignments.map((a) => [a.masterId, a.capture.damNumber]));
    expect(got).toEqual({ '1': '0050', '2': '0042' });
  });

  test('a stamp pointing outside the name group is ignored', () => {
    const { assignments } = assignCaptures(
      [master('1', '芦別', '9999', '01'), master('2', '芦別', null, '01')],
      [cap('0042', '芦別ダム', '北海道'), cap('0050', '芦別ダム', '北海道')],
    );
    expect(assignments).toEqual([]);
  });

  test('prefecture is part of the key', () => {
    const { assignments } = assignCaptures(
      [master('1', '大川', null, '07'), master('2', '大川', null, '37')],
      [cap('0523', '大川ダム', '福島県'), cap('2176', '大川ダム', '香川県')],
    );
    const got = Object.fromEntries(assignments.map((a) => [a.masterId, a.capture.damNumber]));
    expect(got).toEqual({ '1': '0523', '2': '2176' });
  });

  test('unknown prefectures and unmatched names produce no assignment', () => {
    const { assignments } = assignCaptures(
      [master('1', '千五沢（元）')],
      [cap('0001', '千五沢ダム（元）', '不明')],
    );
    expect(assignments).toEqual([]);
  });
});
