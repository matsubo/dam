import { describe, expect, test } from 'bun:test';
import { flowStatus } from './flow-status.ts';

describe('flowStatus', () => {
  test('both null → null (no data)', () => {
    expect(flowStatus(null, null)).toBeNull();
  });

  test('one side null → null (need both to compare)', () => {
    expect(flowStatus(5, null)).toBeNull();
    expect(flowStatus(null, 5)).toBeNull();
  });

  test('outflow notably exceeds inflow → draining', () => {
    const s = flowStatus(2, 5);
    expect(s?.tone).toBe('drain');
    expect(s?.label).toContain('放流');
  });

  test('inflow notably exceeds outflow → filling', () => {
    const s = flowStatus(8, 2);
    expect(s?.tone).toBe('fill');
    expect(s?.label).toContain('流入');
  });

  test('near balance → balanced', () => {
    const s = flowStatus(5, 5);
    expect(s?.tone).toBe('balanced');
  });

  test('within 15% tolerance counts as balanced', () => {
    expect(flowStatus(10, 11)?.tone).toBe('balanced'); // +10%
    expect(flowStatus(10, 11.6)?.tone).toBe('drain'); // +16%
  });

  test('both zero → balanced (dam idle, not draining)', () => {
    expect(flowStatus(0, 0)?.tone).toBe('balanced');
  });

  test('outflow with zero inflow → draining', () => {
    expect(flowStatus(0, 3)?.tone).toBe('drain');
  });
});
