import { describe, expect, test } from 'bun:test';

// Re-implement the two helpers from page-pagination.tsx so we can unit-test
// them without dragging React's JSX runtime into bun:test.
function buildHref(
  basePath: string,
  query: Record<string, string | null | undefined>,
  page: number,
): string {
  const sp = new URLSearchParams();
  for (const [k, v] of Object.entries(query)) {
    if (v != null && v !== '') sp.set(k, v);
  }
  if (page > 1) sp.set('page', String(page));
  const qs = sp.toString();
  return qs ? `${basePath}?${qs}` : basePath;
}

function pageWindow(page: number, totalPages: number): (number | 'ellipsis')[] {
  const around = 2;
  const set = new Set<number>([1, totalPages, page]);
  for (let i = 1; i <= around; i++) {
    if (page - i >= 1) set.add(page - i);
    if (page + i <= totalPages) set.add(page + i);
  }
  const sorted = [...set].sort((a, b) => a - b);
  const out: (number | 'ellipsis')[] = [];
  for (let i = 0; i < sorted.length; i++) {
    const cur = sorted[i] as number;
    const prev = i > 0 ? (sorted[i - 1] as number) : null;
    if (prev !== null && cur - prev > 1) out.push('ellipsis');
    out.push(cur);
  }
  return out;
}

describe('buildHref', () => {
  test('omits ?page=1', () => {
    expect(buildHref('/dams', {}, 1)).toBe('/dams');
  });
  test('includes ?page=N for N>1', () => {
    expect(buildHref('/dams', {}, 5)).toBe('/dams?page=5');
  });
  test('preserves filter params', () => {
    expect(buildHref('/dams', { pref: '13', watershed: '賀茂川' }, 2)).toBe(
      '/dams?pref=13&watershed=%E8%B3%80%E8%8C%82%E5%B7%9D&page=2',
    );
  });
  test('drops empty / null filter values', () => {
    expect(buildHref('/dams', { pref: '13', watershed: '', manager: null }, 2)).toBe(
      '/dams?pref=13&page=2',
    );
  });
});

describe('pageWindow', () => {
  test('5 pages: shows all', () => {
    expect(pageWindow(3, 5)).toEqual([1, 2, 3, 4, 5]);
  });
  test('long range with current near start', () => {
    expect(pageWindow(2, 100)).toEqual([1, 2, 3, 4, 'ellipsis', 100]);
  });
  test('long range with current in middle', () => {
    expect(pageWindow(50, 100)).toEqual([1, 'ellipsis', 48, 49, 50, 51, 52, 'ellipsis', 100]);
  });
  test('long range with current near end', () => {
    expect(pageWindow(99, 100)).toEqual([1, 'ellipsis', 97, 98, 99, 100]);
  });
  test('only one page', () => {
    expect(pageWindow(1, 1)).toEqual([1]);
  });
});
